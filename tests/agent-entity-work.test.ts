import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
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
import { callMiracleTool } from "../src/server/agents/tools";
import { registerProjectRoutes } from "../src/server/project-routes";
import type { Board, BoardDocument } from "../src/shared/types";

vi.mock("../src/server/agents/adapter", () => ({ startAgentTurn: vi.fn() }));
let root: string,
  db: Database,
  store: ProjectStore,
  operations: WorkspaceOperations;
let manager: AgentManager, chatId: string, connectionId: string;
let finish: () => void;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-entity-work-")));
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
  connectionId = randomUUID();
  operations = new WorkspaceOperations(store, async () => {});
  manager = new AgentManager(
    store,
    operations,
    {} as AgentToolServices,
    () => "http://127.0.0.1",
  );
  const profile = store.saveProfile({
    name: "Fixture",
    provider: "codex",
    command: "codex",
  });
  chatId = store.createChat({ profileId: profile.id }).id;
  vi.mocked(startAgentTurn).mockImplementation(() => ({
    completion: new Promise((resolve) => {
      finish = () => resolve({});
    }),
    cancel: async () => finish(),
    respond: () => {},
  }));
});
afterEach(async () => {
  await manager.close();
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const node = (id: string) => ({
  id,
  type: "artifact" as const,
  position: { x: 0, y: 0 },
  data: { kind: "note" as const, title: id, text: "original" },
});
const board = () =>
  operations.createBoard({
    name: "Board",
    document: {
      schemaVersion: 1,
      nodes: [node("a"), node("b"), node("c")],
      edges: [{ id: "ab", source: "a", target: "b" }],
    },
  });
const edit = (
  document: BoardDocument,
  id: string,
  text: string,
): BoardDocument => ({
  ...document,
  nodes: document.nodes.map((n) =>
    n.id === id ? { ...n, data: { ...n.data, text } } : n,
  ),
});
async function start(context = {}) {
  manager.start(chatId, {
    content: "Work",
    context,
    clientRequestId: randomUUID(),
  });
  await Promise.resolve();
  return manager.active!;
}
const call = (name: string, input: unknown) =>
  callMiracleTool(manager, manager.active!, name, input);
const save = (base: Board, document: BoardDocument) =>
  operations.updateBoard(base.id, {
    baseRevision: base.revision,
    mutationId: randomUUID(),
    document,
  });

it("merges stale full saves of different blocks while rejecting stale edits of the same block", () => {
  const base = board();
  save(base, edit(base.document, "a", "agent"));
  const merged = save(base, edit(base.document, "b", "user"));
  expect(merged.document.nodes.map((n) => n.data.text)).toEqual([
    "agent",
    "user",
    "original",
  ]);
  expect(() => save(base, edit(base.document, "a", "stale"))).toThrow(/измен/);
  expect(operations.board(base.id)).toEqual(merged);
});

it("locks only claimed blocks and incident edges, then releases them on completion", async () => {
  const base = board();
  const active = await start({ boardId: base.id });
  save(base, edit(base.document, "c", "context stays editable"));
  await call("begin_entity_work", {
    entities: [{ kind: "board-node", boardId: base.id, id: "a" }],
  });
  const current = operations.board(base.id);
  expect(() => save(current, edit(current.document, "a", "blocked"))).toThrow(
    expect.objectContaining({ statusCode: 423, code: "ENTITY_AGENT_LOCKED" }),
  );
  let independent = save(current, edit(current.document, "c", "allowed"));
  expect(independent.document.nodes[2].data.text).toBe("allowed");
  independent = save(
    independent,
    edit(independent.document, "b", "neighbor stays editable"),
  );
  expect(independent.document.nodes[1].data.text).toBe(
    "neighbor stays editable",
  );
  expect(() =>
    save(independent, {
      ...independent.document,
      nodes: independent.document.nodes.filter((n) => n.id !== "b"),
      edges: [],
    }),
  ).toThrow(expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }));
  expect(() =>
    save(independent, {
      ...independent.document,
      edges: [
        ...independent.document.edges,
        { id: "new", source: "c", target: "a" },
      ],
    }),
  ).toThrow(expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }));
  const snapshot = store
    .since(0)
    .filter((e) => e.type === "agent.work")
    .at(-1)!;
  expect((snapshot.data as any).locks.map((l: any) => l.target)).toEqual(
    expect.arrayContaining([
      { kind: "board-node", boardId: base.id, id: "a" },
      { kind: "board-edge", boardId: base.id, id: "ab" },
    ]),
  );
  finish();
  await active.completion;
  expect(
    save(independent, edit(independent.document, "a", "unlocked")).document
      .nodes[0].data.text,
  ).toBe("unlocked");
  expect(
    store
      .since(0)
      .filter((e) => e.type === "agent.work")
      .at(-1)?.data,
  ).toEqual({ locks: [] });
});

it("rebases agent patches on their historical base and reads stable board pages", async () => {
  const base = board();
  await start();
  await call("begin_entity_work", {
    entities: [{ kind: "board-node", boardId: base.id, id: "a" }],
  });
  save(base, edit(base.document, "b", "user"));
  const updated = (await call("board_patch", {
    id: base.id,
    baseRevision: base.revision,
    mutationId: randomUUID(),
    operations: [
      { type: "update_node", id: "a", patch: { data: { text: "agent" } } },
    ],
  })) as Board;
  expect(updated.document.nodes.map((n) => n.data.text)).toEqual([
    "agent",
    "user",
    "original",
  ]);
  const original = (await call("read_board", {
    id: base.id,
    revision: base.revision,
  })) as Board;
  expect(original.document).toEqual(base.document);
});

it("reports ownership before stale revision for pending user writes to a locked block", async () => {
  const base = board();
  await start();
  await call("board_patch", {
    id: base.id,
    baseRevision: base.revision,
    mutationId: randomUUID(),
    operations: [
      { type: "update_node", id: "a", patch: { data: { text: "agent" } } },
    ],
  });
  expect(() =>
    save(base, edit(base.document, "a", "pending user draft")),
  ).toThrow(
    expect.objectContaining({ statusCode: 423, code: "ENTITY_AGENT_LOCKED" }),
  );
});

it("protects editor/query aliases and auto-claims agent edits", async () => {
  const query = await operations.saveQuery({
    name: "Query",
    sql: "select 1",
    connectionId,
  });
  const editor = store.createEditor({
    name: query.name,
    sql: query.sql,
    connectionId,
    queryId: query.id,
    queryRevision: query.revision,
  });
  await start();
  await call("edit_editor", {
    id: editor.id,
    sql: "select 2",
    baseRevision: editor.revision,
    mutationId: randomUUID(),
  });
  await expect(
    operations.saveQuery(
      { ...query, sql: "select 3", baseRevision: query.revision },
      query.id,
    ),
  ).rejects.toMatchObject({ statusCode: 423, code: "ENTITY_AGENT_LOCKED" });
  const current = store.editor(editor.id);
  expect(() =>
    store.deleteEditor(editor.id, {
      baseRevision: current.revision,
      mutationId: randomUUID(),
    }),
  ).toThrow(expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }));
  await call("end_entity_work", {
    entities: [{ kind: "editor", id: editor.id }],
  });
  await expect(
    operations.saveQuery(
      { ...query, sql: "select 3", baseRevision: query.revision },
      query.id,
    ),
  ).resolves.toMatchObject({ sql: "select 3" });
});

it("fences a saved query waiting on connection validation after cancellation", async () => {
  const query = await operations.saveQuery({
    name: "Query",
    sql: "select 1",
    connectionId,
  });
  let resume!: () => void;
  const delayed = new WorkspaceOperations(
    store,
    () =>
      new Promise((resolve) => {
        resume = () => resolve(undefined);
      }),
  );
  manager = new AgentManager(
    store,
    delayed,
    {} as AgentToolServices,
    () => "http://127.0.0.1",
  );
  const active = await start();
  const pending = call("save_query", {
    ...query,
    sql: "select late",
    baseRevision: query.revision,
    mutationId: randomUUID(),
  });
  const rejected = expect(pending).rejects.toMatchObject({
    code: "AGENT_TASK_ENDED",
  });
  await manager.cancel(active.turn.id);
  resume();
  await rejected;
  expect(operations.query(query.id).sql).toBe("select 1");
});

it("exposes authoritative work snapshots and protects project file saves", async () => {
  writeFileSync(join(root, "note.md"), "original");
  await start();
  const app = Fastify();
  registerProjectRoutes(app, store, () => {});
  try {
    const file = (
      await app.inject({ method: "GET", url: "/api/project/file?path=note.md" })
    ).json();
    await call("begin_entity_work", {
      entities: [{ kind: "file", id: "note.md" }],
    });
    const locked = await app.inject({
      method: "PUT",
      url: "/api/project/file?path=note.md",
      payload: { content: "user", baseRevision: file.revision },
    });
    expect(locked.statusCode).toBe(423);
    const snapshot = (
      await app.inject({ method: "GET", url: "/api/agent-work" })
    ).json();
    expect(snapshot.locks).toHaveLength(1);
    expect(snapshot.revision).toBe(store.since(0).at(-1)!.id);
    await call("end_entity_work", {
      entities: [{ kind: "file", id: "note.md" }],
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/agent-work" })).json()
        .locks,
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

it("clears persisted claims when an interrupted task is recovered at startup", async () => {
  const base = board();
  const active = await start();
  await call("begin_entity_work", {
    entities: [{ kind: "board-node", boardId: base.id, id: "a" }],
  });
  new AgentManager(
    store,
    operations,
    {} as AgentToolServices,
    () => "http://127.0.0.1",
  );
  expect(store.turn(active.turn.id).status).toBe("interrupted");
  expect(
    store
      .since(0)
      .filter((e) => e.type === "agent.work")
      .at(-1)?.data,
  ).toEqual({ locks: [] });
});

it("keeps claims until a cancelled native process has stopped", async () => {
  let stopped!: () => void;
  vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
    completion: new Promise((resolve) => {
      finish = () => resolve({});
    }),
    cancel: () =>
      new Promise<void>((resolve) => {
        stopped = () => {
          finish();
          resolve();
        };
      }),
    respond: () => {},
  }));
  const base = board();
  const active = await start();
  await call("begin_entity_work", {
    entities: [{ kind: "board-node", boardId: base.id, id: "a" }],
  });
  const cancelling = manager.cancel(active.turn.id);
  try {
    expect(() => save(base, edit(base.document, "a", "too soon"))).toThrow(
      expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }),
    );
  } finally {
    stopped();
    await cancelling;
  }
  expect(
    save(base, edit(base.document, "a", "after stop")).document.nodes[0].data
      .text,
  ).toBe("after stop");
});

it("allows opening a locked saved query while protecting edits in its new editor view", async () => {
  const query = await operations.saveQuery({
    name: "Query",
    sql: "select 1",
    connectionId,
  });
  await start();
  await call("begin_entity_work", {
    entities: [{ kind: "query", id: query.id }],
  });
  const opened = store.createEditor({
    name: query.name,
    sql: query.sql,
    connectionId,
    queryId: query.id,
    queryRevision: query.revision,
  });
  expect(opened.sql).toBe("select 1");
  expect(() =>
    store.updateEditor(opened.id, {
      sql: "select 2",
      baseRevision: opened.revision,
      mutationId: randomUUID(),
    }),
  ).toThrow(expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }));
});

it("releases a node's dependent claims without releasing independently claimed edge work", async () => {
  const base = board();
  await start();
  await call("begin_entity_work", {
    entities: [{ kind: "board-node", boardId: base.id, id: "a" }],
  });
  await call("begin_entity_work", {
    entities: [{ kind: "board-edge", boardId: base.id, id: "ab" }],
  });
  await call("end_entity_work", {
    entities: [{ kind: "board-node", boardId: base.id, id: "a" }],
  });
  const saved = save(base, edit(base.document, "a", "released"));
  expect(() => save(saved, { ...saved.document, edges: [] })).toThrow(
    expect.objectContaining({ code: "ENTITY_AGENT_LOCKED" }),
  );
  await call("end_entity_work", {
    entities: [{ kind: "board-edge", boardId: base.id, id: "ab" }],
  });
  expect(save(saved, { ...saved.document, edges: [] }).document.edges).toEqual(
    [],
  );
});

const slide = (id: string, title = id) => ({
  id,
  title,
  background: "#ffffff",
});
const presentation = () =>
  operations.createBoard({
    name: "Presentation",
    kind: "presentation",
    document: {
      schemaVersion: 1,
      kind: "presentation",
      slides: [slide("a"), slide("b")],
      nodes: [
        { ...node("block-a"), slideId: "a" },
        { ...node("block-b"), slideId: "b" },
      ],
      edges: [],
    },
  });
const patch = (base: Board, operations: unknown[]) => ({
  id: base.id,
  baseRevision: base.revision,
  mutationId: randomUUID(),
  operations,
});

it("creates a one-slide presentation idempotently and lists canvas kinds separately", () => {
  const plain = board();
  const input = {
    name: "Deck",
    kind: "presentation",
    mutationId: randomUUID(),
  };
  const deck = operations.createBoard(input);
  expect(deck.document).toMatchObject({
    kind: "presentation",
    slides: [
      expect.objectContaining({
        id: expect.any(String),
        background: "#ffffff",
      }),
    ],
    nodes: [],
    edges: [],
  });
  expect(operations.createBoard(input)).toEqual(deck);
  expect(operations.boards("board")).toMatchObject([
    { id: plain.id, kind: "board" },
  ]);
  expect(operations.boards("presentation")).toMatchObject([
    { id: deck.id, kind: "presentation" },
  ]);
});

it("rejects conversion between document kinds", () => {
  const deck = presentation();
  expect(() => save(deck, { schemaVersion: 1, nodes: [], edges: [] })).toThrow(
    expect.objectContaining({ statusCode: 400 }),
  );
  expect(operations.board(deck.id)).toEqual(deck);
});

it("uses the exact selected slide in MCP context and rejects a block on another slide", async () => {
  const deck = presentation();
  expect(() =>
    manager.start(chatId, {
      content: "Work",
      clientRequestId: randomUUID(),
      context: {
        boardId: deck.id,
        slideId: "a",
        boardNodes: [{ id: "block-b", title: "stale" }],
      },
    }),
  ).toThrow(expect.objectContaining({ code: "INVALID_BOARD_REFERENCE" }));
  await start({
    boardId: deck.id,
    slideId: "a",
    boardNodes: [{ id: "block-a", title: "stale" }],
  });
  expect(await call("project_context", {})).toMatchObject({
    targets: {
      boardId: deck.id,
      slideId: "a",
      boardNodes: [{ id: "block-a", title: "block-a" }],
    },
  });
});

it("creates, filters, and patches slides through MCP using revisioned operations", async () => {
  const plain = board();
  await start();
  const created = (await call("create_board", {
    name: "Deck",
    kind: "presentation",
    mutationId: randomUUID(),
  })) as Board;
  expect(await call("list_boards", { kind: "board" })).toMatchObject([
    { id: plain.id },
  ]);
  expect(await call("list_boards", { kind: "presentation" })).toMatchObject([
    { id: created.id },
  ]);
  const firstId = created.document.slides![0].id;
  const mutation = patch(created, [
    { type: "add_slide", slide: slide("extra", "New") },
    { type: "update_slide", id: "extra", patch: { background: "#112233" } },
    { type: "reorder_slides", slideIds: ["extra", firstId] },
  ]);
  const result = (await call("board_patch", mutation)) as Board;
  expect(result.document.slides).toMatchObject([
    { id: "extra", title: "New", background: "#112233" },
    { id: firstId },
  ]);
  expect(await call("board_patch", mutation)).toEqual(result);
  const removed = (await call(
    "board_patch",
    patch(result, [{ type: "remove_slide", id: firstId }]),
  )) as Board;
  expect(removed.document.slides?.map(({ id }) => id)).toEqual(["extra"]);
  await expect(
    call(
      "board_patch",
      patch(removed, [{ type: "remove_slide", id: "extra" }]),
    ),
  ).rejects.toThrow();
  expect(operations.board(created.id)).toEqual(removed);
});

it("keeps slide metadata claims separate from block edits and slide ordering", async () => {
  const deck = presentation();
  await start({ boardId: deck.id, slideId: "a" });
  await call("begin_entity_work", {
    entities: [{ kind: "board-slide", boardId: deck.id, id: "a" }],
  });
  let current = save(deck, edit(deck.document, "block-a", "allowed"));
  current = operations.patchBoard(
    deck.id,
    patch(current, [
      { type: "reorder_slides", slideIds: ["b", "a"] },
      { type: "update_slide", id: "b", patch: { title: "unrelated" } },
    ]),
  );
  for (const operation of [
    { type: "update_slide", id: "a", patch: { title: "blocked" } },
    { type: "remove_slide", id: "a" },
  ]) {
    expect(() =>
      operations.patchBoard(deck.id, patch(current, [operation])),
    ).toThrow(
      expect.objectContaining({ statusCode: 423, code: "ENTITY_AGENT_LOCKED" }),
    );
  }
  expect(operations.board(deck.id)).toEqual(current);
});

it("checks every child claim before removing a slide and leaves unrelated slide edits available", async () => {
  const deck = presentation();
  await start({ boardId: deck.id, slideId: "a" });
  await call("begin_entity_work", {
    entities: [{ kind: "board-node", boardId: deck.id, id: "block-a" }],
  });
  const current = operations.patchBoard(
    deck.id,
    patch(deck, [
      { type: "update_slide", id: "a", patch: { title: "metadata allowed" } },
    ]),
  );
  expect(() =>
    operations.patchBoard(
      deck.id,
      patch(current, [{ type: "remove_slide", id: "a" }]),
    ),
  ).toThrow(
    expect.objectContaining({ statusCode: 423, code: "ENTITY_AGENT_LOCKED" }),
  );
  const otherRemoved = operations.patchBoard(
    deck.id,
    patch(current, [{ type: "remove_slide", id: "b" }]),
  );
  expect(otherRemoved.document.nodes.map(({ id }) => id)).toEqual(["block-a"]);
});

it("rejects a stale slide removal after a remote child is added", () => {
  const deck = presentation();
  const current = operations.patchBoard(
    deck.id,
    patch(deck, [{ type: "add_node", node: { ...node("new"), slideId: "a" } }]),
  );
  expect(() =>
    operations.patchBoard(
      deck.id,
      patch(deck, [{ type: "remove_slide", id: "a" }]),
    ),
  ).toThrow(
    expect.objectContaining({ statusCode: 409, code: "REVISION_CONFLICT" }),
  );
  expect(operations.board(deck.id)).toEqual(current);
});

it("replays a pre-presentation board creation request with the legacy default document", () => {
  const created = operations.createBoard({ name: "Legacy" });
  const mutationId = randomUUID();
  store.once(
    "board:new",
    mutationId,
    {
      name: "Legacy",
      document: { schemaVersion: 1, nodes: [], edges: [] },
      mutationId,
    },
    () => created,
  );
  expect(operations.createBoard({ name: "Legacy", mutationId })).toEqual(
    created,
  );
  expect(operations.boards()).toHaveLength(1);
});

it("loads each board once per ownership operation and sees new incident edges on the next operation", () => {
  const base = board();
  const other = board();
  const targets = [
    ...["a", "b", "c"].map((id) => ({
      kind: "board-node" as const,
      boardId: base.id,
      id,
    })),
    ...["a", "b"].map((id) => ({
      kind: "board-node" as const,
      boardId: other.id,
      id,
    })),
  ];
  const actor = { turnId: randomUUID(), chatId, isActive: () => true };
  const queried = vi.spyOn(db, "query");
  const boardReads = () =>
    queried.mock.calls.flatMap(([sql, params]) =>
      sql === "SELECT document FROM boards WHERE id=?1" ? [params?.[0]] : [],
    );
  const ids = (items: { id: string }[]) => items.map(({ id }) => id).sort();
  const expected = ["a", "a", "ab", "ab", "b", "b", "c"];
  try {
    expect(ids(store.work.boardReservation(targets))).toEqual(expected);
    expect(boardReads()).toEqual([base.id, other.id]);
    queried.mockClear();
    const claimed = store.work.runAs(actor, () => store.work.begin(targets));
    expect(ids(claimed.locks.map(({ target }) => target))).toEqual(expected);
    expect(boardReads()).toEqual([base.id, other.id]);

    store.work.releaseTurn(actor.turnId);
    operations.patchBoard(base.id, {
      baseRevision: base.revision,
      mutationId: randomUUID(),
      operations: [
        { type: "add_edge", edge: { id: "ac", source: "a", target: "c" } },
      ],
    });
    queried.mockClear();
    const next = store.work.runAs(actor, () => store.work.begin(targets));
    expect(ids(next.locks.map(({ target }) => target))).toEqual([
      "a",
      "a",
      "ab",
      "ab",
      "ac",
      "b",
      "b",
      "c",
    ]);
    expect(boardReads()).toEqual([base.id, other.id]);
  } finally {
    queried.mockRestore();
  }
});
