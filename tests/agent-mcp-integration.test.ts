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
import { createServer } from "node:http";

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
async function addEngine(s: Awaited<ReturnType<typeof open>>) {
  const executedSql: string[] = [];
  const server = createServer(async (req, res) => {
    let sql = "";
    for await (const part of req) sql += part;
    executedSql.push(sql);
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
  const owned = await agent.mcp("run_query", {
    connectionId: connection.id,
    sql: "SELECT sleepEachRow(1)",
    mutationId: randomUUID(),
  });
  const manual = await s.request("POST", "/api/query-runs", {
    connectionId: connection.id,
    sql: "SELECT sleepEachRow(1)",
  });
  await s.request("POST", `/api/agent-turns/${agent.turn.id}/cancel`, {});
  const ownedStatus = await until(
    () => s.request("GET", `/api/query-runs/${owned.id}`),
    (r) => !["running", "cancelling"].includes(r.status),
  );
  expect(ownedStatus.status).toBe("cancelled");
  const manualStatus = await until(
    () => s.request("GET", `/api/query-runs/${manual.id}`),
    (r) => !["running", "cancelling"].includes(r.status),
  );
  expect(manualStatus.status).toBe("completed");
  expect((await agent.mcpResponse("project_context")).status).toBe(401);
  const state = await s.request("GET", `/api/chats/${agent.chat.id}`);
  expect(state.turns[0].status).toBe("cancelled");
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
