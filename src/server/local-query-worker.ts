import {
  DuckDBInstance,
  DuckDBTimestampTZValue,
  StatementType,
  type DuckDBConnection,
} from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LocalQueryJob,
  LocalQueryResult,
  LocalQueryWorkerInput,
  LocalQueryWorkerOutput,
} from "./local-query.js";
import {
  foldDuckDBName,
  planDuckDBInputs,
  quoteDuckDBString,
  stageDuckDBInputs,
} from "./duckdb-inputs.js";
import {
  appendDuckDBCell,
  datasetColumnDefinitions,
  queryChunkReaders,
  queryColumns,
  quoteDuckDBIdentifier,
} from "./duckdb-values.js";

const send = (message: LocalQueryWorkerOutput) => process.send!(message);

async function importDataset(
  connection: DuckDBConnection,
  job: LocalQueryJob,
  index: number,
) {
  const { name, columns } = job.datasets[index]!;
  await connection.run(
    `CREATE TABLE ${quoteDuckDBIdentifier(name)} (${datasetColumnDefinitions(columns)})`,
  );
  const appender = await connection.createAppender(name);
  try {
    while (true) {
      const chunk = new Promise<LocalQueryWorkerInput>((resolve) =>
        process.once("message", resolve),
      );
      send({ kind: "chunk", index });
      const message = await chunk;
      if (message.kind !== "chunk")
        throw new Error("Неверный пакет данных DuckDB");
      if (!message.rows) break;
      for (const row of message.rows) {
        if (row.length !== columns.length)
          throw new Error(`Некорректная строка набора данных ${name}`);
        for (const [i, cell] of row.entries())
          appendDuckDBCell(appender, cell, columns[i]!.duckdbType);
        appender.endRow();
      }
      appender.flushSync();
    }
  } finally {
    appender.closeSync();
  }
}

async function run(job: LocalQueryJob): Promise<LocalQueryResult> {
  const spill = join(job.scratch, "spill");
  await mkdir(spill, { mode: 0o700 });
  DuckDBTimestampTZValue.timezoneOffsetInMinutes = 0;
  const instance = await DuckDBInstance.create(":memory:", {
    memory_limit: "512MiB",
    threads: "2",
    temp_directory: spill,
    max_temp_directory_size: "0B",
    autoinstall_known_extensions: "false",
    autoload_known_extensions: "false",
    allow_community_extensions: "false",
    allow_unsigned_extensions: "false",
    allow_persistent_secrets: "false",
    home_directory: job.scratch,
    secret_directory: join(job.scratch, "secrets"),
    enable_external_file_cache: "false",
  });
  const connection = await instance.connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    const { tables, files } = await planDuckDBInputs(connection, job.sql);
    const { sql, staged, spillBudget } = await stageDuckDBInputs(job, files);
    if ([...staged.keys()].some((file) => /\.xlsx$/i.test(file))) {
      const assets = import.meta.filename.endsWith(".ts")
        ? "../../dist/server/native/duckdb/"
        : "../native/duckdb/";
      const extension = fileURLToPath(
        new URL(assets + "excel.duckdb_extension", import.meta.url),
      );
      await connection.run(`LOAD ${quoteDuckDBString(extension)}`);
    }
    await connection.run(`SET max_temp_directory_size = '${spillBudget}B'`);
    await connection.run(
      `SET allowed_paths = [${[...staged.values()].map(quoteDuckDBString).join(", ")}]`,
    );
    await connection.run("SET enable_external_access = false");
    await connection.run("SET lock_configuration = true");

    for (const [index, dataset] of job.datasets.entries()) {
      if (tables.has(foldDuckDBName(dataset.name)))
        await importDataset(connection, job, index);
    }

    const statement = await connection.prepare(sql);
    try {
      if (
        statement.statementType !== StatementType.SELECT ||
        statement.parameterCount
      )
        throw new Error("Разрешён один SQL запрос на чтение без параметров");
      const result = await statement.stream();
      try {
        const types = result.columnTypes();
        const columns = queryColumns(result, types);
        const rows: LocalQueryResult["rows"] = [];
        let byteCount = 0;
        for await (const chunk of result) {
          const readers = queryChunkReaders(chunk, types);
          for (let i = 0; i < chunk.rowCount; i++) {
            const row = readers.map((read) => read(i));
            byteCount += Buffer.byteLength(JSON.stringify(row));
            if (
              rows.length >= job.limits.maxRows ||
              byteCount > job.limits.maxBytes
            )
              throw new Error(
                `Превышен лимит результата: ${job.limits.maxRows} строк / ${job.limits.maxBytes} байт`,
              );
            rows.push(row);
          }
        }
        return { columns, rows, byteCount };
      } finally {
        result.closeSync();
      }
    } finally {
      statement.destroySync();
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

process.once("disconnect", () => process.exit(0));
process.once("message", async (message: LocalQueryWorkerInput) => {
  if (message.kind !== "start") return;
  try {
    send({ kind: "result", result: await run(message.job) });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    send({
      kind: "error",
      message: detail
        .replaceAll(message.job.scratch, "<локальный файл>")
        .slice(0, 16384),
    });
  }
});
