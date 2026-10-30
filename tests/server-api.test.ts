import { beforeAll, afterAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiEngineFixture } from "./api-engine-fixture.js";
const dataDir = mkdtempSync(join(tmpdir(), "miracle-api-"));
let fixture: Awaited<ReturnType<typeof apiEngineFixture>>;
let app: FastifyInstance;
let cookie = "",
  csrf = "",
  viewerCookie = "",
  viewerCsrf = "",
  resultId = "";
async function request(method: any, url: string, payload?: any, v = false) {
  const res = await app.inject({
    method,
    url,
    payload,
    headers: {
      host: "127.0.0.1:5178",
      cookie: v ? viewerCookie : cookie,
      "x-csrf-token": v ? viewerCsrf : csrf,
      origin: "http://127.0.0.1:5178",
    },
  });
  return res;
}
beforeAll(async () => {
  fixture = await apiEngineFixture();
  app = await buildApp({
    dataDir,
    appOrigin: "http://127.0.0.1:5178",
    serveStatic: false,
    limits: { maxRows: 10, maxBytes: 10000, timeoutMs: 5000, maxGlobalRuns: 4 },
  });
  const login = await request("GET", "/api/session");
  expect(login.statusCode, login.body).toBe(200);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  csrf = login.json().csrfToken;
  const second = await request("GET", "/api/session", undefined, true);
  viewerCookie = String(second.headers["set-cookie"]).split(";")[0]!;
  viewerCsrf = second.json().csrfToken;
});
afterAll(async () => {
  await app?.close();
  await fixture?.close();
  rmSync(dataDir, { recursive: true, force: true });
});
it("rejects unauthenticated reads, CSRF and cross-origin writes", async () => {
  expect(
    (
      await app.inject({
        url: "/api/connections",
        headers: { host: "127.0.0.1:5178" },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/boards",
        headers: { host: "127.0.0.1:5178", cookie },
        payload: { name: "Bad" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/boards",
        headers: {
          host: "127.0.0.1:5178",
          cookie,
          origin: "http://evil.test",
          "x-csrf-token": csrf,
        },
        payload: { name: "Bad" },
      })
    ).statusCode,
  ).toBe(403);
});
it("rejects malicious SQL before execution, saves queries optimistically and persists real results", async () => {
  const c = await request("POST", "/api/connections", {
    name: "CH",
    engine: "clickhouse",
    url: fixture.url,
    username: "miracle_reader",
    password: "miracle_reader_local",
    database: "demo",
  });
  expect(c.statusCode).toBe(201);
  expect(JSON.stringify(c.json())).not.toContain("miracle_reader_local");
  const source = {
    connectionId: c.json().id,
    sql: "SELECT toUInt64(9007199254740993) AS exact, 1 AS n",
  };
  const q = await request("POST", "/api/queries", { name: "Test", ...source });
  expect(q.statusCode).toBe(201);
  expect(
    (
      await request("PATCH", "/api/queries/" + q.json().id, {
        name: "New",
        ...source,
        baseRevision: 0,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await request("POST", "/api/query-runs", {
        ...source,
        sql: "SELECT 1; DROP TABLE x",
      })
    ).statusCode,
  ).toBe(400);
  const run = await request("POST", "/api/query-runs", source);
  expect(run.statusCode).toBe(202);
  let state = run.json();
  for (let i = 0; i < 100 && state.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 40));
    state = (await request("GET", "/api/query-runs/" + state.id)).json();
  }
  expect(state.status, JSON.stringify(state)).toBe("completed");
  resultId = state.resultSetId;
  const rows = await request("GET", "/api/result-sets/" + resultId + "/rows");
  expect(rows.json().rows).toEqual([["9007199254740993", 1]]);
  expect(
    (await request("GET", "/api/result-sets/" + resultId + "/chart"))
      .statusCode,
  ).toBe(200);
});
it("validates graph and result references, rejects stale revisions, retains referenced snapshots", async () => {
  const source = (await request("GET", "/api/result-sets/" + resultId)).json()
    .source;
  const document = {
    schemaVersion: 1,
    nodes: [
      {
        id: "n",
        type: "artifact",
        position: { x: 0, y: 0 },
        data: {
          kind: "result",
          title: "Exact",
          resultSetId: resultId,
          source,
          sourceRevision: 1,
        },
      },
    ],
    edges: [],
  };
  const b = await request("POST", "/api/boards", { name: "Board", document });
  expect(b.statusCode).toBe(201);
  expect(
    (
      await request("PATCH", "/api/boards/" + b.json().id, {
        baseRevision: 0,
        document,
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await request("PATCH", "/api/boards/" + b.json().id, {
        baseRevision: 1,
        document: {
          ...document,
          edges: [{ id: "e", source: "n", target: "missing" }],
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await request("POST", "/api/boards/" + b.json().id + "/nodes/n/refresh", {
        sourceRevision: 0,
      })
    ).statusCode,
  ).toBe(409);
  await app.miracle.db.query(
    "UPDATE result_sets SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days') WHERE id=?1",
    [resultId],
  );
  const { retention } = await import("../src/server/db.js");
  await retention(app.miracle.db);
  expect(
    (await request("GET", "/api/result-sets/" + resultId)).statusCode,
  ).toBe(200);
  await request("DELETE", "/api/boards/" + b.json().id);
  await retention(app.miracle.db);
  expect(
    (await request("GET", "/api/result-sets/" + resultId)).statusCode,
  ).toBe(404);
});
it("persists four-sided arrow endpoints and accepts legacy edges", async () => {
  const sides = ["top", "right", "bottom", "left"];
  const edges = sides.flatMap((sourceHandle) =>
    sides.map((targetHandle) => ({
      id: `${sourceHandle}-${targetHandle}`,
      source: "a",
      target: "b",
      sourceHandle,
      targetHandle,
      label: "Связь",
    })),
  );
  const legacy = { id: "legacy", source: "a", target: "b" };
  const document = {
    schemaVersion: 1,
    nodes: ["a", "b"].map((id) => ({
      id,
      type: "artifact",
      position: { x: 0, y: 0 },
      data: { kind: "note", title: id },
    })),
    edges: [...edges, legacy],
  };
  const created = await request("POST", "/api/boards", {
    name: "Four sides",
    document,
  });
  expect(created.statusCode).toBe(201);
  const url = `/api/boards/${created.json().id}`;
  expect((await request("GET", url)).json().document.edges).toEqual([
    ...edges,
    legacy,
  ]);
  const revised = {
    ...document,
    edges: [
      { ...edges[0], sourceHandle: "left", targetHandle: "bottom" },
      legacy,
    ],
  };
  const updated = await request("PATCH", url, {
    baseRevision: created.json().revision,
    document: revised,
  });
  expect(updated.statusCode).toBe(200);
  expect((await request("GET", url)).json().document.edges).toEqual(
    revised.edges,
  );
  for (const invalid of [
    { sourceHandle: "center" },
    { targetHandle: "missing-handle" },
  ]) {
    const rejected = await request("PATCH", url, {
      baseRevision: updated.json().revision,
      document: { ...document, edges: [{ ...edges[0], ...invalid }] },
    });
    expect(rejected.statusCode).toBe(400);
  }
  expect((await request("GET", url)).json().document.edges).toEqual(
    revised.edges,
  );
});
it("persists compact chart formatting alongside legacy axis labels", async () => {
  const chart = {
    kind: "line",
    x: "date",
    y: ["amount"],
    legend: true,
    numberFormat: "compact",
    xLabel: "Legacy X",
    yLabel: "Legacy Y",
  };
  const document = {
    schemaVersion: 1,
    nodes: [
      {
        id: "chart-settings",
        type: "artifact",
        position: { x: 0, y: 0 },
        data: { kind: "note", title: "Chart settings", chart },
      },
    ],
    edges: [],
  };
  const created = await request("POST", "/api/boards", {
    name: "Compact chart",
    document,
  });
  expect(created.statusCode, created.body).toBe(201);
  const url = `/api/boards/${created.json().id}`;
  expect(
    (await request("GET", url)).json().document.nodes[0].data.chart,
  ).toEqual(chart);
  const updated = await request("PATCH", url, {
    baseRevision: created.json().revision,
    document: {
      ...document,
      nodes: [
        {
          ...document.nodes[0],
          data: {
            ...document.nodes[0].data,
            chart: { ...chart, kind: "scatter" },
          },
        },
      ],
    },
  });
  expect(updated.statusCode, updated.body).toBe(200);
  expect(
    (await request("GET", url)).json().document.nodes[0].data.chart,
  ).toEqual({ ...chart, kind: "scatter" });
});
it("rejects malformed multibyte CSRF tokens without server errors", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/boards",
    headers: { cookie, "x-csrf-token": "я".repeat(csrf.length) },
    payload: { name: "No" },
  });
  expect(res.statusCode).toBe(403);
});
it("reserves concurrency atomically and cancels an owned ClickHouse query", async () => {
  const conn = (await request("GET", "/api/connections")).json()[0];
  const source = {
    connectionId: conn.id,
    sql: "SELECT sleepEachRow(0.5) FROM numbers(4)",
  };
  const launched = await Promise.all([
    request("POST", "/api/query-runs", source),
    request("POST", "/api/query-runs", source),
    request("POST", "/api/query-runs", source),
  ]);
  expect(launched.map((r) => r.statusCode).sort()).toEqual([202, 202, 429]);
  for (const r of launched.filter((r) => r.statusCode === 202))
    await request("POST", "/api/query-runs/" + r.json().id + "/cancel", {});
  for (const r of launched.filter((r) => r.statusCode === 202)) {
    let status = "running";
    for (
      let i = 0;
      i < 100 && ["running", "cancelling"].includes(status);
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await request("GET", "/api/query-runs/" + r.json().id)).json()
        .status;
    }
    expect(status).toBe("cancelled");
  }
});
it("does not publish a snapshot when aggregate result quota is full", async () => {
  await app.miracle.db.query(
    "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES('00000000-0000-4000-8000-999999999999',?1,0,?2,?3)",
    [
      JSON.stringify([]),
      2 * 1024 ** 3,
      { connectionId: "00000000-0000-4000-8000-000000000000", sql: "SELECT 1" },
    ],
  );
  const c = (await request("GET", "/api/connections")).json()[0];
  const r = await request("POST", "/api/query-runs", {
    connectionId: c.id,
    sql: "SELECT 1",
  });
  let run = r.json();
  for (let i = 0; i < 100 && run.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 20));
    run = (await request("GET", "/api/query-runs/" + run.id)).json();
  }
  expect(run.status).toBe("failed");
  expect(run.error).toContain("Квота");
  expect(run.resultSetId).toBeUndefined();
});
it("keeps local session metadata fields literal with ClickHouse quotes and backslashes", async () => {
  const readerCookie = viewerCookie;
  const conn = (await request("GET", "/api/connections")).json()[0];
  const normal = await app.inject({
    method: "GET",
    url:
      "/api/connections/" +
      conn.id +
      "/columns?" +
      new URLSearchParams({ schema: "demo", table: "sales" }),
    headers: { host: "127.0.0.1:5178", cookie: readerCookie },
  });
  expect(normal.statusCode).toBe(200);
  expect(
    normal
      .json()
      .some((column: { name: string }) => column.name === "customer_id"),
  ).toBe(true);
  const payload =
    "x\\' UNION ALL SELECT toString(customer_id),toString(amount) FROM demo.sales -- ";
  for (const fields of [
    { schema: payload, table: "sales" },
    { schema: "demo", table: payload },
    { schema: "demo\\'", table: "sales\\'" },
  ]) {
    const response = await app.inject({
      method: "GET",
      url:
        "/api/connections/" +
        conn.id +
        "/columns?" +
        new URLSearchParams(fields),
      headers: { host: "127.0.0.1:5178", cookie: readerCookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([]);
  }
});

it("reads complete bounded table snapshots without re-running SQL and retains table settings", async () => {
  const id = crypto.randomUUID();
  const columns = [{ id: "0", name: "amount", type: "Decimal(18,2)" }];
  const source = {
    connectionId: (await request("GET", "/api/connections")).json()[0].id,
    sql: "SELECT amount",
  };
  const data = Array.from({ length: 501 }, (_, i) => [String(i + 1)]);
  await app.miracle.db.query(
    "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES(?1,?2,501,4000,?3)",
    [id, JSON.stringify(columns), JSON.stringify(source)],
  );
  for (let i = 0; i < 2; i++)
    await app.miracle.db.query(
      "INSERT INTO result_chunks(result_set_id,chunk_index,rows) VALUES(?1,?2,?3)",
      [id, i, JSON.stringify(data.slice(i * 500, (i + 1) * 500))],
    );
  const countBefore = (
    await app.miracle.db.query("SELECT count(*) AS count FROM query_runs")
  ).rows[0].count;
  const response = await request("GET", `/api/result-sets/${id}/table`);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().rows).toEqual(data);
  expect(
    (
      await app.inject({
        method: "GET",
        url: `/api/result-sets/${id}/table`,
        headers: { host: "127.0.0.1:5178" },
      })
    ).statusCode,
  ).toBe(401);
  const viewer = { headers: { "set-cookie": viewerCookie } };
  const viewerResponse = await app.inject({
    method: "GET",
    url: `/api/result-sets/${id}/table`,
    headers: {
      host: "127.0.0.1:5178",
      cookie: String(viewer.headers["set-cookie"]).split(";")[0],
    },
  });
  expect(viewerResponse.statusCode).toBe(200);
  expect(
    (await app.miracle.db.query("SELECT count(*) AS count FROM query_runs"))
      .rows[0].count,
  ).toBe(countBefore);
  const table = {
    version: 1,
    sourceSchema: JSON.stringify(columns.map((c) => [c.id, c.name, c.type])),
    columns: { "0": { format: "compact", summary: "sum" } },
  };
  const board = await request("POST", "/api/boards", {
    name: "Table settings roundtrip",
    document: {
      schemaVersion: 1,
      edges: [],
      nodes: [
        {
          id: "table",
          type: "artifact",
          position: { x: 0, y: 0 },
          data: {
            kind: "result",
            title: "Table",
            source,
            resultSetId: id,
            table,
          },
        },
      ],
    },
  });
  expect(board.statusCode, board.body).toBe(201);
  expect(
    (await request("GET", `/api/boards/${board.json().id}`)).json().document
      .nodes[0].data.table,
  ).toEqual(table);
  await app.miracle.db.query(
    "UPDATE result_sets SET row_count=50001 WHERE id=?1",
    [id],
  );
  expect(
    (await request("GET", `/api/result-sets/${id}/table`)).statusCode,
  ).toBe(422);
  await app.miracle.db.query(
    "UPDATE result_sets SET row_count=501,byte_count=20971521 WHERE id=?1",
    [id],
  );
  expect(
    (await request("GET", `/api/result-sets/${id}/table`)).statusCode,
  ).toBe(422);
});

it("reads the live ClickHouse function catalog without exposing credentials or internal combinators", async () => {
  const conn = (await request("GET", "/api/connections")).json()[0];
  const url = `/api/connections/${conn.id}/functions`;
  expect(
    (await app.inject({ url, headers: { host: "127.0.0.1:5178" } })).statusCode,
  ).toBe(401);
  const response = await request("GET", url);
  expect(response.statusCode, response.body).toBe(200);
  const catalog = response.json();
  expect(catalog.functions).toContainEqual({
    name: "arrayJoin",
    isAggregate: false,
  });
  expect(catalog.functions).toContainEqual({
    name: "uniqExact",
    isAggregate: true,
  });
  expect(catalog.aggregateCombinators).toEqual(
    expect.arrayContaining(["Array", "If", "State", "Merge"]),
  );
  expect(catalog.aggregateCombinators).not.toContain("Null");
  expect(response.body).not.toContain("miracle_reader_local");
  expect(response.body).not.toContain("create_query");
  const trino = await request("POST", "/api/connections", {
    name: "Trino metadata isolation",
    engine: "trino",
    url: "http://127.0.0.1:18080",
    username: "miracle",
  });
  expect(trino.statusCode).toBe(201);
  expect(
    (
      await request("GET", `/api/connections/${trino.json().id}/functions`)
    ).json(),
  ).toEqual({ functions: [], aggregateCombinators: [] });
});
it("rolls back a board document and all result references together when a referenced snapshot is absent", async () => {
  const result = app.miracle.db.query(
    "SELECT id,source FROM result_sets WHERE row_count=501",
  ).rows[0];
  const resultId = result.id as string;
  const source = result.source;
  const document = {
    schemaVersion: 1,
    nodes: [
      {
        id: "snapshot",
        type: "artifact",
        position: { x: 0, y: 0 },
        data: {
          kind: "result",
          title: "Pinned",
          source,
          resultSetId: resultId,
        },
      },
    ],
    edges: [],
  };
  const created = await request("POST", "/api/boards", {
    name: "Atomic refs",
    document,
  });
  expect(created.statusCode, created.body).toBe(201);
  const board = created.json();
  const missing = {
    ...document,
    nodes: [
      {
        ...document.nodes[0],
        data: { ...document.nodes[0].data, resultSetId: crypto.randomUUID() },
      },
    ],
  };
  const rejected = await request("PATCH", `/api/boards/${board.id}`, {
    baseRevision: board.revision,
    document: missing,
  });
  expect(rejected.statusCode, rejected.body).toBe(400);
  expect((await request("GET", `/api/boards/${board.id}`)).json()).toEqual(
    board,
  );
  expect(
    app.miracle.db.query(
      "SELECT result_set_id FROM board_result_refs WHERE board_id=?1",
      [board.id],
    ).rows,
  ).toEqual([{ result_set_id: resultId }]);
});
