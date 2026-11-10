import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";
import type { LocalQueryJob } from "./local-query.js";
import { projectFileWorkPath } from "./project-files.js";

export const duckdbScratchBudget = 2 * 1024 ** 3;
export const quoteDuckDBString = (value: string) =>
  "'" + value.replaceAll("'", "''") + "'";
export const foldDuckDBName = (name: string) =>
  name.replace(/[A-Z]/g, (c) => c.toLowerCase());

const csv = [".csv", ".tsv"];
const json = [".json", ".jsonl", ".ndjson"];
const parquet = [".parquet"];
const readers = new Map([
  ["read_csv", csv],
  ["read_csv_auto", csv],
  ["read_json", json],
  ["read_json_auto", json],
  ["read_json_objects", json],
  ["read_json_objects_auto", json],
  ["read_ndjson", json],
  ["read_ndjson_auto", json],
  ["read_ndjson_objects", json],
  ["read_parquet", parquet],
  ["parquet_scan", parquet],
  ["read_xlsx", [".xlsx"]],
]);
const disallowedFunctions = new Set([
  "query",
  "query_table",
  "json_execute_serialized_sql",
  "glob",
  "read_text",
  "read_blob",
  "sniff_csv",
  "checkpoint",
  "force_checkpoint",
  "enable_logging",
  "disable_logging",
  "enable_profiling",
  "disable_profiling",
  "write_log",
  "truncate_duckdb_logs",
  "create_external_resource",
  "register_external_resource",
  "register_external_resource_type",
  "deregister_external_resource",
  "destroy_external_resource",
  "duckdb_external_resources",
]);
const csvWriteOptions = new Set([
  "store_rejects",
  "rejects_table",
  "rejects_scan",
]);

interface SqlNode {
  type?: string;
  class?: string;
  function_name?: string;
  arguments?: { name?: string; expression?: SqlNode }[];
  left?: SqlNode;
  column_names?: string[];
  literal?: { kind?: string; text?: string };
  query_location?: number;
  query_location_length?: number;
  table_name?: string;
  schema_name?: string;
  catalog_name?: string;
  cte_map?: { map?: { key: string; value: { query_node: SqlNode } }[] };
  [property: string]: unknown;
}

interface FileReference {
  path: string;
  start: number;
  end: number;
}

export async function planDuckDBInputs(
  connection: DuckDBConnection,
  sql: string,
) {
  // Parsing a bound string has no SQL side effects. Use DuckDB's own AST and
  // byte ranges so the path validation and engine interpret identical syntax.
  const parsed = await connection.runAndReadAll(
    "SELECT json_serialize_sql(?)",
    [sql],
  );
  const ast = JSON.parse(String(parsed.getRows()[0]?.[0])) as {
    error?: boolean;
    error_type?: string;
    error_message?: string;
    statements?: { node: SqlNode }[];
  };
  if (ast.error && ast.error_type === "parser")
    throw new Error(ast.error_message || "Некорректный SQL");
  if (ast.error || ast.statements?.length !== 1)
    throw new Error("Разрешён один SQL запрос на чтение");

  const bytes = Buffer.from(sql);
  const files: FileReference[] = [];
  const tables = new Set<string>();
  function visit(value: unknown, inherited: ReadonlySet<string>) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inherited);
      return;
    }
    const node = value as SqlNode;
    let scope = inherited;
    if (node.cte_map?.map?.length) {
      const names = new Set(inherited);
      for (const entry of node.cte_map.map) {
        const name = foldDuckDBName(entry.key);
        const query = entry.value.query_node;
        if (query.type === "RECURSIVE_CTE_NODE") {
          // The seed can use a dataset with the same name. The recursive term
          // resolves that name to the working table.
          visit(query.left, names);
          visit(query.right, new Set([...names, name]));
        } else visit(query, names);
        names.add(name);
      }
      scope = names;
    }
    if (node.type === "BASE_TABLE" && node.table_name) {
      const name = foldDuckDBName(node.table_name);
      const schema = foldDuckDBName(node.schema_name || "");
      const catalog = foldDuckDBName(node.catalog_name || "");
      if (
        (!schema || schema === "main") &&
        (!catalog || catalog === "memory") &&
        (schema || catalog || !scope.has(name))
      )
        tables.add(name);
    }
    if (node.class === "FUNCTION" && node.function_name) {
      const name = foldDuckDBName(node.function_name);
      const extensions = readers.get(name);
      if (!extensions) {
        if (
          disallowedFunctions.has(name) ||
          /^(?:read_|parquet_)|_scan$/.test(name)
        )
          throw new Error(`Функция ${name} недоступна в локальном SQL`);
      } else {
        const arg = node.arguments?.[0];
        const expression = arg?.expression;
        const path = expression?.literal?.text;
        const start = expression?.query_location;
        const length = expression?.query_location_length;
        if (
          arg?.name ||
          expression?.type !== "VALUE_CONSTANT" ||
          expression.literal?.kind !== "STRING" ||
          !path ||
          start === undefined ||
          !Number.isSafeInteger(start) ||
          length === undefined ||
          !Number.isSafeInteger(length) ||
          start < 0 ||
          length < 1 ||
          start + length > bytes.length
        )
          throw new Error(
            `Первый аргумент ${name} должен быть строковым путём к файлу проекта`,
          );
        if (
          /^[a-z][a-z0-9+.-]*:/i.test(path) ||
          /[*?\[\]{}~]/.test(path) ||
          !extensions.includes(extname(path).toLowerCase())
        )
          throw new Error(
            `Укажите относительный путь к одному файлу (${extensions.join(", ")})`,
          );
        if (
          extensions === csv &&
          node.arguments?.some(({ name, expression }) => {
            // DuckDB binds "option = value" as a named argument too. Its AST
            // retains the equality expression instead of filling in name.
            const columnNames =
              expression?.type === "COMPARE_EQUAL"
                ? expression.left?.column_names
                : undefined;
            const option =
              name || (columnNames?.length === 1 ? columnNames[0] : "");
            return csvWriteOptions.has(foldDuckDBName(option || ""));
          })
        )
          throw new Error("Запись отклонённых строк отключена в локальном SQL");
        files.push({ path, start, end: start + length });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "cte_map") visit(child, scope);
    }
  }
  visit(ast.statements[0]!.node, new Set());
  return { tables, files };
}

export async function stageDuckDBInputs(
  job: LocalQueryJob,
  files: readonly FileReference[],
) {
  const staged = new Map<string, string>();
  let size = 0;
  const root = await realpath(job.project.projectRoot);
  for (const { path } of files) {
    if (staged.has(path)) continue;
    const workPath = projectFileWorkPath(job.project, path);
    const absolute = join(root, workPath);
    const input = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await input.stat();
      const current = await lstat(
        join(root, projectFileWorkPath(job.project, path)),
      );
      if (
        !before.isFile() ||
        before.dev !== current.dev ||
        before.ino !== current.ino
      )
        throw new Error(`Файл изменён на диске: ${path}`);
      if (before.size > duckdbScratchBudget - size)
        throw new Error("Лимит временных файлов DuckDB — 2 ГиБ");
      const outputPath = join(
        job.scratch,
        `input-${staged.size}${extname(path).toLowerCase()}`,
      );
      const output = await open(outputPath, "wx", 0o600);
      try {
        const buffer = Buffer.allocUnsafe(128 * 1024);
        let copied = 0;
        while (copied < before.size) {
          const { bytesRead } = await input.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - copied),
          );
          if (!bytesRead) break;
          let written = 0;
          while (written < bytesRead)
            written += (
              await output.write(buffer, written, bytesRead - written)
            ).bytesWritten;
          copied += bytesRead;
        }
        const after = await input.stat();
        if (
          copied !== before.size ||
          after.size !== before.size ||
          after.ctimeMs !== before.ctimeMs ||
          after.mtimeMs !== before.mtimeMs
        )
          throw new Error(`Файл изменён во время чтения: ${path}`);
        size += copied;
      } finally {
        await output.close();
      }
      staged.set(path, outputPath);
    } finally {
      await input.close();
    }
  }
  const sql = Buffer.from(job.sql);
  const parts: Buffer[] = [];
  let offset = 0;
  for (const file of [...files].sort((a, b) => a.start - b.start)) {
    if (file.start < offset)
      throw new Error("Неоднозначный путь к файлу в SQL");
    parts.push(
      sql.subarray(offset, file.start),
      Buffer.from(quoteDuckDBString(staged.get(file.path)!)),
    );
    offset = file.end;
  }
  parts.push(sql.subarray(offset));
  return {
    sql: Buffer.concat(parts).toString("utf8"),
    staged,
    spillBudget: duckdbScratchBudget - size,
  };
}
