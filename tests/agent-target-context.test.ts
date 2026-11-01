import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import {
  AgentManager,
  type AgentToolServices,
} from "../src/server/agents/manager";
import { startAgentTurn } from "../src/server/agents/adapter";
import { serializeCustomChart } from "../src/shared/custom-charts";
import { callMiracleTool } from "../src/server/agents/tools";

vi.mock("../src/server/agents/adapter", () => ({
  startAgentTurn: vi.fn(() => ({
    completion: Promise.resolve(),
    cancel: vi.fn(),
    respond: vi.fn(),
  })),
}));
let root: string,
  db: Database,
  store: ProjectStore,
  operations: WorkspaceOperations,
  manager: AgentManager,
  chatId: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-agent-targets-")));
  const dataDir = join(root, ".miracle");
  mkdirSync(dataDir);
  vi.stubEnv("MIRACLE_INSTALL_ROOT", join(root, "install"));
  db = new Database(dataDir);
  migrate(db, () => {});
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    projectRoot: root,
    dataDir,
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
  operations = new WorkspaceOperations(store, async () => {});
  manager = new AgentManager(
    store,
    operations,
    {} as AgentToolServices,
    () => "http://127.0.0.1:3001",
  );
  const profile = store.saveProfile({
    name: "Stub",
    provider: "codex",
    command: "codex",
  });
  chatId = store.createChat({ profileId: profile.id }).id;
  vi.mocked(startAgentTurn).mockClear();
});
afterEach(async () => {
  await manager.close();
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const board = (title = "Selected chart") =>
  operations.createBoard({
    name: "Test board",
    document: {
      schemaVersion: 1,
      nodes: [
        {
          id: "selected-node",
          type: "artifact",
          position: { x: 0, y: 0 },
          data: { kind: "note", title, text: "Only this node" },
        },
      ],
      edges: [],
    },
  });
const payload = (context: unknown) => ({
  content: "Explain the referenced file and selected chart",
  clientRequestId: randomUUID(),
  context,
});

it("persists references and canonical selected-node titles and sends them to the CLI without reading file contents", async () => {
  writeFileSync(
    join(root, "notes with spaces.md"),
    "FILE_CONTENT_NOT_IN_PROMPT",
  );
  const selected = board();
  const turn = manager.start(
    chatId,
    payload({
      filePaths: ["notes with spaces.md"],
      boardId: selected.id,
      boardNodes: [{ id: "selected-node", title: "Client spoofed title" }],
    }),
  );
  const expected = {
    filePaths: ["notes with spaces.md"],
    boardId: selected.id,
    boardNodes: [{ id: "selected-node", title: "Selected chart" }],
  };
  expect(turn.context).toEqual(expected);
  expect(store.conversation(chatId).messages[0].details).toEqual({
    context: expected,
  });
  await manager.active!.completion;
  const options = vi.mocked(startAgentTurn).mock.calls[0][0];
  expect(options.cwd).toBe(root);
  expect(options.prompt).toContain('"filePaths":["notes with spaces.md"]');
  expect(options.prompt).toContain('"selectedNodes":[{"id":"selected-node"');
  expect(options.prompt).not.toContain("FILE_CONTENT_NOT_IN_PROMPT");
});

it("rejects stale or cross-board selected nodes and missing files before launching any process", () => {
  const selected = board();
  const other = operations.createBoard({ name: "Other board" });
  for (const context of [
    { boardNodes: [{ id: "selected-node", title: "Chart" }] },
    {
      boardId: other.id,
      boardNodes: [{ id: "selected-node", title: "Chart" }],
    },
    { boardId: selected.id, boardNodes: [{ id: "deleted", title: "Chart" }] },
    { filePaths: ["missing.md"] },
    { filePaths: [".miracle/encryption.key"] },
  ])
    expect(() => manager.start(chatId, payload(context))).toThrow();
  expect(startAgentTurn).not.toHaveBeenCalled();
  expect(store.conversation(chatId).turns).toHaveLength(0);
});

it("keeps accepted targets on retry after files or nodes change and rejects retargeting the same request ID", async () => {
  const path = join(root, "referenced.md");
  writeFileSync(path, "content");
  const selected = board();
  const request = payload({
    filePaths: ["referenced.md"],
    boardId: selected.id,
    boardNodes: [{ id: "selected-node", title: "Client title" }],
  });
  const turn = manager.start(chatId, request);
  await manager.active!.completion;
  rmSync(path);
  db.query("DELETE FROM boards WHERE id=?1", [selected.id]);
  const retry = manager.start(chatId, request);
  expect(retry.id).toBe(turn.id);
  expect(retry.context.boardNodes).toEqual([
    { id: "selected-node", title: "Selected chart" },
  ]);
  expect(startAgentTurn).toHaveBeenCalledTimes(1);
  expect(() =>
    manager.start(chatId, {
      ...request,
      context: {
        ...(request.context as object),
        boardNodes: [{ id: "different-node", title: "Chart" }],
      },
    }),
  ).toThrow(/уже использован/);
});

it("retains file and node references when rebuilding context after a native session is unavailable", async () => {
  writeFileSync(join(root, "first.md"), "content");
  const selected = board();
  manager.start(
    chatId,
    payload({
      filePaths: ["first.md"],
      boardId: selected.id,
      boardNodes: [{ id: "selected-node", title: "Chart" }],
    }),
  );
  await manager.active!.completion;
  db.query(
    "UPDATE agent_chats SET native_session_id='old-session' WHERE id=?1",
    [chatId],
  );
  vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
    completion: Promise.reject(
      Object.assign(new Error("expired"), {
        code: "AGENT_SESSION_UNAVAILABLE",
      }),
    ),
    cancel: async () => {},
    respond: () => {},
  }));
  manager.start(chatId, payload({}));
  await manager.active!.completion;
  const resumed = vi.mocked(startAgentTurn).mock.calls.at(-1)![0];
  expect(resumed.resumeSessionId).toBeUndefined();
  expect(resumed.prompt).toContain("first.md");
  expect(resumed.prompt).toContain("Selected chart");
});

it("summarizes the selected custom chart without embedding source and exposes its current status through MCP", async () => {
  const resultId = randomUUID();
  db.query(
    "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES(?1,?2,?3,?4,?5)",
    [resultId, [], 0, 0, { connectionId: randomUUID(), sql: "SELECT 1" }],
  );
  const selected = operations.createBoard({
    name: "Custom",
    document: {
      schemaVersion: 1,
      edges: [],
      nodes: [
        {
          id: "custom",
          type: "artifact",
          position: { x: 0, y: 0 },
          data: {
            title: "Selected custom",
            kind: "result",
            view: "custom",
            resultSetId: resultId,
            source: { connectionId: randomUUID(), sql: "SELECT 1" },
            customChart: {
              version: 1,
              description: "Descriptive summary",
              html: "<svg></svg>",
              css: "",
              javascript: "SOURCE_NOT_IN_PROMPT",
            },
          },
        },
      ],
    },
  });
  manager.start(
    chatId,
    payload({
      boardId: selected.id,
      boardNodes: [{ id: "custom", title: "Custom" }],
    }),
  );
  const active = manager.active!;
  const guide = callMiracleTool(manager, active, "custom_chart_guide", {});
  const status = callMiracleTool(manager, active, "read_custom_chart_status", {
    id: selected.id,
    nodeId: "custom",
  });
  const read = callMiracleTool(manager, active, "read_board", {
    id: selected.id,
  });
  const customChart = selected.document.nodes[0].data.customChart!;
  for (let i = 0; i < 150; i++)
    operations.reportCustomChartStatus(selected.id, "custom", {
      browserId: randomUUID(),
      sequence: 1,
      resultSetId: resultId,
      specHash: createHash("sha256")
        .update(serializeCustomChart(customChart))
        .digest("hex"),
      status: i === 149 ? "error" : "rendered",
      message: "x".repeat(4000),
    });
  const manyStatus = callMiracleTool(
    manager,
    active,
    "read_custom_chart_status",
    { id: selected.id, nodeId: "custom" },
  );
  const invalidPage = callMiracleTool(
    manager,
    active,
    "read_custom_chart_status",
    { id: selected.id, nodeId: "custom", limit: 21 },
  );
  const lastPage = callMiracleTool(
    manager,
    active,
    "read_custom_chart_status",
    { id: selected.id, nodeId: "custom", offset: 140, limit: 20 },
  );
  await Promise.all([
    expect(status).resolves.toEqual({
      status: "not_observed",
      reports: [],
      offset: 0,
      total: 0,
      nextOffset: null,
    }),
    expect(manyStatus).resolves.toMatchObject({
      status: "error",
      reports: { length: 10 },
      total: 150,
      nextOffset: 10,
    }),
    expect(lastPage).resolves.toMatchObject({
      status: "error",
      reports: { length: 10 },
      total: 150,
      nextOffset: null,
    }),
    expect(guide).resolves.toHaveProperty("example.javascript"),
    expect(invalidPage).rejects.toThrow(),
  ]);
  await expect(read).resolves.toMatchObject({
    document: {
      nodes: [
        { data: { customChart: { javascript: "SOURCE_NOT_IN_PROMPT" } } },
      ],
    },
  });
  const firstPage = (await manyStatus) as { reports: { status: string }[] };
  expect(
    firstPage.reports.every((report) => report.status === "rendered"),
  ).toBe(true);
  await active.completion;
  const options = vi.mocked(startAgentTurn).mock.calls[0][0];
  expect(options.prompt).not.toContain("SOURCE_NOT_IN_PROMPT");
  const context = JSON.parse(
    options.prompt.split("Project context (data):\n")[1].split("\n")[0],
  );
  expect(context.board.selectedNodes[0]).toMatchObject({
    view: "custom",
    customChart: { version: 1, description: "Descriptive summary" },
  });
  expect(context.board.selectedNodes[0].customChart).not.toHaveProperty(
    "javascript",
  );
});
