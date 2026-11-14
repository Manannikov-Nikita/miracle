import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import {
  AgentManager,
  type AgentToolServices,
} from "../src/server/agents/manager";
import { callMiracleTool } from "../src/server/agents/tools";
import { createEmptyVisualTable } from "../src/shared/visual-table";

let root: string, db: Database, store: ProjectStore;
let operations: WorkspaceOperations, manager: AgentManager;
let chatId: string, boardId: string;

const node = (id: string) => ({
  id,
  type: "artifact",
  position: { x: 0, y: 0 },
  data: { kind: "note", title: id, text: "initial" },
});

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-board-workers-")));
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
    () => "http://127.0.0.1",
  );
  const profile = store.saveProfile({
    name: "Board worker fixture",
    provider: "claude",
    command: `FIXTURE_CONTROL='${root}' '${process.execPath}' '${resolve("tests/fixtures/agents/board-worker.mjs")}'`,
  });
  chatId = store.createChat({ profileId: profile.id }).id;
  boardId = operations.createBoard({
    name: "Planning",
    document: {
      schemaVersion: 1,
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [{ id: "ab", source: "a", target: "b" }],
    },
  }).id;
});

afterEach(async () => {
  await manager?.close();
  store?.close();
  db?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

type Peer = { token: string; pid: number; args: string[]; prompt: string };
async function peer(name: string): Promise<Peer> {
  let result!: Peer;
  await vi.waitFor(
    () => {
      result = JSON.parse(readFileSync(join(root, name + ".json"), "utf8"));
    },
    { timeout: 8000 },
  );
  return result;
}

async function start() {
  manager.start(chatId, {
    content: "Root request",
    clientRequestId: randomUUID(),
  });
  return peer("root");
}

const assignment = (name: string, id: string) => ({
  id: boardId,
  nodeIds: [id],
  name,
  task: "Edit the assigned block",
  mutationId: randomUUID(),
});
const target = (id: string) => ({ kind: "board-node" as const, boardId, id });
const patch = (id: string, text: string) => ({
  id: boardId,
  baseRevision: operations.board(boardId).revision,
  mutationId: randomUUID(),
  operations: [{ type: "update_node", id, patch: { data: { text } } }],
});
function finish(name: string) {
  writeFileSync(join(root, name + ".finish"), "");
}

it("isolates subprocess capabilities, queues expanded overlapping claims, and deduplicates assignments", async () => {
  const parent = await start();
  const active = manager.active!;
  const requestA = assignment("first", "a");
  const a = manager.startBoardTask(active, requestA);
  const b = manager.startBoardTask(active, assignment("overlap", "b"));
  const c = manager.startBoardTask(active, assignment("second", "c"));
  const d = manager.startBoardTask(active, assignment("fourth", "d"));
  const [first, second] = await Promise.all([peer("first"), peer("second")]);
  expect(new Set([parent.pid, first.pid, second.pid]).size).toBe(3);
  expect(new Set([parent.token, first.token, second.token]).size).toBe(3);
  expect(first.prompt).not.toContain("Root request");
  expect(first.args).not.toContain("--resume");
  expect(first.args).toContain("--strict-mcp-config");
  expect(first.args[first.args.indexOf("--tools") + 1]).toBe("AskUserQuestion");
  expect(manager.startBoardTask(active, requestA)).toMatchObject({ id: a.id });
  expect(() =>
    manager.startBoardTask(active, { ...requestA, task: "Different" }),
  ).toThrow(expect.objectContaining({ code: "MUTATION_CONFLICT" }));
  await expect(
    manager.boardTaskStatus(active, { taskId: b.id }),
  ).resolves.toMatchObject({ status: "queued" });
  await expect(
    manager.boardTaskStatus(active, { taskId: d.id }),
  ).resolves.toMatchObject({ status: "queued" });
  const firstAgent = manager.authenticate(`Bearer ${first.token}`);
  const secondAgent = manager.authenticate(`Bearer ${second.token}`);
  expect(firstAgent.worker).toMatchObject({
    name: "first",
    nodeIds: ["a"],
    edgeIds: ["ab"],
  });
  expect(firstAgent.worker?.color).not.toBe(secondAgent.worker?.color);
  expect(
    store.work
      .snapshot()
      .locks.map(({ target, worker }) => [target.id, worker?.name])
      .sort(),
  ).toEqual([
    ["a", "first"],
    ["ab", "first"],
    ["c", "second"],
  ]);
  expect(() =>
    store.work.runAs(manager.workActor(active), () =>
      operations.patchBoard(boardId, patch("a", "root")),
    ),
  ).toThrow(expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }));
  expect(() =>
    store.work.runAs(manager.workActor(secondAgent), () =>
      operations.patchBoard(boardId, patch("a", "sibling")),
    ),
  ).toThrow(expect.objectContaining({ code: "AGENT_WORK_SCOPE" }));
  expect(() =>
    store.work.runAs(manager.workActor(firstAgent), () =>
      operations.patchBoard(boardId, patch("d", "escape")),
    ),
  ).toThrow(expect.objectContaining({ code: "AGENT_WORK_SCOPE" }));
  store.work.runAs(manager.workActor(firstAgent), () =>
    store.work.end([target("a")]),
  );
  expect(() => operations.patchBoard(boardId, patch("a", "user"))).toThrow(
    expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }),
  );
  store.work.runAs(manager.workActor(firstAgent), () =>
    operations.patchBoard(boardId, patch("a", "allowed")),
  );
  finish("first");
  const completed = await manager.boardTaskStatus(active, {
    taskId: a.id,
    waitMs: 5000,
  });
  expect(completed).toMatchObject({
    status: "completed",
    summary: expect.stringContaining("fixture finished"),
  });
  expect(
    "summary" in completed && completed.summary?.length,
  ).toBeLessThanOrEqual(800);
  await peer("overlap");
  expect(
    store.work
      .snapshot()
      .locks.map(({ target }) => target.id)
      .sort(),
  ).toEqual(["ab", "b", "c"]);
  expect(
    store.db.query("SELECT native_session_id FROM agent_chats WHERE id=?1", [
      chatId,
    ]).rows[0].native_session_id,
  ).toBe("root-session");
  finish("second");
  await manager.boardTaskStatus(active, { taskId: c.id, waitMs: 5000 });
  await peer("fourth");
  finish("root");
  await active.completion;
  expect(store.turn(active.turn.id)).toMatchObject({
    status: "failed",
    error: expect.stringContaining("исполнителей"),
  });
  expect(store.work.snapshot().locks).toEqual([]);
}, 20_000);

it("revokes worker writes immediately and releases claims only after an in-flight write settles", async () => {
  await start();
  const active = manager.active!;
  const task = manager.startBoardTask(active, assignment("cancel-me", "a"));
  const child = await peer("cancel-me");
  const worker = manager.authenticate(`Bearer ${child.token}`);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const pending = manager.withToolCall(worker, () =>
    store.work.runAs(manager.workActor(worker), async () => {
      await gate;
      operations.patchBoard(boardId, patch("a", "late write"));
    }),
  );
  const rejected = expect(pending).rejects.toMatchObject({
    code: "AGENT_TASK_ENDED",
  });
  const stopping = manager.cancelBoardTask(active, { taskId: task.id });
  try {
    expect(() => manager.authenticate(`Bearer ${child.token}`)).toThrow();
    expect(() => operations.patchBoard(boardId, patch("a", "user"))).toThrow(
      expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }),
    );
    await vi.waitFor(() => expect(() => process.kill(child.pid, 0)).toThrow(), {
      timeout: 5000,
    });
    expect(
      store.work
        .snapshot()
        .locks.map(({ target }) => target.id)
        .sort(),
    ).toEqual(["a", "ab"]);
  } finally {
    resume();
    await rejected;
    await stopping;
  }
  expect(
    operations.patchBoard(boardId, patch("a", "user")).document.nodes[0].data
      .text,
  ).toBe("user");
}, 15_000);

it("routes overlapping worker questions and approvals to their respective calls", async () => {
  await start();
  const active = manager.active!;
  const a = manager.startBoardTask(active, assignment("first", "a"));
  const c = manager.startBoardTask(active, assignment("second", "c"));
  const [first, second] = await Promise.all([peer("first"), peer("second")]);
  const firstAgent = manager.authenticate(`Bearer ${first.token}`);
  const secondAgent = manager.authenticate(`Bearer ${second.token}`);
  const question = manager.requestPermission(firstAgent, {
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          header: "Choice",
          question: "What color?",
          options: [{ label: "Blue" }, { label: "Red" }],
        },
      ],
    },
  });
  const allowed = { id: boardId, nodeIds: ["c"] };
  const approval = manager.requestPermission(secondAgent, {
    tool_name: "mcp__miracle__read_board_items",
    input: allowed,
  });
  await expect(
    manager.requestPermission(firstAgent, {
      tool_name: "Bash",
      input: { command: "pwd" },
    }),
  ).resolves.toMatchObject({ behavior: "deny" });
  const messages = store.conversation(chatId).messages;
  const asked = messages.find(({ role }) => role === "question")!;
  const approved = messages.find(({ role }) => role === "approval")!;
  expect(asked.details?.worker).toMatchObject({ id: a.id });
  expect(approved.details?.worker).toMatchObject({ id: c.id });
  expect(store.turn(active.turn.id).status).toBe("waiting");
  manager.respond(approved.details!.approvalId as string, "allow");
  await expect(approval).resolves.toMatchObject({
    behavior: "allow",
    updatedInput: allowed,
  });
  expect(store.turn(active.turn.id).status).toBe("waiting");
  manager.answerQuestion(asked.details!.question!.id, {
    answers: { "0": ["Blue"] },
  });
  await expect(question).resolves.toMatchObject({
    behavior: "allow",
    updatedInput: {
      answers: { "What color?": "Blue" },
    },
  });
  expect(store.turn(active.turn.id).status).toBe("running");
});

it("retains the worker's final outcome after long progress in both status views", async () => {
  await start();
  const active = manager.active!;
  const task = manager.startBoardTask(
    active,
    assignment("reports-outcome", "a"),
  );
  await peer("reports-outcome");
  finish("reports-outcome");
  const summary = "Could not place the shape because its anchor disappeared.";
  await expect(
    manager.boardTaskStatus(active, { taskId: task.id, waitMs: 5000 }),
  ).resolves.toMatchObject({ status: "completed", summary });
  await expect(manager.boardTaskStatus(active, {})).resolves.toMatchObject({
    tasks: [{ id: task.id, status: "completed", summary }],
  });
});

it("lets a worker format a linked table while preserving its snapshot identity", async () => {
  const source = { connectionId: randomUUID(), sql: "SELECT 1" };
  const sourceId = randomUUID();
  const otherId = randomUUID();
  const manual = createEmptyVisualTable();
  const table = {
    ...manual,
    sourceResultSetId: sourceId,
    sourceSchema: "schema",
  };
  for (const id of [sourceId, otherId])
    db.query(
      "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES(?1,?2,?3,?4,?5)",
      [id, [], 0, 0, source],
    );
  const board = operations.createBoard({
    name: "Snapshot links",
    document: {
      schemaVersion: 1,
      nodes: [
        {
          ...node("a"),
          data: {
            kind: "result",
            title: "SQL result",
            source,
            resultSetId: sourceId,
            visualTable: table,
          },
        },
        {
          ...node("b"),
          data: { kind: "table", title: "Manual table", visualTable: manual },
        },
      ],
      edges: [],
    },
  });
  await start();
  const active = manager.active!;
  const request = {
    ...assignment("format-table", "a"),
    id: board.id,
    nodeIds: ["a", "b"],
  };
  manager.startBoardTask(active, request);
  const child = await peer("format-table");
  const worker = manager.authenticate(`Bearer ${child.token}`);
  const replaceTable = (id: string, visualTable: unknown) =>
    callMiracleTool(manager, worker, "board_patch", {
      id: board.id,
      baseRevision: operations.board(board.id).revision,
      mutationId: randomUUID(),
      operations: [
        { type: "update_node", id, patch: { data: { visualTable } } },
      ],
    });
  for (const replacement of [
    { ...table, sourceResultSetId: otherId },
    { ...table, sourceSchema: "another schema" },
    manual,
  ]) {
    await expect(replaceTable("a", replacement)).rejects.toMatchObject({
      code: "AGENT_WORK_SCOPE",
    });
    expect(operations.board(board.id)).toEqual(board);
  }
  const formatted = {
    ...table,
    columns: table.columns.map((column) => ({ ...column, width: 180 })),
  };
  await replaceTable("a", formatted);
  await replaceTable("b", {
    ...manual,
    columns: manual.columns.map((column) => ({ ...column, width: 220 })),
  });
  const [snapshotted, entered] = operations.board(board.id).document.nodes;
  expect(snapshotted.data.visualTable).toEqual(formatted);
  expect(entered.data.visualTable?.columns[0].width).toBe(220);
});
