import { afterEach, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type Limits } from "../src/server/app.js";
import type { QueryRun } from "../src/shared/types.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const dates = {
  startDate: "2026-01-01",
  endDate: "2026-01-03",
  granularity: "day",
  retries: 0,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
type Response = {
  names?: string[];
  types?: string[];
  rows?: unknown[][];
  error?: string;
};
async function setup(
  handler: (
    date: string,
    attempt: number,
    sql: string,
  ) => Response | Promise<Response>,
  limits: Partial<Limits> = {},
) {
  const calls: { date: string; attempt: number; id: string; sql: string }[] =
    [];
  const counts = new Map<string, number>();
  const kills: string[] = [];
  const server = createServer(async (req, res: ServerResponse) => {
    let sql = "";
    for await (const chunk of req) sql += chunk;
    if (sql.startsWith("KILL")) {
      kills.push(sql);
      res.end();
      return;
    }
    const date = sql.match(/'(\d{4}-\d{2}-\d{2})'/)?.[1] || "unsubstituted";
    const attempt = (counts.get(date) || 0) + 1;
    counts.set(date, attempt);
    calls.push({
      date,
      attempt,
      sql,
      id: new URL(req.url!, "http://local").searchParams.get("query_id") || "",
    });
    const output = await handler(date, attempt, sql);
    if (output.error) {
      res.writeHead(500);
      res.end(output.error);
    } else
      res.end(
        [
          output.names || ["day"],
          output.types || ["Date"],
          ...(output.rows || [[date]]),
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  const dataDir = mkdtempSync(join(tmpdir(), "miracle-date-batch-"));
  cleanup.push(async () => {
    rmSync(dataDir, { recursive: true, force: true });
  });
  const app = await buildApp({
    dataDir,
    serveStatic: false,
    appOrigin: "http://127.0.0.1:3001",
    limits: {
      maxRows: 1000,
      maxBytes: 100000,
      timeoutMs: 2000,
      quotaBytes: 1000000,
      ...limits,
    },
  });
  cleanup.push(() => app.close());
  const session = await app.inject({
    url: "/api/session",
    headers: { host: "127.0.0.1:3001" },
  });
  const headers = {
    host: "127.0.0.1:3001",
    cookie: String(session.headers["set-cookie"]).split(";")[0]!,
    "x-csrf-token": session.json().csrfToken,
  };
  const request = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: any,
  ) => app.inject({ method, url, headers, payload });
  const c = await request("POST", "/api/connections", {
    name: "Batch fixture",
    engine: "clickhouse",
    url: `http://127.0.0.1:${address.port}`,
    username: "reader",
    password: "fixture-secret",
  });
  const source = {
    connectionId: c.json().id,
    sql: "SELECT {{date}} AS day",
    dateRange: dates,
  };
  async function start(extra: any = {}): Promise<QueryRun> {
    const response = await request("POST", "/api/query-runs", {
      ...source,
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(202);
    return response.json();
  }
  async function wait(
    id: string,
    predicate: (run: QueryRun) => boolean = (r) =>
      !["running", "cancelling"].includes(r.status),
  ) {
    for (let i = 0; i < 400; i++) {
      const r = await request("GET", `/api/query-runs/${id}`);
      const value = r.json<QueryRun>();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Batch did not reach expected state");
  }
  return { app, request, start, wait, calls, kills, source, dataDir };
}

it("runs dates sequentially, publishes an accumulating result and rejects pinning it while active", async () => {
  const release = deferred();
  const fixture = await setup(async (date) => {
    if (date === "2026-01-02") await release.promise;
    return {};
  });
  const run = await fixture.start();
  expect(run.batch?.total).toBe(3);
  const partial = await fixture.wait(run.id, (r) => r.batch?.succeeded === 1);
  expect(partial.status).toBe("running");
  expect(partial.rowCount).toBe(1);
  const page = await fixture.request(
    "GET",
    `/api/result-sets/${partial.resultSetId}/rows`,
  );
  expect(page.json().rows).toEqual([["2026-01-01"]]);
  const board = (
    await fixture.request("POST", "/api/boards", { name: "Batch board" })
  ).json();
  const document = {
    schemaVersion: 1,
    nodes: [
      {
        id: "batch",
        type: "artifact",
        position: { x: 0, y: 0 },
        width: 500,
        height: 300,
        data: {
          kind: "result",
          title: "Batch",
          resultSetId: partial.resultSetId,
          source: fixture.source,
          sourceRevision: 1,
          view: "table",
        },
      },
    ],
    edges: [],
  };
  const pin = await fixture.request("PATCH", `/api/boards/${board.id}`, {
    baseRevision: board.revision,
    document,
  });
  expect(pin.statusCode).toBe(409);
  release.resolve();
  const done = await fixture.wait(run.id);
  expect(done.status).toBe("completed");
  expect(done.batch).toMatchObject({
    total: 3,
    completed: 3,
    succeeded: 3,
    failed: 0,
  });
  expect(done.resultSetId).toBe(partial.resultSetId);
  expect(
    (
      await fixture.request("GET", `/api/result-sets/${done.resultSetId}/rows`)
    ).json().rows,
  ).toEqual([["2026-01-01"], ["2026-01-02"], ["2026-01-03"]]);
  expect(fixture.calls.map((call) => call.date)).toEqual([
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
  ]);
  const saved = await fixture.request("PATCH", `/api/boards/${board.id}`, {
    baseRevision: board.revision,
    document,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const refresh = await fixture.request(
    "POST",
    `/api/boards/${board.id}/nodes/batch/refresh`,
    { sourceRevision: 1 },
  );
  expect(refresh.statusCode, refresh.body).toBe(202);
  expect((await fixture.wait(refresh.json().id)).batch?.succeeded).toBe(3);
});

it("retains Sunday weeks in saved queries, editor documents, result snapshots and board reruns", async () => {
  const fixture = await setup(() => ({}));
  const dateRange = {
    startDate: "2025-12-28",
    endDate: "2026-01-11",
    granularity: "week",
    weekStartsOn: "sunday",
    retries: 0,
  };
  const source = { ...fixture.source, dateRange };
  const queryResponse = await fixture.request("POST", "/api/queries", {
    ...source,
    name: "Sunday weeks",
  });
  expect(queryResponse.statusCode, queryResponse.body).toBe(201);
  const query = queryResponse.json();
  expect(query.dateRange).toEqual(dateRange);
  expect((await fixture.request("GET", "/api/queries")).json()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: query.id, dateRange }),
    ]),
  );
  const editorResponse = await fixture.request(
    "POST",
    "/api/editor-documents",
    {
      ...source,
      name: "Sunday weeks",
      queryId: query.id,
      queryRevision: query.revision,
    },
  );
  expect(editorResponse.statusCode, editorResponse.body).toBe(201);
  const editor = editorResponse.json();
  expect(editor.dateRange).toEqual(dateRange);
  const nextRange = { ...dateRange, endDate: "2026-01-18" };
  const updatedQuery = await fixture.request(
    "PATCH",
    `/api/queries/${query.id}`,
    {
      ...source,
      dateRange: nextRange,
      name: query.name,
      baseRevision: query.revision,
    },
  );
  expect(updatedQuery.statusCode, updatedQuery.body).toBe(200);
  expect(
    (await fixture.request("GET", `/api/editor-documents/${editor.id}`)).json()
      .dateRange,
  ).toEqual(nextRange);

  const done = await fixture.wait((await fixture.start({ dateRange })).id);
  expect(done.status).toBe("completed");
  expect(done.source.dateRange).toEqual(dateRange);
  const result = (
    await fixture.request("GET", `/api/result-sets/${done.resultSetId}/rows`)
  ).json();
  expect(result.result.source.dateRange).toEqual(dateRange);
  expect(result.rows).toEqual([["2025-12-28"], ["2026-01-04"], ["2026-01-11"]]);

  const boardResponse = await fixture.request("POST", "/api/boards", {
    name: "Sunday weeks",
    document: {
      schemaVersion: 1,
      nodes: [
        {
          id: "weeks",
          type: "artifact",
          position: { x: 0, y: 0 },
          width: 500,
          height: 300,
          data: {
            kind: "result",
            title: "Weeks",
            resultSetId: done.resultSetId,
            source,
            sourceRevision: 1,
            view: "table",
          },
        },
      ],
      edges: [],
    },
  });
  expect(boardResponse.statusCode, boardResponse.body).toBe(201);
  const board = (
    await fixture.request("GET", `/api/boards/${boardResponse.json().id}`)
  ).json();
  expect(board.document.nodes[0].data.source.dateRange).toEqual(dateRange);
  const refresh = await fixture.request(
    "POST",
    `/api/boards/${board.id}/nodes/weeks/refresh`,
    { sourceRevision: 1 },
  );
  expect(refresh.statusCode, refresh.body).toBe(202);
  const refreshed = await fixture.wait(refresh.json().id);
  expect(refreshed.status).toBe("completed");
  expect(refreshed.source.dateRange).toEqual(dateRange);
  expect(fixture.calls.map((call) => call.date)).toEqual([
    "2025-12-28",
    "2026-01-04",
    "2026-01-11",
    "2025-12-28",
    "2026-01-04",
    "2026-01-11",
  ]);
});

it("pauses after exhausted attempts and resumes the same date with a fresh retry budget", async () => {
  const fixture = await setup((date, attempt) =>
    (date === "2026-01-02" && attempt <= 3) ||
    (date === "2026-01-01" && attempt === 1)
      ? { error: "temporary fixture-secret" }
      : {},
  );
  const run = await fixture.start({ dateRange: { ...dates, retries: 1 } });
  const paused = await fixture.wait(run.id);
  expect(paused.status).toBe("paused");
  expect(paused.finishedAt).toBeUndefined();
  expect(paused.batch).toMatchObject({
    completed: 1,
    succeeded: 1,
    failed: 1,
    currentDate: "2026-01-02",
    attempt: 2,
  });
  expect(paused.batch?.items.map((item) => item.status)).toEqual([
    "completed",
    "failed",
    "pending",
  ]);
  expect(paused.batch?.items.map((item) => item.attempts)).toEqual([2, 2, 0]);
  expect(paused.batch?.items[1].error).not.toContain("fixture-secret");
  expect(fixture.calls.map((call) => call.date)).toEqual([
    "2026-01-01",
    "2026-01-01",
    "2026-01-02",
    "2026-01-02",
  ]);
  const resumed = await fixture.request(
    "POST",
    `/api/query-runs/${run.id}/resume`,
    {},
  );
  expect(resumed.statusCode, resumed.body).toBe(202);
  expect(resumed.json().id).toBe(run.id);
  const done = await fixture.wait(run.id);
  expect(done.status).toBe("completed");
  expect(done.resultSetId).toBe(paused.resultSetId);
  expect(done.batch).toMatchObject({ completed: 3, succeeded: 3, failed: 0 });
  expect(done.batch?.items.map((item) => item.attempts)).toEqual([2, 2, 1]);
  expect(done.batch?.items[1].error).toBeUndefined();
  expect(
    (
      await fixture.request("GET", `/api/result-sets/${done.resultSetId}/rows`)
    ).json().rows,
  ).toEqual([["2026-01-01"], ["2026-01-02"], ["2026-01-03"]]);
  expect(new Set(fixture.calls.map((call) => call.id)).size).toBe(7);
  expect(done.elapsedMs).toBeGreaterThanOrEqual(paused.elapsedMs!);
  expect(
    (await fixture.request("POST", `/api/query-runs/${run.id}/resume`, {}))
      .statusCode,
  ).toBe(409);
});

it("pauses again after another exhausted budget, and cancelling the pause never starts later dates", async () => {
  const fixture = await setup(() => ({ error: "offline" }));
  const run = await fixture.start();
  expect((await fixture.wait(run.id)).status).toBe("paused");
  expect(
    (await fixture.request("POST", `/api/query-runs/${run.id}/resume`, {}))
      .statusCode,
  ).toBe(202);
  const paused = await fixture.wait(run.id);
  expect(paused.status).toBe("paused");
  expect(paused.batch).toMatchObject({
    completed: 0,
    succeeded: 0,
    failed: 1,
    currentDate: "2026-01-01",
  });
  const cancelled = await fixture.request(
    "POST",
    `/api/query-runs/${run.id}/cancel`,
    {},
  );
  expect(cancelled.json().status).toBe("cancelled");
  expect(cancelled.json().finishedAt).toBeDefined();
  expect(fixture.calls.map((call) => call.date)).toEqual([
    "2026-01-01",
    "2026-01-01",
  ]);
  expect(
    (await fixture.request("POST", `/api/query-runs/${run.id}/resume`, {}))
      .statusCode,
  ).toBe(409);
});

it("frees the global slot while paused, then rejects resume when the slot is occupied", async () => {
  const release = deferred();
  const fixture = await setup(
    async (date) => {
      if (date === "unsubstituted") {
        await release.promise;
        return {};
      }
      return { error: "offline" };
    },
    { maxGlobalRuns: 1 },
  );
  const pausedRun = await fixture.start();
  await fixture.wait(pausedRun.id);
  const activeRun = await fixture.start({
    sql: "SELECT 1",
    dateRange: undefined,
  });
  const blocked = await fixture.request(
    "POST",
    `/api/query-runs/${pausedRun.id}/resume`,
    {},
  );
  expect(blocked.statusCode).toBe(429);
  expect(
    (await fixture.request("GET", `/api/query-runs/${pausedRun.id}`)).json()
      .status,
  ).toBe("paused");
  release.resolve();
  await fixture.wait(activeRun.id);
});

it("allows only one concurrent resume and cancels that resumed attempt", async () => {
  const release = deferred();
  const fixture = await setup(async (_date, attempt) => {
    if (attempt === 1) return { error: "offline" };
    await release.promise;
    return {};
  });
  const run = await fixture.start();
  await fixture.wait(run.id);
  const requests = await Promise.all([
    fixture.request("POST", `/api/query-runs/${run.id}/resume`, {}),
    fixture.request("POST", `/api/query-runs/${run.id}/resume`, {}),
  ]);
  expect(requests.map((response) => response.statusCode).sort()).toEqual([
    202, 409,
  ]);
  await fixture.wait(run.id, (current) => current.status === "running");
  await fixture.request("POST", `/api/query-runs/${run.id}/cancel`, {});
  expect((await fixture.wait(run.id)).status).toBe("cancelled");
  release.resolve();
  expect(fixture.calls.every((call) => call.date === "2026-01-01")).toBe(true);
});

it("retains a paused run across cleanup and restart, and cannot pin its mutable result", async () => {
  const fixture = await setup((date, attempt) =>
    date === "2026-01-02" && attempt === 1 ? { error: "offline" } : {},
  );
  const run = await fixture.start();
  const paused = await fixture.wait(run.id);
  expect(paused.status).toBe("paused");
  const db = fixture.app.miracle.db;
  db.query(
    "UPDATE query_runs SET started_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
    [run.id],
  );
  db.query(
    "UPDATE result_sets SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
    [paused.resultSetId],
  );
  const { retention } = await import("../src/server/db.js");
  retention(db);
  expect(
    db.query("SELECT id FROM query_runs WHERE id=?1", [run.id]).rowCount,
  ).toBe(1);
  const board = (
    await fixture.request("POST", "/api/boards", { name: "Paused batch" })
  ).json();
  const pin = await fixture.request("PATCH", `/api/boards/${board.id}`, {
    baseRevision: board.revision,
    document: {
      schemaVersion: 1,
      edges: [],
      nodes: [
        {
          id: "batch",
          type: "artifact",
          position: { x: 0, y: 0 },
          data: {
            kind: "result",
            title: "Batch",
            resultSetId: paused.resultSetId,
            source: fixture.source,
            view: "table",
          },
        },
      ],
    },
  });
  expect(pin.statusCode).toBe(409);
  await fixture.app.close();
  const reopened = await buildApp({
    dataDir: fixture.dataDir,
    serveStatic: false,
    appOrigin: "http://127.0.0.1:3001",
  });
  cleanup.push(() => reopened.close());
  const session = await reopened.inject({
    url: "/api/session",
    headers: { host: "127.0.0.1:3001" },
  });
  const headers = {
    host: "127.0.0.1:3001",
    cookie: String(session.headers["set-cookie"]).split(";")[0]!,
    "x-csrf-token": session.json().csrfToken,
  };
  const stillPaused = (
    await reopened.inject({ url: `/api/query-runs/${run.id}`, headers })
  ).json<QueryRun>();
  expect(stillPaused.status).toBe("paused");
  expect(stillPaused.batch).toEqual(paused.batch);
  expect(fixture.calls.map((call) => call.date)).toEqual([
    "2026-01-01",
    "2026-01-02",
  ]);
  const resumed = await reopened.inject({
    method: "POST",
    url: `/api/query-runs/${run.id}/resume`,
    headers,
    payload: {},
  });
  expect(resumed.statusCode, resumed.body).toBe(202);
  let done = resumed.json<QueryRun>();
  for (let i = 0; i < 400 && done.status === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    done = (
      await reopened.inject({ url: `/api/query-runs/${run.id}`, headers })
    ).json<QueryRun>();
  }
  expect(done.status).toBe("completed");
  expect(done.resultSetId).toBe(paused.resultSetId);
  expect(
    (
      await reopened.inject({
        url: `/api/result-sets/${done.resultSetId}/rows`,
        headers,
      })
    ).json().rows,
  ).toEqual([["2026-01-01"], ["2026-01-02"], ["2026-01-03"]]);
});

it("keeps a run paused if resume preflight finds full storage or a missing result", async () => {
  const fixture = await setup(
    (date) => (date === "2026-01-02" ? { error: "offline" } : {}),
    { quotaBytes: 100 },
  );
  const paused = await fixture.wait((await fixture.start()).id);
  expect(paused.status).toBe("paused");
  const db = fixture.app.miracle.db;
  db.query("UPDATE result_sets SET byte_count=100 WHERE id=?1", [
    paused.resultSetId,
  ]);
  const quota = await fixture.request(
    "POST",
    `/api/query-runs/${paused.id}/resume`,
    {},
  );
  expect(quota.statusCode).toBe(409);
  expect(quota.json().error).toContain("Квота");
  db.query("DELETE FROM result_sets WHERE id=?1", [paused.resultSetId]);
  const missing = await fixture.request(
    "POST",
    `/api/query-runs/${paused.id}/resume`,
    {},
  );
  expect(missing.statusCode).toBe(409);
  expect(missing.json().error).toContain("недоступен");
  expect(
    (await fixture.request("GET", `/api/query-runs/${paused.id}`)).json()
      .status,
  ).toBe("paused");
  expect(fixture.calls).toHaveLength(2);
});

it("fills a previous partial result chunk when appending the next date", async () => {
  const fixture = await setup((date) => ({
    names: ["n"],
    types: ["Int32"],
    rows:
      date === "2026-01-01"
        ? Array.from({ length: 499 }, (_, i) => [i])
        : [[499], [500]],
  }));
  const done = await fixture.wait(
    (await fixture.start({ dateRange: { ...dates, endDate: "2026-01-02" } }))
      .id,
  );
  expect(done.rowCount).toBe(501);
  const rows = (
    await fixture.request(
      "GET",
      `/api/result-sets/${done.resultSetId}/rows?offset=498&limit=3`,
    )
  ).json();
  expect(rows.rows).toEqual([[498], [499], [500]]);
});

it("rejects mismatched placeholder/range configuration before contacting the engine", async () => {
  const fixture = await setup(() => ({}));
  for (const payload of [
    { ...fixture.source, dateRange: undefined },
    { ...fixture.source, sql: "SELECT 1" },
    { ...fixture.source, dateRange: { ...dates, retries: 11 } },
    { ...fixture.source, dateRange: { ...dates, weekStartsOn: "friday" } },
    {
      ...fixture.source,
      dateRange: {
        startDate: "2026-01-05",
        endDate: "2026-01-12",
        granularity: "week",
        weekStartsOn: "sunday",
        retries: 0,
      },
    },
  ]) {
    const response = await fixture.request("POST", "/api/query-runs", payload);
    expect(response.statusCode, response.body).toBe(400);
  }
  expect(fixture.calls).toEqual([]);
});

it("cancels an active date without discarding committed dates or starting later dates", async () => {
  const release = deferred();
  const fixture = await setup(async (date) => {
    if (date === "2026-01-02") await release.promise;
    return {};
  });
  const run = await fixture.start({ dateRange: { ...dates, retries: 3 } });
  await fixture.wait(
    run.id,
    (r) => r.batch?.succeeded === 1 && r.batch?.currentDate === "2026-01-02",
  );
  const cancel = await fixture.request(
    "POST",
    `/api/query-runs/${run.id}/cancel`,
    {},
  );
  expect(cancel.statusCode).toBe(200);
  const done = await fixture.wait(run.id);
  release.resolve();
  expect(done.status).toBe("cancelled");
  expect(done.batch?.items.map((item) => item.status)).toEqual([
    "completed",
    "cancelled",
    "cancelled",
  ]);
  expect(done.rowCount).toBe(1);
  expect(fixture.calls.map((call) => call.date)).toEqual([
    "2026-01-01",
    "2026-01-02",
  ]);
  expect(fixture.kills.length).toBeGreaterThan(0);
  expect(
    (
      await fixture.request("GET", `/api/result-sets/${done.resultSetId}/rows`)
    ).json().rows,
  ).toEqual([["2026-01-01"]]);
});

it("cancels during retry backoff without issuing a second attempt", async () => {
  const fixture = await setup(() => ({ error: "offline" }));
  const run = await fixture.start({ dateRange: { ...dates, retries: 4 } });
  await fixture.wait(run.id, (r) => r.batch?.items[0].status === "retrying");
  await fixture.request("POST", `/api/query-runs/${run.id}/cancel`, {});
  const done = await fixture.wait(run.id);
  expect(done.status).toBe("cancelled");
  expect(fixture.calls).toHaveLength(1);
  expect(done.batch?.items[0].attempts).toBe(1);
  expect(done.resultSetId).toBeUndefined();
});

it("stops on quota exhaustion without retrying storage writes or executing later dates", async () => {
  const fixture = await setup(() => ({}), { quotaBytes: 20 });
  const done = await fixture.wait(
    (await fixture.start({ dateRange: { ...dates, retries: 3 } })).id,
  );
  expect(done.status).toBe("failed");
  expect(done.error).toContain("Квота");
  expect(done.batch).toMatchObject({ completed: 2, succeeded: 1, failed: 1 });
  expect(done.batch?.items.map((item) => item.status)).toEqual([
    "completed",
    "failed",
    "cancelled",
  ]);
  expect(fixture.calls).toHaveLength(2);
  expect(done.rowCount).toBe(1);
});

it("stops on incompatible result columns while preserving the earlier result", async () => {
  const fixture = await setup((date) => ({
    names: date === "2026-01-02" ? ["different"] : ["day"],
  }));
  const done = await fixture.wait(
    (await fixture.start({ dateRange: { ...dates, retries: 3 } })).id,
  );
  expect(done.status).toBe("failed");
  expect(done.error).toContain("Структура столбцов");
  expect(done.batch?.items[1].attempts).toBe(1);
  expect(fixture.calls).toHaveLength(2);
  expect(
    (
      await fixture.request("GET", `/api/result-sets/${done.resultSetId}/rows`)
    ).json().rows,
  ).toEqual([["2026-01-01"]]);
});

it("retains first-date headers while combining date-derived names and applying per-date limits", async () => {
  const fixture = await setup(
    (date) => ({ names: [`'${date}'`], types: ["String"] }),
    { maxRows: 1 },
  );
  const done = await fixture.wait(
    (await fixture.start({ sql: "SELECT '{{date}}'" })).id,
  );
  expect(done.status).toBe("completed");
  expect(done.rowCount).toBe(3);
  const result = (
    await fixture.request("GET", `/api/result-sets/${done.resultSetId}/rows`)
  ).json();
  expect(result.result.columns).toEqual([
    { id: "0", name: "'2026-01-01'", type: "String" },
  ]);
  expect(result.rows).toEqual([["2026-01-01"], ["2026-01-02"], ["2026-01-03"]]);
  expect(result.result.source.dateRange).toEqual(dates);
});

it("keeps a fixed alias containing the first date unchanged across the batch", async () => {
  const fixture = await setup((date) => ({
    names: ["day", "2026-01-01"],
    types: ["Date", "UInt8"],
    rows: [[date, 1]],
  }));
  const done = await fixture.wait(
    (await fixture.start({ sql: 'SELECT {{date}} AS day, 1 AS "2026-01-01"' }))
      .id,
  );
  expect(done.status).toBe("completed");
  const result = (
    await fixture.request("GET", `/api/result-sets/${done.resultSetId}/rows`)
  ).json();
  expect(result.result.columns.map((column: any) => column.name)).toEqual([
    "day",
    "2026-01-01",
  ]);
  expect(result.rows).toEqual([
    ["2026-01-01", 1],
    ["2026-01-02", 1],
    ["2026-01-03", 1],
  ]);
});

it("uses one global run slot for the complete batch", async () => {
  const release = deferred();
  const fixture = await setup(async () => {
    await release.promise;
    return {};
  });
  const first = await fixture.start();
  const second = await fixture.start({ sql: "SELECT 1", dateRange: undefined });
  const third = await fixture.request(
    "POST",
    "/api/query-runs",
    fixture.source,
  );
  expect(third.statusCode).toBe(429);
  release.resolve();
  expect((await fixture.wait(first.id)).batch?.succeeded).toBe(3);
  expect((await fixture.wait(second.id)).status).toBe("completed");
});

it("marks unfinished batch dates interrupted on restart and retains its result", async () => {
  const fixture = await setup(() => ({}));
  const run = await fixture.wait(
    (await fixture.start({ dateRange: { ...dates, endDate: "2026-01-01" } }))
      .id,
  );
  const batch = {
    ...run.batch!,
    total: 3,
    currentDate: "2026-01-02",
    attempt: 1,
    items: [
      ...run.batch!.items,
      { date: "2026-01-02", status: "running", attempts: 1 },
      { date: "2026-01-03", status: "pending", attempts: 0 },
    ],
  };
  fixture.app.miracle.db.query(
    "UPDATE query_runs SET status='running',batch=?2 WHERE id=?1",
    [run.id, batch],
  );
  fixture.app.miracle.db.query(
    "UPDATE result_sets SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
    [run.resultSetId],
  );
  await fixture.app.close();
  const reopened = await buildApp({
    dataDir: fixture.dataDir,
    serveStatic: false,
  });
  cleanup.push(() => reopened.close());
  const recovered = reopened.miracle.db.query(
    "SELECT * FROM query_runs WHERE id=?1",
    [run.id],
  ).rows[0];
  expect(recovered.status).toBe("interrupted");
  expect(recovered.batch.items.map((item: any) => item.status)).toEqual([
    "completed",
    "interrupted",
    "interrupted",
  ]);
  expect(recovered.result_set_id).toBe(run.resultSetId);
  expect(recovered.row_count).toBe(1);
  expect(recovered.batch.succeeded).toBe(1);
  const recoveredResult = reopened.miracle.db.query(
    "SELECT * FROM result_sets WHERE id=?1",
    [run.resultSetId],
  ).rows[0];
  expect(recoveredResult.row_count).toBe(1);
  expect(Date.parse(recoveredResult.created_at)).toBeGreaterThan(
    Date.now() - 60000,
  );
});

it("retains a long-running batch result for a full retention window after completion", async () => {
  const release = deferred();
  const fixture = await setup(async (date) => {
    if (date === "2026-01-02") await release.promise;
    return {};
  });
  const run = await fixture.start();
  const partial = await fixture.wait(run.id, (r) => r.batch?.succeeded === 1);
  fixture.app.miracle.db.query(
    "UPDATE result_sets SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
    [partial.resultSetId],
  );
  release.resolve();
  const done = await fixture.wait(run.id);
  const { retention } = await import("../src/server/db.js");
  retention(fixture.app.miracle.db);
  const result = await fixture.request(
    "GET",
    `/api/result-sets/${done.resultSetId}/rows`,
  );
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().rows).toHaveLength(3);
});

it("refreshes an aggregate timestamp on append and retains it after cancellation", async () => {
  const second = deferred();
  const third = deferred();
  const fixture = await setup(async (date) => {
    if (date === "2026-01-02") await second.promise;
    if (date === "2026-01-03") await third.promise;
    return {};
  });
  const run = await fixture.start();
  const partial = await fixture.wait(run.id, (r) => r.batch?.succeeded === 1);
  const ageResult = () =>
    fixture.app.miracle.db.query(
      "UPDATE result_sets SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?1",
      [partial.resultSetId],
    );
  ageResult();
  second.resolve();
  await fixture.wait(run.id, (r) => r.batch?.succeeded === 2);
  const appended = fixture.app.miracle.db.query(
    "SELECT created_at FROM result_sets WHERE id=?1",
    [partial.resultSetId],
  ).rows[0];
  expect(Date.parse(appended.created_at)).toBeGreaterThan(Date.now() - 60000);
  ageResult();
  await fixture.request("POST", `/api/query-runs/${run.id}/cancel`, {});
  const done = await fixture.wait(run.id);
  third.resolve();
  expect(done.status).toBe("cancelled");
  const { retention } = await import("../src/server/db.js");
  retention(fixture.app.miracle.db);
  const result = await fixture.request(
    "GET",
    `/api/result-sets/${done.resultSetId}/rows`,
  );
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().rows).toEqual([["2026-01-01"], ["2026-01-02"]]);
});
