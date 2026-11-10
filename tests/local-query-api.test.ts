import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { FastifyInstance } from "fastify";

const projectRoot = mkdtempSync(join(tmpdir(), "miracle-local-api-"));
let app: FastifyInstance,
  cookie = "",
  csrf = "";
async function request(method: any, url: string, payload?: any) {
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
async function connect() {
  app = await buildApp({
    projectRoot,
    dataDir: join(projectRoot, ".miracle"),
    appOrigin: "http://127.0.0.1:5178",
    serveStatic: false,
  });
  const response = await request("GET", "/api/session");
  cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  csrf = response.json().csrfToken;
}
async function finish(id: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const run = (await request("GET", `/api/query-runs/${id}`)).json();
    if (!["running", "cancelling"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Local query did not finish");
}
async function query(sql: string) {
  const response = await request("POST", "/api/query-runs", {
    kind: "local",
    sql,
    mutationId: randomUUID(),
  });
  expect(response.statusCode, response.body).toBe(202);
  const run = await finish(response.json().id);
  expect(run.status, run.error).toBe("completed");
  return run;
}
beforeAll(connect);
afterAll(async () => {
  await app?.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

it("keeps original local query labels when registering duplicate SQL column names", async () => {
  const run = await query('SELECT 1 AS amount, 2 AS "Amount"');
  const registered = await request("POST", "/api/datasets", {
    resultSetId: run.resultSetId,
    name: "duplicate_labels",
  });
  expect(registered.statusCode, registered.body).toBe(201);
  expect(registered.json().columns).toMatchObject([
    { name: "amount", sourceName: "amount" },
    { name: "Amount_2", sourceName: "Amount" },
  ]);
}, 30000);

it("runs local SQL, registers a durable dataset, joins a project file and survives restart", async () => {
  const run = await query("SELECT 1 AS month, 12 AS revenue");
  const registered = await request("POST", "/api/datasets", {
    resultSetId: run.resultSetId,
    name: "sales",
    mutationId: randomUUID(),
  });
  expect(registered.statusCode, registered.body).toBe(201);
  writeFileSync(join(projectRoot, "plan.csv"), "month,target\n1,20\n");
  const joined = await query(
    "SELECT revenue, target FROM sales JOIN read_csv('plan.csv') USING (month)",
  );
  const rows = await request(
    "GET",
    `/api/result-sets/${joined.resultSetId}/rows`,
  );
  expect(rows.statusCode, rows.body).toBe(200);
  expect(rows.json().rows).toEqual([[12, 20]]);
  await app.close();
  await connect();
  expect((await request("GET", "/api/datasets")).json()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "sales" })]),
  );
  await query("SELECT count(*) AS n FROM sales");
}, 30000);

it("refreshes a dataset exactly once and leaves the prior snapshot when execution fails", async () => {
  const first = await query("SELECT 2 AS n");
  const dataset = (
    await request("POST", "/api/datasets", {
      resultSetId: first.resultSetId,
      name: "refreshable",
    })
  ).json();
  const refreshInput = {
    baseRevision: dataset.revision,
    source: { kind: "local", sql: "SELECT 3 AS n" },
    mutationId: randomUUID(),
  };
  const refresh = await request(
    "POST",
    `/api/datasets/${dataset.id}/refresh`,
    refreshInput,
  );
  expect(refresh.statusCode, refresh.body).toBe(202);
  expect((await finish(refresh.json().id)).status).toBe("completed");
  const repeated = await request(
    "POST",
    `/api/datasets/${dataset.id}/refresh`,
    refreshInput,
  );
  expect(repeated.statusCode, repeated.body).toBe(202);
  expect(repeated.json().id).toBe(refresh.json().id);
  const updated = (await request("GET", `/api/datasets/${dataset.id}`)).json();
  expect(updated.revision).toBe(dataset.revision + 1);
  const failed = await request("POST", `/api/datasets/${dataset.id}/refresh`, {
    baseRevision: updated.revision,
    source: { kind: "local", sql: "SELECT missing_column" },
    mutationId: randomUUID(),
  });
  expect((await finish(failed.json().id)).status).toBe("failed");
  expect(
    (await request("GET", `/api/datasets/${dataset.id}`)).json().resultSetId,
  ).toBe(updated.resultSetId);
}, 30000);

it("registers a board table atomically and replays node refresh after the linked revision changes", async () => {
  const run = await query("SELECT 5 AS n");
  const board = (
    await request("POST", "/api/boards", { name: "Dataset board" })
  ).json();
  const saved = await request("PATCH", `/api/boards/${board.id}`, {
    baseRevision: board.revision,
    mutationId: randomUUID(),
    document: {
      ...board.document,
      nodes: [
        {
          id: "table",
          type: "artifact",
          position: { x: 0, y: 0 },
          data: {
            kind: "result",
            title: "Five",
            view: "table",
            source: run.source,
            sourceRevision: 20,
            resultSetId: run.resultSetId,
            publishDataset: true,
            datasetName: "board_values",
          },
        },
      ],
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const table = saved.json().document.nodes[0];
  expect(table.data.datasetId).toBeTruthy();
  const input = {
    sourceRevision: table.data.sourceRevision,
    mutationId: randomUUID(),
  };
  const refreshed = await request(
    "POST",
    `/api/boards/${board.id}/nodes/table/refresh`,
    input,
  );
  expect(refreshed.statusCode, refreshed.body).toBe(202);
  expect((await finish(refreshed.json().id)).status).toBe("completed");
  const repeated = await request(
    "POST",
    `/api/boards/${board.id}/nodes/table/refresh`,
    input,
  );
  expect(repeated.statusCode, repeated.body).toBe(202);
  expect(repeated.json().id).toBe(refreshed.json().id);
}, 30000);
