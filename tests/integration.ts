/** End-to-end API checks with actual PostgreSQL, ClickHouse and Trino; no mocks. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildApp } from "../src/server/app.js";
import { bootstrapAdmin } from "../src/server/db.js";
import type {
  Board,
  QueryRun,
  QuerySource,
  ResultPage,
} from "../src/shared/types.js";

const baseDatabase =
  process.env.DATABASE_URL ??
  "postgres://miracle:miracle_local@127.0.0.1:5544/miracle";
const management = new pg.Pool({ connectionString: baseDatabase });
const databaseName = `miracle_integration_${Date.now()}`;
await management.query(`CREATE DATABASE "${databaseName}"`);
const databaseUrl = new URL(baseDatabase);
databaseUrl.pathname = `/${databaseName}`;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let checks = 0;
const encryptionKey = randomBytes(32);
try {
  app = await buildApp({
    databaseUrl: databaseUrl.toString(),
    encryptionKey,
    appOrigin: "http://127.0.0.1:5178",
    cookieSecure: false,
    limits: {
      timeoutMs: 2500,
      maxRows: 20,
      maxBytes: 4096,
      maxUserRuns: 2,
      maxGlobalRuns: 4,
    },
  });
  const password = randomBytes(24).toString("base64url");
  await bootstrapAdmin(
    app.miracle.db,
    "admin@example.test",
    "Integration Admin",
    password,
  );
  let address = await app.listen({ port: 0, host: "127.0.0.1" });
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
  await admin.request("POST", "/api/auth/login", {
    email: "admin@example.test",
    password,
  });
  checks++;
  console.log("PASS password login and session");
  for (const [actor, role] of [
    [viewer, "viewer"],
    [editor, "editor"],
  ] as const) {
    const created = await admin.request(
      "POST",
      "/api/users",
      { email: `${role}@example.test`, name: role, role },
      201,
    );
    const token =
      new URL(created.activationUrl, "http://localhost").searchParams.get(
        "token",
      ) ?? created.activationUrl.split("/").at(-1);
    await actor.request("POST", "/api/auth/activate", {
      token,
      password: randomBytes(24).toString("base64url"),
      name: role,
    });
  }
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
  await viewer.request("POST", "/api/connections", { name: "Forbidden" }, 403);
  await editor.request("POST", "/api/users", { email: "x@example.test" }, 403);
  await viewer.request(
    "POST",
    "/api/query-runs",
    { connectionId: ch.id, sql: "SELECT 1" },
    403,
  );
  const noCsrf = new Actor();
  noCsrf.cookie = admin.cookie;
  await noCsrf.request("POST", "/api/boards", { name: "forbidden" }, 403);
  checks++;
  console.log("PASS roles and CSRF");
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
    403,
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
  // A restart must retain snapshots, boards, sessions and encrypted credentials.
  await app.close();
  app = await buildApp({
    databaseUrl: databaseUrl.toString(),
    encryptionKey,
    appOrigin: "http://127.0.0.1:5178",
    cookieSecure: false,
  });
  const nextAddress = await app.listen({ port: 0, host: "127.0.0.1" });
  address = nextAddress;
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
    databaseUrl: databaseUrl.toString(),
    encryptionKey,
    appOrigin: "http://127.0.0.1:5178",
    cookieSecure: false,
    limits: { quotaBytes: 1 },
  });
  address = await app.listen({ port: 0, host: "127.0.0.1" });
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
  const execute = promisify(execFile);
  const backup = await execute(
    "sh",
    ["scripts/backup.sh", ".local/integration-backups"],
    { env: { ...process.env, MIRACLE_BACKUP_DATABASE: databaseName } },
  );
  const backupPath = backup.stdout.trim().split("Backup saved: ").at(-1)!;
  const restore = await execute("sh", [
    "scripts/restore-rehearsal.sh",
    backupPath,
  ]);
  assert.match(restore.stdout, /Restore rehearsal passed/);
  console.log(restore.stdout.trim());
  checks++;
  console.log(
    "PASS real pg_dump/pg_restore rehearsal into disposable database",
  );
  console.log(
    `Integration passed: ${checks} groups; PostgreSQL + ClickHouse + Trino.`,
  );
} finally {
  await app?.close();
  await management.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await management.end();
}
