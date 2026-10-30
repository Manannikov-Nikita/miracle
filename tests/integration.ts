/** End-to-end API checks with actual SQLite, ClickHouse and Trino; no mocks. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app.js";
import {
  backupWorkspace,
  restoreWorkspace,
} from "../src/server/maintenance.js";
import type {
  Board,
  QueryRun,
  QuerySource,
  ResultPage,
  SchemaTable,
} from "../src/shared/types.js";
import type {
  MetadataColumn,
  MetadataPage,
  MetadataSchema,
} from "../src/shared/metadata.js";

const root = mkdtempSync(join(tmpdir(), "miracle-external-integration-"));
const dataDir = join(root, "data");
// Match the actual browser origin; fetch owns its Host header.
const probe = createServer();
await new Promise<void>((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", resolve);
});
const bound = probe.address();
if (!bound || typeof bound === "string") throw new Error("No integration port");
const port = bound.port;
await new Promise<void>((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const appOrigin = `http://127.0.0.1:${port}`;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let checks = 0;
const encryptionKey = randomBytes(32);
try {
  app = await buildApp({
    dataDir,
    encryptionKey,
    appOrigin,
    cookieSecure: false,
    limits: {
      timeoutMs: 2500,
      maxRows: 20,
      maxBytes: 4096,
      maxGlobalRuns: 2,
    },
  });
  let address = await app.listen({ port, host: "127.0.0.1" });
  class Actor {
    cookie = "";
    csrf = "";
    async request<T = any>(
      method: string,
      path: string,
      body?: unknown,
      expected = 200,
    ): Promise<T> {
      const response = await fetch(`${address}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Connection: "close",
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...(this.csrf ? { "X-CSRF-Token": this.csrf } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const cookie = response.headers.get("set-cookie");
      if (cookie) this.cookie = cookie.split(";")[0]!;
      const data = (await response.json()) as any;
      assert.equal(
        response.status,
        expected,
        `${method} ${path}: ${JSON.stringify(data)}`,
      );
      if (data.csrfToken) this.csrf = data.csrfToken;
      return data as T;
    }
  }
  const admin = new Actor(),
    viewer = new Actor(),
    editor = new Actor();
  for (const actor of [admin, viewer, editor])
    await actor.request("GET", "/api/session");
  checks++;
  console.log("PASS direct local browser sessions");
  const ch = await admin.request(
    "POST",
    "/api/connections",
    {
      name: "Synthetic ClickHouse",
      engine: "clickhouse",
      url: process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:18123",
      username: "miracle_reader",
      password: "miracle_reader_local",
      database: "demo",
    },
    201,
  );
  const trino = await admin.request(
    "POST",
    "/api/connections",
    {
      name: "TPC-H Trino",
      engine: "trino",
      url: process.env.TRINO_URL ?? "http://127.0.0.1:18080",
      username: "miracle_reader",
      catalog: "tpch",
      schema: "tiny",
    },
    201,
  );
  for (const connection of [ch, trino]) {
    assert.equal(connection.hasPassword, connection.id === ch.id);
    assert.equal(connection.password, undefined);
    await admin.request("POST", `/api/connections/${connection.id}/test`, {});
    const schema = await viewer.request<any[]>(
      "GET",
      `/api/connections/${connection.id}/schema`,
    );
    assert.ok(schema.length > 0);
  }
  checks++;
  console.log("PASS real engines, schema discovery and password redaction");
  async function allMetadata<T>(
    connectionId: string,
    kind: string,
    scope: Record<string, string> = {},
  ) {
    const items: T[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({
        ...scope,
        limit: "1",
        ...(cursor ? { cursor } : {}),
      });
      const page = await viewer.request<MetadataPage<T>>(
        "GET",
        `/api/connections/${connectionId}/metadata/${kind}?${query}`,
      );
      assert.ok(page.items.length <= 1, "Metadata page exceeded its limit");
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor) {
        assert.ok(!seen.has(cursor), "Metadata cursor did not advance");
        seen.add(cursor);
        assert.ok(seen.size < 1000, "Metadata pagination did not finish");
      }
    } while (cursor);
    return items;
  }
  for (const connection of [ch, trino]) {
    const schema = connection.id === ch.id ? "demo" : "tiny";
    const scope = {
      schema,
      ...(connection.id === trino.id ? { catalog: "tpch" } : {}),
    };
    const schemas = await allMetadata<MetadataSchema>(connection.id, "schemas");
    assert.ok(schemas.some((item) => item.schema === schema));
    assert.equal(
      new Set(schemas.map((item) => JSON.stringify(item))).size,
      schemas.length,
    );
    const tables = await allMetadata<SchemaTable>(
      connection.id,
      "tables",
      scope,
    );
    assert.ok(tables.length > 1);
    assert.ok(tables.every((table) => table.schema === schema));
    assert.equal(
      new Set(tables.map((table) => table.name)).size,
      tables.length,
    );
    const oldTables = await viewer.request<SchemaTable[]>(
      "GET",
      `/api/connections/${connection.id}/schema`,
    );
    assert.deepEqual(
      tables.map((table) => table.name).sort(),
      oldTables
        .filter((table) => table.schema === schema)
        .map((table) => table.name)
        .sort(),
    );
    const columns = await allMetadata<MetadataColumn>(
      connection.id,
      "columns",
      scope,
    );
    assert.ok(columns.length > tables.length);
    assert.equal(
      new Set(
        columns.map((column) => JSON.stringify([column.table, column.name])),
      ).size,
      columns.length,
    );
    const table = tables[0]!.name;
    const exactTable = await allMetadata<SchemaTable>(connection.id, "tables", {
      ...scope,
      table,
    });
    assert.deepEqual(exactTable, [tables[0]]);
    const exactColumns = await allMetadata<MetadataColumn>(
      connection.id,
      "columns",
      { ...scope, table },
    );
    assert.deepEqual(
      exactColumns,
      columns.filter((column) => column.table === table),
    );
    const oldColumns = await viewer.request<{ name: string; type: string }[]>(
      "GET",
      `/api/connections/${connection.id}/columns?${new URLSearchParams({ ...scope, table })}`,
    );
    assert.deepEqual(
      exactColumns.map(({ name, type }) => ({ name, type })),
      oldColumns,
    );
  }
  checks++;
  console.log(
    "PASS real paginated metadata, schema scope and exact table/column lookup",
  );
  await editor.request("POST", "/api/users", { email: "x@example.test" }, 404);
  const noCsrf = new Actor();
  noCsrf.cookie = admin.cookie;
  await noCsrf.request("POST", "/api/boards", { name: "forbidden" }, 403);
  checks++;
  console.log("PASS removed account routes and CSRF");
  async function run(
    source: QuerySource,
    expected = "completed",
  ): Promise<QueryRun> {
    let result = await editor.request<QueryRun>(
      "POST",
      "/api/query-runs",
      source,
      202,
    );
    const deadline = Date.now() + 15000;
    while (
      ["running", "cancelling"].includes(result.status) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 75));
      result = await editor.request("GET", `/api/query-runs/${result.id}`);
    }
    assert.equal(result.status, expected, result.error);
    return result;
  }
  for (const connection of [ch, trino]) {
    for (const dateRange of [
      {
        startDate: "2024-02-28",
        endDate: "2024-03-01",
        granularity: "day" as const,
        retries: 0,
      },
      {
        startDate: "2025-12-22",
        endDate: "2026-01-05",
        granularity: "week" as const,
        retries: 0,
      },
      {
        startDate: "2025-12-01",
        endDate: "2026-02-01",
        granularity: "month" as const,
        retries: 0,
      },
    ]) {
      const expected =
        dateRange.granularity === "day"
          ? ["2024-02-28", "2024-02-29", "2024-03-01"]
          : dateRange.granularity === "week"
            ? ["2025-12-22", "2025-12-29", "2026-01-05"]
            : ["2025-12-01", "2026-01-01", "2026-02-01"];
      const batch = await run({
        connectionId: connection.id,
        sql:
          connection.id === ch.id
            ? "SELECT toDate({{date}}) AS day, toUInt64(1) AS value"
            : "SELECT DATE '{{date}}' AS day, CAST(1 AS BIGINT) AS value",
        dateRange,
      });
      assert.equal(batch.batch?.total, 3);
      assert.equal(batch.batch?.succeeded, 3);
      const result = await viewer.request<ResultPage>(
        "GET",
        `/api/result-sets/${batch.resultSetId}/rows`,
      );
      assert.deepEqual(
        result.rows,
        expected.map((date) => [date, connection.id === ch.id ? "1" : 1]),
      );
      assert.deepEqual(result.result.source.dateRange, dateRange);
    }
  }
  checks++;
  console.log(
    "PASS real date batches: inclusive days, calendar weeks/months and combined results",
  );
  const grouped = await run({
    connectionId: trino.id,
    catalog: "tpch",
    schema: "tiny",
    sql: "SELECT orderstatus,count(*) AS orders FROM tpch.tiny.orders GROUP BY orderstatus ORDER BY orderstatus; -- editor delimiter;\n",
  });
  const groupedPage = await viewer.request<ResultPage>(
    "GET",
    `/api/result-sets/${grouped.resultSetId}/rows`,
  );
  assert.deepEqual(
    groupedPage.rows.map((row) => row[0]),
    ["F", "O", "P"],
  );
  assert.ok(groupedPage.rows.every((row) => Number(row[1]) > 0));
  const { engineMetadata, quoteLiteral } =
    await import("../src/server/connectors.js");
  for (const value of [
    "name'quote",
    "name\\slash",
    "both\\'quote",
    "кириллица\\name",
  ]) {
    const literal = await engineMetadata(
      {
        engine: "clickhouse",
        name: "literal roundtrip",
        url: ch.url,
        username: "miracle_reader",
        password: "miracle_reader_local",
        database: "demo",
      },
      "SELECT " + quoteLiteral(value, "clickhouse") + " AS value",
    );
    assert.deepEqual(literal.rows, [[value]]);
  }
  const source = {
    connectionId: ch.id,
    sql: "SELECT id, amount, customer_id, sold_at, comment FROM demo.sales ORDER BY id LIMIT 3",
  };
  const executed = await run(source);
  const page = await viewer.request<ResultPage>(
    "GET",
    `/api/result-sets/${executed.resultSetId}/rows?offset=0&limit=2`,
  );
  assert.equal(page.rows.length, 2);
  assert.equal(page.total, 3);
  assert.equal(page.rows[0]![2], "9007199254740993");
  assert.equal(page.rows[0]![4], null);
  assert.ok(page.rows[0]![3]);
  assert.equal(Number(page.rows[0]![1]), 100);
  await run({
    connectionId: trino.id,
    catalog: "tpch",
    schema: "tiny",
    sql: "SELECT orderkey, totalprice, orderdate FROM tpch.tiny.orders ORDER BY orderkey LIMIT 3",
  });
  await run({
    connectionId: trino.id,
    sql: "SELECT CAST(9007199254740993 AS BIGINT) AS large_id, CAST(12.34 AS DECIMAL(12,2)) AS amount, CAST(NULL AS VARCHAR) AS empty, DATE '2026-01-01' AS day, ARRAY[1,2] AS items",
  });
  checks++;
  console.log(
    "PASS persisted results, pagination, bigint/decimal/date/null/array queries",
  );
  const query = await editor.request(
    "POST",
    "/api/queries",
    { ...source, name: "Pinned source" },
    201,
  );
  await editor.request("PATCH", `/api/queries/${query.id}`, {
    ...source,
    baseRevision: query.revision,
    name: "Updated source",
  });
  await editor.request(
    "PATCH",
    `/api/queries/${query.id}`,
    { ...source, baseRevision: query.revision, name: "Stale source" },
    409,
  );
  let board = await editor.request<Board>(
    "POST",
    "/api/boards",
    {
      name: "Integration board",
      document: {
        schemaVersion: 1,
        nodes: [
          {
            id: "result",
            type: "artifact",
            position: { x: 0, y: 0 },
            data: {
              title: "Pinned result",
              kind: "result",
              resultSetId: executed.resultSetId,
              source,
              sourceRevision: 1,
              view: "table",
            },
          },
        ],
        edges: [],
      },
    },
    201,
  );
  const refresh = await editor.request<QueryRun>(
    "POST",
    `/api/boards/${board.id}/nodes/result/refresh`,
    { sourceRevision: 1 },
    202,
  );
  let refreshed = refresh;
  while (["running", "cancelling"].includes(refreshed.status)) {
    await new Promise((r) => setTimeout(r, 75));
    refreshed = await editor.request("GET", `/api/query-runs/${refresh.id}`);
  }
  assert.equal(refreshed.status, "completed");
  const stillPinned = await viewer.request<Board>(
    "GET",
    `/api/boards/${board.id}`,
  );
  assert.equal(
    stillPinned.document.nodes[0]!.data.resultSetId,
    executed.resultSetId,
  );
  board.document.nodes[0]!.data.resultSetId = refreshed.resultSetId;
  await editor.request("PATCH", `/api/boards/${board.id}`, {
    baseRevision: board.revision,
    document: board.document,
  });
  await editor.request(
    "PATCH",
    `/api/boards/${board.id}`,
    { baseRevision: board.revision, document: board.document },
    409,
  );
  await viewer.request(
    "PATCH",
    `/api/boards/${board.id}`,
    { baseRevision: board.revision, document: board.document },
    409,
  );
  board = await viewer.request<Board>("GET", `/api/boards/${board.id}`);
  const preservedResult = board.document.nodes[0]!.data.resultSetId;
  board.document.nodes[0]!.data.source = {
    connectionId: ch.id,
    sql: "SELECT definitely_missing_column FROM demo.sales",
  };
  board.document.nodes[0]!.data.sourceRevision = 2;
  board = await editor.request("PATCH", `/api/boards/${board.id}`, {
    baseRevision: board.revision,
    document: board.document,
  });
  let badRefresh = await editor.request<QueryRun>(
    "POST",
    `/api/boards/${board.id}/nodes/result/refresh`,
    { sourceRevision: 2 },
    202,
  );
  while (["running", "cancelling"].includes(badRefresh.status)) {
    await new Promise((r) => setTimeout(r, 75));
    badRefresh = await editor.request(
      "GET",
      `/api/query-runs/${badRefresh.id}`,
    );
  }
  assert.equal(badRefresh.status, "failed");
  const afterFailure = await viewer.request<Board>(
    "GET",
    `/api/boards/${board.id}`,
  );
  assert.equal(
    afterFailure.document.nodes[0]!.data.resultSetId,
    preservedResult,
  );
  checks++;
  console.log(
    "PASS saved queries, atomic manual board refresh, failed refresh preservation and revision conflicts",
  );
  for (const denied of [
    "INSERT INTO demo.sales VALUES (999999, today(), 'x', 1, 1, NULL)",
    "DROP TABLE demo.sales",
  ])
    await editor.request(
      "POST",
      "/api/query-runs",
      { connectionId: ch.id, sql: denied },
      400,
    );
  await editor.request(
    "POST",
    "/api/query-runs",
    {
      connectionId: trino.id,
      sql: "CREATE TABLE tpch.tiny.forbidden (id BIGINT)",
    },
    400,
  );
  // These are valid selects; connector/database limits must reject them.
  const rowLimit = await run(
    { connectionId: ch.id, sql: "SELECT number FROM numbers(21)" },
    "failed",
  );
  assert.match(rowLimit.error ?? "", /лимит|TOO_MANY_ROWS|maximum|limit/i);
  const byteLimit = await run(
    { connectionId: ch.id, sql: "SELECT repeat('x', 5000) AS payload" },
    "failed",
  );
  assert.match(byteLimit.error ?? "", /лимит|TOO_MANY_BYTES|maximum|limit/i);
  const sleeping = await editor.request<QueryRun>(
    "POST",
    "/api/query-runs",
    { connectionId: ch.id, sql: "SELECT sleepEachRow(0.2) FROM numbers(15)" },
    202,
  );
  await editor.request("POST", `/api/query-runs/${sleeping.id}/cancel`, {});
  let cancelled = await editor.request<QueryRun>(
    "GET",
    `/api/query-runs/${sleeping.id}`,
  );
  for (
    let i = 0;
    i < 100 && ["running", "cancelling"].includes(cancelled.status);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 50));
    cancelled = await editor.request("GET", `/api/query-runs/${sleeping.id}`);
  }
  assert.equal(cancelled.status, "cancelled", cancelled.error);
  const timeout = await run(
    { connectionId: ch.id, sql: "SELECT sleepEachRow(0.2) FROM numbers(15)" },
    "failed",
  );
  assert.match(timeout.error ?? "", /Превышено время выполнения/);
  assert.ok((timeout.elapsedMs ?? 0) >= 2400);
  const parallelSource = {
    connectionId: ch.id,
    sql: "SELECT sleepEachRow(0.5) FROM numbers(4)",
  };
  const first = await editor.request<QueryRun>(
    "POST",
    "/api/query-runs",
    parallelSource,
    202,
  );
  const second = await editor.request<QueryRun>(
    "POST",
    "/api/query-runs",
    parallelSource,
    202,
  );
  await editor.request("POST", "/api/query-runs", parallelSource, 429);
  for (const current of [first, second])
    await editor.request("POST", `/api/query-runs/${current.id}/cancel`, {});
  checks++;
  console.log(
    "PASS denied mutations, row/byte/time/concurrency limits and cancellation",
  );
  // A restart retains snapshots/boards/credentials and renews in-memory sessions.
  await app.close();
  app = await buildApp({
    dataDir,
    encryptionKey,
    appOrigin,
    cookieSecure: false,
  });
  const nextAddress = await app.listen({ port, host: "127.0.0.1" });
  address = nextAddress;
  for (const actor of [admin, viewer, editor])
    await actor.request("GET", "/api/session");
  const retained = await viewer.request<ResultPage>(
    "GET",
    `/api/result-sets/${executed.resultSetId}/rows?offset=0&limit=2`,
  );
  assert.deepEqual(retained.rows, page.rows);
  assert.ok(
    (await viewer.request<Board>("GET", `/api/boards/${board.id}`)).document
      .nodes.length,
  );
  await admin.request("POST", `/api/connections/${ch.id}/test`, {});
  const many = await run({
    connectionId: trino.id,
    catalog: "tpch",
    schema: "tiny",
    sql: "SELECT orderkey FROM tpch.tiny.orders LIMIT 15000",
  });
  const finalPage = await viewer.request<ResultPage>(
    "GET",
    `/api/result-sets/${many.resultSetId}/rows?offset=14990&limit=10`,
  );
  assert.equal(finalPage.total, 15000);
  assert.equal(finalPage.rows.length, 10);
  await viewer.request(
    "GET",
    `/api/result-sets/${many.resultSetId}/chart`,
    undefined,
    422,
  );
  const expensive = await editor.request<QueryRun>(
    "POST",
    "/api/query-runs",
    {
      connectionId: trino.id,
      catalog: "tpch",
      schema: "tiny",
      sql: "SELECT sum(a.totalprice * b.totalprice) FROM tpch.tiny.orders a CROSS JOIN tpch.tiny.orders b",
    },
    202,
  );
  await editor.request("POST", `/api/query-runs/${expensive.id}/cancel`, {});
  let trinoCancelled = await editor.request<QueryRun>(
    "GET",
    `/api/query-runs/${expensive.id}`,
  );
  for (
    let i = 0;
    i < 100 && ["running", "cancelling"].includes(trinoCancelled.status);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 50));
    trinoCancelled = await editor.request(
      "GET",
      `/api/query-runs/${expensive.id}`,
    );
  }
  assert.equal(trinoCancelled.status, "cancelled");
  checks++;
  console.log(
    "PASS application restart durability, Trino multi-page results and cancellation",
  );
  await app.close();
  app = await buildApp({
    dataDir,
    encryptionKey,
    appOrigin,
    cookieSecure: false,
    limits: { quotaBytes: 1 },
  });
  address = await app.listen({ port, host: "127.0.0.1" });
  for (const actor of [admin, viewer, editor])
    await actor.request("GET", "/api/session");
  const quota = await run({ connectionId: ch.id, sql: "SELECT 1" }, "failed");
  assert.match(quota.error ?? "", /Квота хранения/);
  assert.equal(
    (
      await viewer.request<ResultPage>(
        "GET",
        `/api/result-sets/${executed.resultSetId}/rows?limit=2`,
      )
    ).total,
    3,
  );
  checks++;
  console.log("PASS chart point cap and storage quota without snapshot loss");
  await app.close();
  const backupPath = join(root, "backup");
  await backupWorkspace(dataDir, backupPath);
  await restoreWorkspace(backupPath, join(root, "restored"));
  const restored = await buildApp({
    dataDir: join(root, "restored"),
    serveStatic: false,
  });
  assert.ok(restored.miracle.db.query("SELECT * FROM boards").rows.length);
  await restored.close();
  checks++;
  console.log("PASS portable SQLite backup and paired-key restore");
  console.log(
    `Integration passed: ${checks} groups; SQLite + ClickHouse + Trino.`,
  );
} finally {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
}
