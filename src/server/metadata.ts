import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  MetadataColumn,
  MetadataPage,
  MetadataSchema,
} from "../shared/metadata.js";
import type { SchemaTable } from "../shared/types.js";
import {
  engineMetadata,
  quoteIdentifier,
  quoteLiteral,
  type EngineConnection,
} from "./connectors.js";

const identifier = z.string().min(1).max(200);
const paging = z.object({
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});
const scopedPaging = paging.extend({
  schema: identifier,
  catalog: identifier.optional(),
  table: identifier.optional(),
});
type Kind = "schemas" | "tables" | "columns";
type CursorKey = string | [string, number, string];
const columnKey = z.tuple([
  identifier,
  z.number().int().positive().safe(),
  identifier,
]);
const invalidCursor = () =>
  Object.assign(new Error("Некорректный курсор интроспекции"), {
    statusCode: 400,
  });

function decodeCursor(
  value: string | undefined,
  scope: string,
  kind: Kind,
): CursorKey | undefined {
  if (!value) return;
  try {
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) throw invalidCursor();
    const decoded = z
      .object({
        scope: z.literal(scope),
        after: kind === "columns" ? columnKey : identifier,
      })
      .strict()
      .parse(JSON.parse(buffer.toString("utf8")));
    return decoded.after;
  } catch {
    throw invalidCursor();
  }
}

function page<T>(
  items: T[],
  limit: number,
  scope: string,
  key: (item: T) => CursorKey,
): MetadataPage<T> {
  if (items.length <= limit) return { items };
  const visible = items.slice(0, limit);
  return {
    items: visible,
    nextCursor: Buffer.from(
      JSON.stringify({ scope, after: key(visible[visible.length - 1]!) }),
    ).toString("base64url"),
  };
}

async function readPage(
  c: EngineConnection,
  id: string,
  kind: Kind,
  input: unknown,
  signal: AbortSignal,
) {
  const query: z.infer<typeof paging> & {
    schema?: string;
    table?: string;
    catalog?: string;
  } = kind === "schemas" ? paging.parse(input) : scopedPaging.parse(input);
  const schema = query.schema;
  const table = query.table;
  const catalog =
    c.engine === "trino" ? (query.catalog ?? c.catalog) : undefined;
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        id,
        kind,
        catalog ?? null,
        schema ?? null,
        table ?? null,
      ]),
    )
    .digest("hex");
  const after = decodeCursor(query.cursor, scope, kind);
  const limit = query.limit ?? (kind === "columns" ? 1000 : 500);
  const literal = (value: string) => quoteLiteral(value, c.engine);
  const info = `${catalog ? quoteIdentifier(catalog) + "." : ""}information_schema`;
  const ch = c.engine === "clickhouse";
  let sql: string;
  if (kind === "schemas") {
    const name = ch ? "name" : "schema_name";
    const where = ch
      ? ["name NOT IN ('system','INFORMATION_SCHEMA','information_schema')"]
      : [];
    if (after !== undefined) where.push(`${name}>${literal(after as string)}`);
    sql = ch
      ? "SELECT name FROM system.databases"
      : `SELECT catalog_name,schema_name FROM ${info}.schemata`;
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY ${name} LIMIT ${limit + 1}`;
  } else {
    const where = [`${ch ? "database" : "table_schema"}=${literal(schema!)}`];
    const tableName =
      kind === "tables"
        ? ch
          ? "name"
          : "table_name"
        : ch
          ? "table"
          : "table_name";
    if (table !== undefined) where.push(`${tableName}=${literal(table)}`);
    if (kind === "tables") {
      if (after !== undefined)
        where.push(`${tableName}>${literal(after as string)}`);
      sql = ch
        ? "SELECT name FROM system.tables"
        : `SELECT table_catalog,table_name FROM ${info}.tables`;
      sql += ` WHERE ${where.join(" AND ")} ORDER BY ${tableName} LIMIT ${limit + 1}`;
    } else {
      const position = ch ? "position" : "ordinal_position";
      const columnName = ch ? "name" : "column_name";
      if (after !== undefined) {
        const [lastTable, lastPosition, lastColumn] = after as [
          string,
          number,
          string,
        ];
        where.push(
          `(${tableName}>${literal(lastTable)} OR (${tableName}=${literal(lastTable)} AND ${position}>${lastPosition}) OR (${tableName}=${literal(lastTable)} AND ${position}=${lastPosition} AND ${columnName}>${literal(lastColumn)}))`,
        );
      }
      sql = ch
        ? "SELECT table,name,type,position FROM system.columns"
        : `SELECT table_name,column_name,data_type,ordinal_position FROM ${info}.columns`;
      sql += ` WHERE ${where.join(" AND ")} ORDER BY ${tableName},${position},${columnName} LIMIT ${limit + 1}`;
    }
  }
  const result = await engineMetadata(c, sql, { signal, maxRows: limit + 1 });
  if (kind === "schemas") {
    const items: MetadataSchema[] = result.rows.map((row) =>
      ch
        ? { schema: String(row[0]) }
        : { catalog: String(row[0]), schema: String(row[1]) },
    );
    return page(items, limit, scope, (item) => item.schema);
  }
  if (kind === "tables") {
    const items: SchemaTable[] = result.rows.map((row) =>
      ch
        ? { schema: schema!, name: String(row[0]) }
        : { catalog: String(row[0]), schema: schema!, name: String(row[1]) },
    );
    return page(items, limit, scope, (item) => item.name);
  }
  const items: MetadataColumn[] = result.rows.map((row) => ({
    table: String(row[0]),
    name: String(row[1]),
    type: String(row[2]),
    position: z.number().int().positive().safe().parse(Number(row[3])),
  }));
  return page(items, limit, scope, (item) => [
    item.table,
    item.position,
    item.name,
  ]);
}

export function registerMetadataRoutes(
  app: FastifyInstance,
  options: {
    need: (request: FastifyRequest) => void;
    connection: (id: string) => Promise<EngineConnection>;
  },
) {
  for (const kind of ["schemas", "tables", "columns"] as const) {
    app.get(`/api/connections/:id/metadata/${kind}`, async (req, reply) => {
      options.need(req);
      const id = z.object({ id: z.uuid() }).parse(req.params).id;
      const controller = new AbortController();
      const abort = () => controller.abort();
      const disconnected = () => {
        if (!reply.raw.writableFinished) abort();
      };
      req.raw.once("aborted", abort);
      reply.raw.once("close", disconnected);
      try {
        const connection = await options.connection(id);
        return await readPage(
          connection,
          id,
          kind,
          req.query,
          controller.signal,
        );
      } catch (error) {
        if (error instanceof z.ZodError) throw error;
        if (error instanceof Error && "statusCode" in error) throw error;
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error)),
          { statusCode: 400 },
        );
      } finally {
        req.raw.off("aborted", abort);
        reply.raw.off("close", disconnected);
      }
    });
  }
}
