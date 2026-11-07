import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildApp } from "../src/server/app.js";
import { createServer, type ServerResponse } from "node:http";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});
async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
) {
  const deadline = Date.now() + 8000;
  let last: T;
  do {
    last = await read();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(last!)}`);
}
async function open() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "miracle-mcp-integration-")),
  );
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const control = join(root, "fixture-control");
  mkdirSync(control);
  const project = join(root, "project with spaces");
  mkdirSync(project);
  writeFileSync(join(project, "project-data.txt"), "project local fact");
  vi.stubEnv("MIRACLE_INSTALL_ROOT", join(root, "install"));
  let origin = "http://127.0.0.1:3001";
  const app = await buildApp({
    dataDir: join(project, ".miracle"),
    projectRoot: project,
    appOrigin: origin,
    runtimeOrigin: () => origin,
    serveStatic: false,
  });
  cleanup.push(() => app.close());
  origin = await app.listen({ port: 0, host: "127.0.0.1" });
  const sessionResponse = await fetch(`${origin}/api/session`);
  const session = (await sessionResponse.json()) as any;
  const headers = {
    cookie: sessionResponse.headers.get("set-cookie")!.split(";")[0]!,
    origin,
    "content-type": "application/json",
    "x-csrf-token": session.csrfToken,
    "x-miracle-workspace": session.workspaceId,
    "x-miracle-instance": session.instanceId,
  };
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(origin + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    expect(response.ok, JSON.stringify(data)).toBe(true);
    return data as any;
  };
  const start = async (workflow = false) => {
    const command = `FIXTURE_CONTROL='${control}' FIXTURE_WORKFLOW=${workflow ? 1 : 0} '${process.execPath}' '${resolve("tests/fixtures/agents/miracle-mcp-agent.mjs")}'`;
    const profile = await request("POST", "/api/agent-profiles", {
      name: "MCP integration",
      provider: "claude",
      command,
    });
    const chat = await request("POST", "/api/chats", { profileId: profile.id });
    const turn = await request("POST", `/api/chats/${chat.id}/messages`, {
      content: "Use the project file, SQL and board",
      context: {},
      clientRequestId: randomUUID(),
    });
    await until(() => existsSync(join(control, "capability.json")), Boolean);
    const capability = JSON.parse(
      readFileSync(join(control, "capability.json"), "utf8"),
    );
    let sequence = 0;
    const mcpResponse = (name: string, args = {}, extraHeaders = {}) =>
      fetch(capability.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${capability.token}`,
          ...extraHeaders,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++sequence,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
    const mcp = async (name: string, args = {}) => {
      const response = await mcpResponse(name, args);
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      const value = JSON.parse(body.result.content[0].text);
      expect(body.result.isError, JSON.stringify(value)).toBe(false);
      return value;
    };
    const waitResult = async () => {
      await until(
        () =>
          existsSync(join(control, "result.json")) ||
          existsSync(join(control, "failure.txt")),
        Boolean,
      );
      if (existsSync(join(control, "failure.txt")))
        throw new Error(readFileSync(join(control, "failure.txt"), "utf8"));
      return JSON.parse(readFileSync(join(control, "result.json"), "utf8"));
    };
    return { profile, chat, turn, capability, mcpResponse, mcp, waitResult };
  };
  const release = () => writeFileSync(join(control, "release"), "");
  return {
    app,
    project,
    control,
    origin,
    headers,
    session,
    request,
    start,
    release,
  };
}
async function addEngine(
  s: Awaited<ReturnType<typeof open>>,
  respond?: (sql: string, response: ServerResponse) => boolean,
) {
  const executedSql: string[] = [];
  const server = createServer(async (req, res) => {
    let sql = "";
    for await (const part of req) sql += part;
    executedSql.push(sql);
    if (respond?.(sql, res)) return;
    const compact = (names: string[], types: string[], rows: unknown[][]) =>
      res.end(
        [names, types, ...rows].map((v) => JSON.stringify(v)).join("\n") + "\n",
      );
    if (sql.startsWith("KILL")) return res.end("");
    if (sql.includes("sleepEachRow")) {
      setTimeout(() => compact(["n"], ["UInt8"], [[1]]), 1500).unref();
      return;
    }
    if (sql.includes("system.columns"))
      return compact(
        ["table", "name", "type", "position"],
        ["String", "String", "String", "UInt64"],
        [["sales", "customer_id", "UInt64", 1]],
      );
    if (sql.includes("toUInt64"))
      return compact(
        ["exact", "n"],
        ["UInt64", "UInt8"],
        [["9007199254740993", 1]],
      );
    if (sql.includes("chart-controls"))
      return compact(
        ["month", "revenue", "region"],
        ["String", "Float64", "String"],
        [
          ["Jan", 10, "North"],
          ["Jan", 20, "South"],
        ],
      );
    return compact(["n"], ["UInt8"], [[1]]);
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
  const engine = { url: `http://127.0.0.1:${address.port}` };
  const connection = await s.request("POST", "/api/connections", {
    name: "Test ClickHouse",
    engine: "clickhouse",
    url: engine.url,
    username: "local_reader",
    password: "source-secret-never-in-context",
    database: "demo",
  });
  return { connection, executedSql };
}

it("exposes chart appearance and geometry controls through the actual MCP discovery and guide", async () => {
  const s = await open();
  const agent = await s.start();
  const response = await fetch(agent.capability.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${agent.capability.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "chart-discovery",
      method: "tools/list",
    }),
  });
  expect(response.status).toBe(200);
  const { result } = (await response.json()) as any;
  const guideTool = result.tools.find(
    (tool: any) => tool.name === "chart_guide",
  );
  expect(guideTool).toBeDefined();
  expect(guideTool.annotations.readOnlyHint).toBe(true);
  const patchTool = result.tools.find(
    (tool: any) => tool.name === "board_patch",
  );
  const patch =
    patchTool.inputSchema.properties.operations.items.properties.patch
      .properties;
  expect(patch.width.type).toBe("number");
  expect(patch.height.type).toBe("number");
  const chart = patch.data.properties.chart;
  for (const setting of ["showXAxis", "showYAxis", "showGrid", "showLabels"]) {
    expect(chart.properties[setting].type).toBe("boolean");
    expect(chart.required).not.toContain(setting);
  }
  expect(chart.properties.labelPosition.enum).toEqual([
    "auto",
    "outside",
    "inside",
  ]);
  expect(chart.properties.palette.enum).toEqual([
    "default",
    "cool",
    "warm",
    "vivid",
  ]);
  expect(chart.properties.seriesColors.type).toBe("object");
  expect(chart.properties.orientation.enum).toEqual(["vertical", "horizontal"]);
  expect(chart.properties.legend.type).toBe("boolean");
  expect(chart.properties.numberFormat.enum).toContain("compact");
  const guide = JSON.stringify(await agent.mcp("chart_guide"));
  for (const setting of [
    "showXAxis",
    "showYAxis",
    "showGrid",
    "showLabels",
    "labelPosition",
    "palette",
    "seriesColors",
    "width",
    "height",
  ])
    expect(guide).toContain(setting);
  expect(guide).toContain("baseRevision");
  s.release();
});

it("round-trips chart controls, resets and proportional sizes through MCP without re-running SQL", async () => {
  const s = await open();
  const { connection, executedSql } = await addEngine(s);
  const agent = await s.start();
  const source = {
    connectionId: connection.id,
    sql: "SELECT 'Jan' AS month, 10 AS revenue, 'North' AS region /* chart-controls */",
  };
  const run = await agent.mcp("run_query", {
    ...source,
    mutationId: randomUUID(),
  });
  const done = await until(
    () => agent.mcp("query_status", { id: run.id }),
    (state) => state.status === "completed",
  );
  const page = await agent.mcp("read_result", { id: done.resultSetId });
  const columnId = (name: string) =>
    page.result.columns.find((column: any) => column.name === name).id;
  const chart = {
    kind: "bar",
    x: columnId("month"),
    y: [columnId("revenue")],
    series: columnId("region"),
    legend: true,
  };
  let board = await agent.mcp("create_board", {
    name: "MCP chart controls",
    mutationId: randomUUID(),
    document: {
      schemaVersion: 1,
      nodes: [
        {
          id: "chart",
          type: "artifact",
          position: { x: 15, y: 30 },
          width: 480,
          height: 320,
          data: {
            title: "Revenue",
            kind: "result",
            view: "chart",
            resultSetId: done.resultSetId,
            source,
            chart,
          },
        },
      ],
      edges: [],
    },
  });
  const original = await agent.mcp("read_board", { id: board.id });
  const originalNode = original.document.nodes[0];
  const colors = {
    [JSON.stringify([chart.y[0], chart.series, "North"])]: "#aabbcc",
    [JSON.stringify([chart.y[0], chart.series, "South"])]: "#123456",
  };
  const styled = {
    ...chart,
    orientation: "horizontal",
    stacked: true,
    showXAxis: false,
    showYAxis: false,
    showGrid: false,
    showLabels: true,
    labelPosition: "inside",
    palette: "warm",
    seriesColors: colors,
    numberFormat: "compact",
    sort: "desc",
    legendPosition: "right",
    legendAlign: "end",
  };
  const patch = async (data: unknown) =>
    agent.mcp("board_patch", {
      id: board.id,
      baseRevision: board.revision,
      mutationId: randomUUID(),
      operations: [{ type: "update_node", id: "chart", patch: data }],
    });
  board = await patch({ data: { chart: styled } });
  let reread = await agent.mcp("read_board", { id: board.id });
  expect(reread.document.nodes[0]).toEqual({
    ...originalNode,
    data: { ...originalNode.data, chart: styled },
  });
  board = await patch({
    width: originalNode.width * 1.5,
    height: originalNode.height * 1.5,
  });
  reread = await agent.mcp("read_board", { id: board.id });
  expect(reread.document.nodes[0]).toEqual({
    ...originalNode,
    width: 720,
    height: 480,
    data: { ...originalNode.data, chart: styled },
  });
  expect(reread.document.nodes[0].width / reread.document.nodes[0].height).toBe(
    originalNode.width / originalNode.height,
  );
  const invalid = await agent.mcpResponse("board_patch", {
    id: board.id,
    baseRevision: board.revision,
    mutationId: randomUUID(),
    operations: [
      {
        type: "update_node",
        id: "chart",
        patch: { data: { chart: { ...styled, seriesColors: { bad: "red" } } } },
      },
    ],
  });
  expect(invalid.status).toBe(200);
  expect(((await invalid.json()) as any).result.isError).toBe(true);
  expect(await agent.mcp("read_board", { id: board.id })).toEqual(reread);
  const stale = await agent.mcpResponse("board_patch", {
    id: board.id,
    baseRevision: original.revision,
    mutationId: randomUUID(),
    operations: [
      { type: "update_node", id: "chart", patch: { width: 600, height: 400 } },
    ],
  });
  const conflict = ((await stale.json()) as any).result;
  expect(conflict.isError).toBe(true);
  expect(JSON.parse(conflict.content[0].text).code).toBe("REVISION_CONFLICT");
  expect(await agent.mcp("read_board", { id: board.id })).toEqual(reread);
  const reset = {
    ...styled,
    showXAxis: true,
    showYAxis: true,
    showGrid: true,
    showLabels: false,
    labelPosition: "auto",
    palette: "default",
    seriesColors: {},
  };
  board = await patch({ data: { chart: reset } });
  reread = await agent.mcp("read_board", { id: board.id });
  expect(reread.document.nodes[0].data.chart).toEqual(reset);
  expect(reread.document.nodes[0]).toMatchObject({
    width: 720,
    height: 480,
    position: originalNode.position,
  });
  expect(
    executedSql.filter((sql) => sql.includes("chart-controls")),
  ).toHaveLength(1);
  s.release();
});

it("executes a subprocess MCP workflow against persisted SQL, query results and board operations", async () => {
  const s = await open();
  const { connection, executedSql } = await addEngine(s);
  const agent = await s.start(true);
  const result = await agent.waitResult();
  expect(result.cwd).toBe(s.project);
  expect(result.fileText).toBe("project local fact");
  expect(result.context.projectRoot).toBe(s.project);
  expect(result.connections).toMatchObject([
    { id: connection.id, name: "Test ClickHouse" },
  ]);
  expect(JSON.stringify(result)).not.toContain(
    "source-secret-never-in-context",
  );
  expect(result.schema.items).toEqual([
    { table: "sales", name: "customer_id", type: "UInt64", position: 1 },
  ]);
  expect(result.editor).toMatchObject({
    sql: "SELECT toUInt64(9007199254740993) AS exact, 1 AS n",
    revision: 2,
  });
  expect(result.repeatedEdit).toEqual(result.editor);
  expect(result.staleEdit).toMatchObject({
    isError: true,
    value: { code: "REVISION_CONFLICT" },
  });
  expect(result.repeatedRun.id).toBe(result.run.id);
  expect(executedSql.filter((sql) => sql.includes("toUInt64"))).toHaveLength(1);
  expect(result.result.rows).toEqual([["9007199254740993", 1]]);
  expect(result.staleBoard).toMatchObject({
    isError: true,
    value: { code: "REVISION_CONFLICT" },
  });
  const board = await s.request("GET", `/api/boards/${result.board.id}`);
  expect(board.document.nodes).toMatchObject([
    { id: "result", position: { x: 400, y: 250 }, width: 600, height: 300 },
    { id: "note", data: { text: "project local fact" } },
  ]);
  expect(board.document.edges).toEqual([
    { id: "link", source: "result", target: "note" },
  ]);
  expect(board.revision).toBe(result.repeatedBoard.revision + 1);
  expect(
    (await s.request("GET", "/api/queries")).map((q: any) => q.id),
  ).toEqual([result.saved.id]);
  expect(await s.request("GET", "/api/editor-documents")).toEqual([
    result.editor,
  ]);
  s.release();
  const conversation = await until(
    () => s.request("GET", `/api/chats/${agent.chat.id}`),
    (c) => c.turns[0].status === "completed",
  );
  expect(
    conversation.messages.find((m: any) => m.role === "assistant").content,
  ).toBe("MCP workflow complete");
  expect(
    conversation.messages.filter((m: any) => m.role === "action").length,
  ).toBeGreaterThan(10);
  expect((await agent.mcpResponse("project_context")).status).toBe(401);
});

it("rejects foreign capabilities and origins, enforces read-only SQL and cancels only owned query work", async () => {
  const s = await open();
  const { connection } = await addEngine(s);
  const agent = await s.start();
  expect(
    (
      await agent.mcpResponse(
        "project_context",
        {},
        { authorization: "Bearer wrong-token" },
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await agent.mcpResponse(
        "project_context",
        {},
        { origin: "http://foreign.test" },
      )
    ).status,
  ).toBe(403);
  const other = await open();
  const crossProject = await fetch(`${other.origin}/agent/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${agent.capability.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  expect(crossProject.status).toBe(401);
  const denied = await agent.mcpResponse("run_query", {
    connectionId: connection.id,
    sql: "DROP TABLE sales",
    mutationId: randomUUID(),
  });
  expect(((await denied.json()) as any).result.isError).toBe(true);
  const source = {
    connectionId: connection.id,
    sql: "SELECT sleepEachRow(1)",
    mutationId: randomUUID(),
  };
  const owned = await agent.mcp("run_query", source);
  expect((await agent.mcp("run_query", source)).id).toBe(owned.id);
  const manual = await s.request("POST", "/api/query-runs", {
    connectionId: connection.id,
    sql: "SELECT sleepEachRow(1)",
    chatId: agent.chat.id,
    turnId: agent.turn.id,
    agentChatId: agent.chat.id,
    agentTurnId: agent.turn.id,
  });
  expect(
    await s.request("GET", `/api/chats/${agent.chat.id}/sql-activity`),
  ).toMatchObject({
    activeCount: 1,
    runs: [
      {
        id: owned.id,
        chatId: agent.chat.id,
        turnId: agent.turn.id,
        sql: source.sql,
        status: "running",
      },
    ],
  });
  const otherChat = await s.request("POST", "/api/chats", {
    profileId: agent.profile.id,
  });
  expect(
    await s.request("GET", `/api/chats/${otherChat.id}/sql-activity`),
  ).toEqual({ activeCount: 0, runs: [] });
  await s.request("POST", `/api/agent-turns/${agent.turn.id}/cancel`, {});
  const ownedStatus = await until(
    () => s.request("GET", `/api/query-runs/${owned.id}`),
    (r) => !["running", "cancelling"].includes(r.status),
  );
  expect(ownedStatus.status).toBe("cancelled");
  const activity = await s.request(
    "GET",
    `/api/chats/${agent.chat.id}/sql-activity`,
  );
  expect(activity.activeCount).toBe(0);
  expect(activity.runs).toHaveLength(1);
  expect(activity.runs[0]).toMatchObject({ id: owned.id, status: "cancelled" });
  const manualStatus = await until(
    () => s.request("GET", `/api/query-runs/${manual.id}`),
    (r) => !["running", "cancelling"].includes(r.status),
  );
  expect(manualStatus.status).toBe("completed");
  expect((await agent.mcpResponse("project_context")).status).toBe(401);
  const state = await s.request("GET", `/api/chats/${agent.chat.id}`);
  expect(state.turns[0].status).toBe("cancelled");
});

it("retains agent date-batch ownership and actual progress after turn completion and restart", async () => {
  const s = await open();
  let fail = true;
  const { connection, executedSql } = await addEngine(s, (sql, response) => {
    if (fail && sql.includes("'2026-11-02'")) {
      response.writeHead(500);
      response.end("Synthetic date failure");
      return true;
    }
    return false;
  });
  const agent = await s.start();
  const run = await agent.mcp("run_query", {
    connectionId: connection.id,
    sql: "SELECT {{date}} AS day",
    dateRange: {
      startDate: "2026-11-01",
      endDate: "2026-11-03",
      granularity: "day",
      retries: 1,
    },
    mutationId: randomUUID(),
  });
  await until(
    () => s.request("GET", `/api/query-runs/${run.id}`),
    (value) => value.status === "paused",
  );
  s.release();
  await until(
    () => s.request("GET", `/api/chats/${agent.chat.id}`),
    (value) => value.turns[0].status === "completed",
  );
  const paused = await s.request(
    "GET",
    `/api/chats/${agent.chat.id}/sql-activity`,
  );
  expect(paused).toMatchObject({
    activeCount: 0,
    runs: [
      {
        id: run.id,
        chatId: agent.chat.id,
        turnId: agent.turn.id,
        status: "paused",
        sql: "SELECT {{date}} AS day",
        dateBatch: {
          total: 3,
          completed: 1,
          succeeded: 1,
          failed: 1,
          currentDate: "2026-11-02",
          attempt: 2,
          maxAttempts: 2,
          currentStatus: "failed",
        },
      },
    ],
  });
  expect(paused.runs[0].dateBatch).not.toHaveProperty("items");
  expect(paused.runs[0].durationMs).toBeGreaterThanOrEqual(0);
  await s.app.close();
  const reopened = await buildApp({
    projectRoot: s.project,
    dataDir: join(s.project, ".miracle"),
    appOrigin: "http://127.0.0.1:3001",
    serveStatic: false,
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
  const activity = async () =>
    (
      await reopened.inject({
        url: `/api/chats/${agent.chat.id}/sql-activity`,
        headers,
      })
    ).json();
  expect(await activity()).toEqual(paused);
  fail = false;
  const resumed = await reopened.inject({
    method: "POST",
    url: `/api/query-runs/${run.id}/resume`,
    headers,
    payload: {},
  });
  expect(resumed.statusCode, resumed.body).toBe(202);
  const completed = await until(
    activity,
    (value) => value.runs[0].status === "completed",
  );
  expect(completed).toMatchObject({
    activeCount: 0,
    runs: [
      {
        id: run.id,
        chatId: agent.chat.id,
        turnId: agent.turn.id,
        dateBatch: { total: 3, completed: 3, succeeded: 3, failed: 0 },
      },
    ],
  });
  expect(
    executedSql.filter((sql) => sql.includes("'2026-11-01'")),
  ).toHaveLength(1);
});

it("keeps SQL active after the agent finishes without attributing replayed manual runs", async () => {
  const s = await open();
  let pending: ServerResponse | undefined;
  const { connection } = await addEngine(s, (sql, response) => {
    if (sql.includes("activity-hold")) {
      pending = response;
      return true;
    }
    return false;
  });
  const manualSource = {
    connectionId: connection.id,
    sql: "SELECT 1",
    mutationId: randomUUID(),
  };
  const manual = await s.request("POST", "/api/query-runs", manualSource);
  await until(
    () => s.request("GET", `/api/query-runs/${manual.id}`),
    (run) => run.status === "completed",
  );
  const agent = await s.start();
  expect((await agent.mcp("run_query", manualSource)).id).toBe(manual.id);
  await agent.mcp("read_schema", {
    connectionId: connection.id,
    kind: "columns",
    schema: "demo",
    table: "sales",
  });
  expect(
    await s.request("GET", `/api/chats/${agent.chat.id}/sql-activity`),
  ).toEqual({ activeCount: 0, runs: [] });
  const source = {
    connectionId: connection.id,
    sql: "SELECT 2 /* activity-hold */",
    mutationId: randomUUID(),
  };
  const owned = await agent.mcp("run_query", source);
  s.release();
  await until(
    () => s.request("GET", `/api/chats/${agent.chat.id}`),
    (chat) => chat.turns[0].status === "completed",
  );
  const active = await s.request(
    "GET",
    `/api/chats/${agent.chat.id}/sql-activity`,
  );
  expect(active).toMatchObject({
    activeCount: 1,
    runs: [{ id: owned.id, status: "running", turnId: agent.turn.id }],
  });
  expect(active.runs).toHaveLength(1);
  expect((await s.request("POST", "/api/query-runs", source)).id).toBe(
    owned.id,
  );
  expect(
    await s.request("GET", `/api/chats/${agent.chat.id}/sql-activity`),
  ).toEqual(active);
  expect(pending).toBeDefined();
  pending!.end('["n"]\n["UInt8"]\n[2]\n');
  const completed = await until(
    () => s.request("GET", `/api/chats/${agent.chat.id}/sql-activity`),
    (activity) => activity.activeCount === 0,
  );
  expect(completed.runs[0]).toMatchObject({
    id: owned.id,
    status: "completed",
    turnId: agent.turn.id,
  });
  expect(completed.runs[0].finishedAt).toBeDefined();
});

it("attributes refreshed nodes and bounds terminal history without dropping unfinished work", async () => {
  const s = await open();
  const { connection } = await addEngine(s);
  const agent = await s.start();
  const source = { connectionId: connection.id, sql: "SELECT 1" };
  const initial = await agent.mcp("run_query", {
    ...source,
    mutationId: randomUUID(),
  });
  const done = await until(
    () => agent.mcp("query_status", { id: initial.id }),
    (run) => run.status === "completed",
  );
  const board = await agent.mcp("create_board", {
    name: "SQL activity",
    mutationId: randomUUID(),
    document: {
      schemaVersion: 1,
      nodes: [
        {
          id: "result",
          type: "artifact",
          position: { x: 0, y: 0 },
          data: {
            kind: "result",
            title: "Result",
            view: "table",
            resultSetId: done.resultSetId,
            source,
          },
        },
      ],
      edges: [],
    },
  });
  const args = {
    id: board.id,
    nodeId: "result",
    sourceRevision: board.document.nodes[0].data.sourceRevision || 0,
    mutationId: randomUUID(),
  };
  const refreshed = await agent.mcp("refresh_node", args);
  expect((await agent.mcp("refresh_node", args)).id).toBe(refreshed.id);
  await until(
    () => agent.mcp("query_status", { id: refreshed.id }),
    (run) => run.status === "completed",
  );
  const owned = await s.request(
    "GET",
    `/api/chats/${agent.chat.id}/sql-activity`,
  );
  expect(new Set(owned.runs.map((run: any) => run.id))).toEqual(
    new Set([initial.id, refreshed.id]),
  );
  expect(
    owned.runs.every(
      (run: any) =>
        run.chatId === agent.chat.id && run.turnId === agent.turn.id,
    ),
  ).toBe(true);
  const db = s.app.miracle.db;
  for (let index = 0; index < 30; index++) {
    for (const status of ["paused", "completed"]) {
      const id = `${status}-${index}`;
      db.query(
        "INSERT INTO query_runs(id,status,source,started_at) VALUES(?1,?2,?3,?4)",
        [
          id,
          status,
          source,
          `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        ],
      );
      db.query(
        "INSERT INTO agent_query_runs(run_id,chat_id,turn_id) VALUES(?1,?2,?3)",
        [id, agent.chat.id, agent.turn.id],
      );
    }
  }
  const activity = await s.request(
    "GET",
    `/api/chats/${agent.chat.id}/sql-activity`,
  );
  expect(activity.activeCount).toBe(0);
  expect(
    activity.runs.filter((run: any) => run.status === "paused"),
  ).toHaveLength(30);
  expect(
    activity.runs.filter((run: any) => run.status === "completed"),
  ).toHaveLength(20);
  expect(activity.runs.some((run: any) => run.id === "completed-0")).toBe(
    false,
  );
  s.release();
});

it("replays persisted events after reconnect without replaying their mutations", async () => {
  const s = await open();
  const editor = await s.request("POST", "/api/editor-documents", {
    name: "events.sql",
    sql: "SELECT 1",
    connectionId: "",
  });
  async function eventAfter(after: number, expectedSql: string) {
    const controller = new AbortController();
    try {
      const response = await fetch(`${s.origin}/api/events?after=${after}`, {
        headers: s.headers,
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const part = await reader.read();
        if (part.done) throw new Error("Events ended before update");
        buffer += decoder.decode(part.value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop()!;
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));
          if (
            event.type === "editor.updated" &&
            event.entityId === editor.id &&
            event.data.sql === expectedSql
          )
            return event;
        }
      }
    } finally {
      controller.abort();
    }
  }
  const first = await eventAfter(0, "SELECT 1");
  const patch = {
    baseRevision: editor.revision,
    mutationId: randomUUID(),
    sql: "SELECT 2",
  };
  await s.request("PATCH", `/api/editor-documents/${editor.id}`, patch);
  await s.request("PATCH", `/api/editor-documents/${editor.id}`, patch);
  const second = await eventAfter(first.id, "SELECT 2");
  expect(second.id).toBeGreaterThan(first.id);
  expect(second.data.revision).toBe(2);
  expect(
    (await s.request("GET", `/api/editor-documents/${editor.id}`)).revision,
  ).toBe(2);
  const unauthorized = await fetch(`${s.origin}/api/events`);
  expect(unauthorized.status).toBe(401);
});

it("acknowledges large committed mutations and rereads exact documents through bounded chunks", async () => {
  const s = await open();
  const { connection } = await addEngine(s);
  const agent = await s.start();
  const sql = `SELECT 1 /*${" ".repeat(520000)}END*/`;
  const missingId = await agent.mcpResponse("create_editor", {
    name: "missing-id.sql",
    sql,
    connectionId: connection.id,
  });
  expect(((await missingId.json()) as any).result.isError).toBe(true);
  expect(await s.request("GET", "/api/editor-documents")).toHaveLength(0);
  const input = {
    id: randomUUID(),
    name: "large.sql",
    sql,
    connectionId: connection.id,
  };
  const created = await agent.mcp("create_editor", input);
  expect(created).toMatchObject({ id: input.id, revision: 1, compact: true });
  expect(await agent.mcp("create_editor", input)).toEqual(created);
  expect(await s.request("GET", "/api/editor-documents")).toHaveLength(1);
  async function readSql(tool: string, id: string) {
    let text = "",
      offset: number | null = 0;
    while (offset !== null) {
      const page = await agent.mcp(tool, { id, offset, limit: 64000 });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        512000,
      );
      expect(page.sqlOffset).toBe(offset);
      text += page.sql;
      offset = page.nextOffset;
    }
    return text;
  }
  expect(await readSql("read_editor", input.id)).toBe(sql);
  const changedSql = `${sql}\nSELECT 2`;
  const edited = await agent.mcp("edit_editor", {
    id: input.id,
    sql: changedSql,
    baseRevision: 1,
    mutationId: randomUUID(),
  });
  expect(edited).toMatchObject({ id: input.id, revision: 2, compact: true });
  expect(await readSql("read_editor", input.id)).toBe(changedSql);
  const saved = await agent.mcp("save_query", {
    name: "Large query",
    sql,
    connectionId: connection.id,
    mutationId: randomUUID(),
  });
  expect(saved).toMatchObject({ revision: 1, compact: true });
  const listed = await agent.mcp("list_queries");
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    id: saved.id,
    name: "Large query",
    sqlLength: sql.length,
  });
  expect(listed[0]).not.toHaveProperty("sql");
  expect(await readSql("read_query", saved.id)).toBe(sql);
  const run = await agent.mcp("run_query", {
    connectionId: connection.id,
    sql,
    mutationId: randomUUID(),
  });
  expect(run).toMatchObject({ compact: true });
  const finished = await until(
    () => agent.mcp("query_status", { id: run.id }),
    (state) => state.status === "completed",
  );
  const resultPage = await agent.mcp("read_result", {
    id: finished.resultSetId,
    limit: 10,
  });
  expect(resultPage.rows).toEqual([[1]]);
  expect(resultPage.result.source.sqlLength).toBe(sql.length);
  expect(resultPage.result.source).not.toHaveProperty("sql");

  const nodes = ["a", "b", "c"].map((id) => ({
    id,
    type: "artifact",
    position: { x: 0, y: 0 },
    data: { kind: "note", title: id, text: id.repeat(190000) },
  }));
  const board = await agent.mcp("create_board", {
    name: "Large board",
    document: { schemaVersion: 1, nodes, edges: [] },
    mutationId: randomUUID(),
  });
  expect(board).toMatchObject({ revision: 1, compact: true });
  const patched = await agent.mcp("board_patch", {
    id: board.id,
    baseRevision: 1,
    mutationId: randomUUID(),
    operations: [
      { type: "update_node", id: "b", patch: { position: { x: 40, y: 70 } } },
    ],
  });
  expect(patched).toMatchObject({ id: board.id, revision: 2, compact: true });
  expect(await agent.mcp("read_board", { id: board.id })).toMatchObject({
    id: board.id,
    revision: 2,
    compact: true,
  });
  let document = "",
    offset: number | null = 0;
  while (offset !== null) {
    const page = await agent.mcp("read_board", {
      id: board.id,
      format: "json",
      offset,
      limit: 64000,
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(512000);
    expect(page.offset).toBe(offset);
    document += page.json;
    offset = page.nextOffset;
  }
  const reread = JSON.parse(document);
  expect(reread.nodes.map((n: any) => n.data.text)).toEqual(
    nodes.map((n) => n.data.text),
  );
  expect(reread.nodes[1].position).toEqual({ x: 40, y: 70 });
  s.release();
});
