import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createServer,
  request as httpRequest,
  type ClientRequest,
} from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app.js";

const dataDir = mkdtempSync(join(tmpdir(), "miracle-metadata-"));
const statements: string[] = [];
const answers: { names: string[]; rows: unknown[][] }[] = [];
let stalled: (() => void) | undefined;
let cancellations = 0;
const remote = createServer(async (req, res) => {
  let sql = "";
  for await (const part of req) sql += part;
  if (sql.startsWith("KILL")) {
    cancellations++;
    return res.end("");
  }
  statements.push(sql);
  if (stalled) {
    stalled();
    return;
  }
  const answer = answers.shift() ?? { names: ["unexpected"], rows: [] };
  if (req.url?.startsWith("/trino")) {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        columns: answer.names.map((name) => ({ name, type: "varchar" })),
        data: answer.rows,
      }),
    );
  } else {
    res.end(
      [answer.names, answer.names.map(() => "String"), ...answer.rows]
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
  }
});
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = "",
  csrf = "",
  clickhouse = "",
  trino = "";
const request = (
  url: string,
  method: "GET" | "POST" = "GET",
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    payload,
    headers: {
      host: "127.0.0.1:5178",
      cookie,
      "x-csrf-token": csrf,
      origin: "http://127.0.0.1:5178",
    },
  });
beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    remote.once("error", reject);
    remote.listen(0, "127.0.0.1", resolve);
  });
  const address = remote.address();
  if (!address || typeof address === "string")
    throw new Error("No engine port");
  app = await buildApp({
    dataDir,
    serveStatic: false,
    appOrigin: "http://127.0.0.1:5178",
  });
  const session = await request("/api/session");
  cookie = String(session.headers["set-cookie"]).split(";")[0]!;
  csrf = session.json().csrfToken;
  for (const engine of ["clickhouse", "trino"] as const) {
    const response = await request("/api/connections", "POST", {
      name: engine,
      engine,
      url: `http://127.0.0.1:${address.port}/${engine}`,
      username: "reader",
      catalog: engine === "trino" ? 'cat"alog' : undefined,
    });
    expect(response.statusCode, response.body).toBe(201);
    if (engine === "clickhouse") clickhouse = response.json().id;
    else trino = response.json().id;
  }
});
beforeEach(() => {
  statements.length = 0;
  answers.length = 0;
});
afterAll(async () => {
  await app?.close();
  remote.closeAllConnections();
  await new Promise<void>((resolve) => remote.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

it("pages schema discovery without reading all tables", async () => {
  answers.push({ names: ["name"], rows: [["alpha"], ["beta"], ["gamma"]] });
  const first = await request(
    `/api/connections/${clickhouse}/metadata/schemas?limit=2`,
  );
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().items).toEqual([{ schema: "alpha" }, { schema: "beta" }]);
  expect(first.json().nextCursor).toBeTypeOf("string");
  expect(statements[0]).toContain("FROM system.databases");
  expect(statements[0]).toContain(
    "NOT IN ('system','INFORMATION_SCHEMA','information_schema')",
  );
  expect(statements[0]).toContain("LIMIT 3");
  answers.push({ names: ["name"], rows: [["gamma"]] });
  const last = await request(
    `/api/connections/${clickhouse}/metadata/schemas?` +
      new URLSearchParams({ limit: "2", cursor: first.json().nextCursor }),
  );
  expect(last.json()).toEqual({ items: [{ schema: "gamma" }] });
  expect(statements[1]).toContain("name>'beta'");
  expect(statements.join(" ")).not.toContain("system.tables");
});

it("pages tables inside one schema and binds the cursor to that scope", async () => {
  answers.push({ names: ["name"], rows: [["a"], ["b"], ["c"]] });
  const base = `/api/connections/${clickhouse}/metadata/tables?`;
  const first = await request(base + "schema=demo&limit=2");
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().items).toEqual([
    { schema: "demo", name: "a" },
    { schema: "demo", name: "b" },
  ]);
  expect(statements[0]).toContain("database='demo'");
  answers.push({ names: ["name"], rows: [["c"]] });
  const cursor = first.json().nextCursor;
  const second = await request(
    base + new URLSearchParams({ schema: "demo", limit: "2", cursor }),
  );
  expect(second.json()).toEqual({ items: [{ schema: "demo", name: "c" }] });
  expect(statements[1]).toContain("name>'b'");
  const invalid = await request(
    base + new URLSearchParams({ schema: "other", cursor }),
  );
  expect(invalid.statusCode).toBe(400);
  expect(statements).toHaveLength(2);
});

it("pages all columns in a schema without losing columns at a table boundary", async () => {
  answers.push({
    names: ["table", "name", "type", "position"],
    rows: [
      ["first", "id", "UInt64", 1],
      ["first", "value", "String", 2],
      ["second", "id", "UInt64", 1],
    ],
  });
  const base = `/api/connections/${clickhouse}/metadata/columns?`;
  const first = await request(base + "schema=demo&limit=2");
  expect(first.statusCode, first.body).toBe(200);
  expect(first.json().items).toEqual([
    { table: "first", name: "id", type: "UInt64", position: 1 },
    { table: "first", name: "value", type: "String", position: 2 },
  ]);
  answers.push({
    names: ["table", "name", "type", "position"],
    rows: [["second", "id", "UInt64", 1]],
  });
  const second = await request(
    base +
      new URLSearchParams({
        schema: "demo",
        limit: "2",
        cursor: first.json().nextCursor,
      }),
  );
  expect(second.json()).toEqual({
    items: [{ table: "second", name: "id", type: "UInt64", position: 1 }],
  });
  expect(statements[1]).toContain("table>'first'");
  expect(statements[1]).toContain("position>2");
  expect(statements[1]).toContain("ORDER BY table,position,name");
});

it("limits exact table lookups and escapes ClickHouse literals", async () => {
  const schema = "a\\'schema",
    table = "b\\'table";
  answers.push({ names: ["name"], rows: [[table]] });
  const response = await request(
    `/api/connections/${clickhouse}/metadata/tables?` +
      new URLSearchParams({ schema, table }),
  );
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ items: [{ schema, name: table }] });
  expect(statements[0]).toContain("database='a\\\\\\'schema'");
  expect(statements[0]).toContain("name='b\\\\\\'table'");
  answers.push({
    names: ["table", "name", "type", "position"],
    rows: [[table, "n", "Int32", 1]],
  });
  const columns = await request(
    `/api/connections/${clickhouse}/metadata/columns?` +
      new URLSearchParams({ schema, table }),
  );
  expect(columns.statusCode, columns.body).toBe(200);
  expect(statements[1]).toContain("table='b\\\\\\'table'");
});

it("scopes Trino discovery and pages to an escaped catalog and schema", async () => {
  answers.push({
    names: ["catalog_name", "schema_name"],
    rows: [['cat"alog', "public"]],
  });
  const schemas = await request(`/api/connections/${trino}/metadata/schemas`);
  expect(schemas.statusCode, schemas.body).toBe(200);
  expect(schemas.json()).toEqual({
    items: [{ catalog: 'cat"alog', schema: "public" }],
  });
  expect(statements[0]).toContain(
    'FROM "cat""alog".information_schema.schemata',
  );
  answers.push({
    names: ["table_catalog", "table_name"],
    rows: [['other"catalog', "sales"]],
  });
  const query = new URLSearchParams({
    schema: "team's",
    catalog: 'other"catalog',
    table: "sales",
  });
  const tables = await request(
    `/api/connections/${trino}/metadata/tables?${query}`,
  );
  expect(tables.statusCode, tables.body).toBe(200);
  expect(tables.json()).toEqual({
    items: [{ catalog: 'other"catalog', schema: "team's", name: "sales" }],
  });
  expect(statements[1]).toContain(
    'FROM "other""catalog".information_schema.tables',
  );
  expect(statements[1]).toContain("table_schema='team''s'");
  expect(statements[1]).toContain("table_name='sales'");
  answers.push({
    names: ["table_name", "column_name", "data_type", "ordinal_position"],
    rows: [["sales", "amount", "decimal(18,2)", 1]],
  });
  const columns = await request(
    `/api/connections/${trino}/metadata/columns?${query}`,
  );
  expect(columns.json()).toEqual({
    items: [
      { table: "sales", name: "amount", type: "decimal(18,2)", position: 1 },
    ],
  });
  expect(statements[2]).toContain(
    'FROM "other""catalog".information_schema.columns',
  );
  expect(statements[2]).toContain("table_schema='team''s'");
});

it("round-trips cursors for valid long Unicode identifiers", async () => {
  const catalog = "界".repeat(200),
    schema = "文".repeat(200),
    table = "表".repeat(200);
  const column = "列".repeat(200);
  answers.push({
    names: ["table_name", "column_name", "data_type", "ordinal_position"],
    rows: [
      [table, column, "varchar", 1],
      [table, "next", "varchar", 2],
    ],
  });
  const query = new URLSearchParams({ schema, catalog, table, limit: "1" });
  const first = await request(
    `/api/connections/${trino}/metadata/columns?${query}`,
  );
  expect(first.statusCode, first.body).toBe(200);
  query.set("cursor", first.json().nextCursor);
  answers.push({
    names: ["table_name", "column_name", "data_type", "ordinal_position"],
    rows: [[table, "next", "varchar", 2]],
  });
  const second = await request(
    `/api/connections/${trino}/metadata/columns?${query}`,
  );
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json().items[0].name).toBe("next");
});

it.each([
  "cursor=garbage",
  "cursor=@@@",
  "limit=0",
  "limit=2001",
  "limit=2.5",
  "schema=",
])(
  "rejects malformed metadata parameters before contacting the engine: %s",
  async (query) => {
    const response = await request(
      `/api/connections/${clickhouse}/metadata/tables?schema=demo&${query}`,
    );
    expect(response.statusCode, response.body).toBe(400);
    expect(statements).toHaveLength(0);
  },
);

it("cancels the remote metadata query when the browser disconnects", async () => {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  let started!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  stalled = started;
  let browser: ClientRequest | undefined;
  try {
    const response = new Promise<never>((_resolve, reject) => {
      browser = httpRequest(
        `${address}/api/connections/${clickhouse}/metadata/tables?schema=demo`,
        {
          headers: { host: "127.0.0.1:5178", cookie },
        },
        (value) => {
          value.resume();
          reject(new Error(`Unexpected early response: ${value.statusCode}`));
        },
      );
      browser.once("error", reject);
      browser.end();
    });
    await Promise.race([received, response]);
    browser!.destroy(new Error("Browser disconnected"));
    await expect(response).rejects.toThrow();
    await expect.poll(() => cancellations, { timeout: 2000 }).toBe(1);
  } finally {
    browser?.destroy();
    stalled = undefined;
  }
});
