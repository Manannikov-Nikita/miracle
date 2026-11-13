import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import {
  createResultVisualTable,
  type VisualTableSpec,
} from "../src/shared/visual-table.js";
import { apiEngineFixture } from "./api-engine-fixture.js";
import { DatabaseSync } from "node:sqlite";

const dataDir = mkdtempSync(join(tmpdir(), "miracle-visual-table-api-"));
let app: FastifyInstance;
let fixture: Awaited<ReturnType<typeof apiEngineFixture>>;
let cookie = "",
  csrf = "";
const first = randomUUID(),
  second = randomUUID();
const table: VisualTableSpec = {
  version: 1,
  columns: [
    { id: "name", name: "Товар", type: "text" },
    { id: "qty", name: "Количество", type: "number", summary: "sum" },
    { id: "price", name: "Цена", type: "number" },
    {
      id: "amount",
      name: "Сумма",
      type: "number",
      formula: "Количество * Цена",
      summary: "sum",
    },
  ],
  rows: [
    { id: first, values: { name: "Блокнот", qty: "12", price: "250" } },
    { id: second, values: { name: "Монитор", qty: "2", price: "18000" } },
  ],
  edits: [{ rowId: first, columnId: "qty", value: "20" }],
};
async function request(method: any, url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    payload,
    headers: {
      host: "127.0.0.1:5178",
      origin: "http://127.0.0.1:5178",
      cookie,
      "x-csrf-token": csrf,
    },
  });
}
async function open() {
  app = await buildApp({
    dataDir,
    appOrigin: "http://127.0.0.1:5178",
    serveStatic: false,
  });
  const session = await request("GET", "/api/session");
  cookie = String(session.headers["set-cookie"]).split(";")[0];
  csrf = session.json().csrfToken;
}
beforeAll(async () => {
  fixture = await apiEngineFixture();
  await open();
});
afterAll(async () => {
  await app?.close();
  await fixture?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

it("requires session and CSRF for visual SQL evaluation", async () => {
  const noSession = await app.inject({
    method: "POST",
    url: "/api/visual-table/evaluate",
    payload: { table },
    headers: { host: "127.0.0.1:5178" },
  });
  expect(noSession.statusCode).toBe(401);
  const noCsrf = await app.inject({
    method: "POST",
    url: "/api/visual-table/evaluate",
    payload: { table },
    headers: { host: "127.0.0.1:5178", cookie },
  });
  expect(noCsrf.statusCode).toBe(403);
});
it("evaluates manual edits and computes totals across pages without saving", async () => {
  const response = await request("POST", "/api/visual-table/evaluate", {
    table,
    limit: 1,
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json();
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0].id).toBe(first);
  expect(Number(result.rows[0].values.amount)).toBe(5000);
  expect(Number(result.summaries.amount)).toBe(41000);
  expect(result.totalRowCount).toBe(2);
  expect(result.sql).toContain("SELECT");
  expect((await request("GET", "/api/boards")).json()).toHaveLength(0);
});
it("persists table definitions and edits through board save and project reopening", async () => {
  const created = await request("POST", "/api/boards", { name: "Расчёты" });
  expect(created.statusCode, created.body).toBe(201);
  const board = created.json();
  const document = {
    schemaVersion: 1,
    edges: [],
    nodes: [
      {
        id: "table-node",
        type: "artifact",
        position: { x: 0, y: 0 },
        width: 760,
        height: 420,
        data: { kind: "table", title: "Продажи", visualTable: table },
      },
    ],
  };
  const saved = await request("PATCH", `/api/boards/${board.id}`, {
    baseRevision: board.revision,
    document,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  await app.close();
  cookie = "";
  csrf = "";
  await open();
  const restored = (await request("GET", `/api/boards/${board.id}`)).json();
  expect(restored.document.nodes[0].data.visualTable).toEqual(table);
  const calculation = await request("POST", "/api/visual-table/evaluate", {
    table: restored.document.nodes[0].data.visualTable,
  });
  expect(calculation.statusCode, calculation.body).toBe(200);
  expect(Number(calculation.json().summaries.amount)).toBe(41000);
});
it("rejects stale snapshot overrides and retains the snapshot used by a table", async () => {
  const connection = (
    await request("POST", "/api/connections", {
      name: "Fixture",
      engine: "clickhouse",
      url: fixture.url,
      username: "reader",
      password: "",
      database: "demo",
    })
  ).json();
  const source = {
    connectionId: connection.id,
    sql: "SELECT toUInt64(9007199254740993) AS exact, 1 AS n",
  };
  async function snapshot() {
    let run = (await request("POST", "/api/query-runs", source)).json();
    for (let i = 0; i < 100 && run.status === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      run = (await request("GET", `/api/query-runs/${run.id}`)).json();
    }
    expect(run.status).toBe("completed");
    return (await request("GET", `/api/result-sets/${run.resultSetId}`)).json();
  }
  const original = await snapshot(),
    refreshed = await snapshot();
  const visual = createResultVisualTable(original);
  visual.edits.push({
    rowId: `${original.id}:0`,
    columnId: visual.columns[1].id,
    value: "9",
  });
  const stale = await request("POST", "/api/visual-table/evaluate", {
    resultSetId: refreshed.id,
    table: visual,
  });
  expect(stale.statusCode).toBe(422);
  const good = await request("POST", "/api/visual-table/evaluate", {
    resultSetId: original.id,
    table: visual,
  });
  expect(good.statusCode, good.body).toBe(200);
  expect(String(good.json().rows[0].values[visual.columns[0].id])).toMatch(
    /^9007199254740993(?:\.0+)?$/,
  );
  const unchanged = (
    await request("GET", `/api/result-sets/${original.id}/rows`)
  ).json();
  expect(unchanged.rows).toEqual([["9007199254740993", 1]]);
  const created = (
    await request("POST", "/api/boards", { name: "Снимки" })
  ).json();
  const document = {
    schemaVersion: 1,
    edges: [],
    nodes: [
      {
        id: "result-node",
        type: "artifact",
        position: { x: 0, y: 0 },
        data: {
          kind: "result",
          title: "SQL",
          source,
          resultSetId: refreshed.id,
          visualTable: visual,
        },
      },
    ],
  };
  const saved = await request("PATCH", `/api/boards/${created.id}`, {
    baseRevision: created.revision,
    document,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const refs = (await request("GET", `/api/boards/${created.id}`)).json();
  expect(refs.document.nodes[0].data.visualTable.sourceResultSetId).toBe(
    original.id,
  );
  const missing = structuredClone(document);
  missing.nodes[0].data.visualTable.sourceResultSetId = randomUUID();
  missing.nodes[0].data.visualTable.edits = [];
  const rejected = await request("PATCH", `/api/boards/${created.id}`, {
    baseRevision: saved.json().revision,
    document: missing,
  });
  expect(rejected.statusCode).toBe(400);
  await app.close();
  const db = new DatabaseSync(join(dataDir, "miracle.sqlite"));
  db.prepare(
    "UPDATE result_sets SET created_at='2000-01-01T00:00:00Z' WHERE id=?",
  ).run(original.id);
  db.close();
  cookie = "";
  csrf = "";
  await open();
  expect(
    (await request("GET", `/api/result-sets/${original.id}`)).statusCode,
  ).toBe(200);
});
