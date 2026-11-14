import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database, migrate } from "../src/server/db";
import { ProjectStore } from "../src/server/project-store";
import { SecretBox } from "../src/server/secrets";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import {
  AgentManager,
  type AgentToolServices,
} from "../src/server/agents/manager";
import { startAgentTurn } from "../src/server/agents/adapter";

vi.mock("../src/server/agents/adapter", () => ({ startAgentTurn: vi.fn() }));
let root: string,
  db: Database,
  store: ProjectStore,
  ops: WorkspaceOperations,
  manager: AgentManager,
  chatId: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-board-context-")));
  vi.stubEnv("MIRACLE_INSTALL_ROOT", join(root, "install"));
  const dataDir = join(root, ".miracle");
  db = new Database(dataDir);
  migrate(db, () => {});
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    projectRoot: root,
    dataDir,
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
  ops = new WorkspaceOperations(store, async () => {});
  manager = new AgentManager(
    store,
    ops,
    {} as AgentToolServices,
    () => "http://127.0.0.1",
  );
  const profile = store.saveProfile({
    name: "Context fixture",
    provider: "codex",
    command: "codex",
  });
  chatId = store.createChat({ profileId: profile.id }).id;
  vi.mocked(startAgentTurn)
    .mockReset()
    .mockImplementation(() => {
      let finish!: () => void;
      return {
        completion: new Promise((resolve) => {
          finish = () => resolve({});
        }),
        cancel: async () => finish(),
        respond: () => {},
      };
    });
});
afterEach(async () => {
  await manager.close();
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("keeps automatic board context independent of unselected content and board size", async () => {
  const board = ops.createBoard({
    name: "A large board",
    document: {
      schemaVersion: 1,
      nodes: Array.from({ length: 200 }, (_, i) => ({
        id: `node-${i}`,
        type: "artifact",
        position: { x: i * 100, y: 0 },
        data: {
          kind: "note",
          title: i === 0 ? "Selected" : "UNSELECTED_TITLE".repeat(30),
          text: "PRIVATE_BODY".repeat(3000),
        },
      })),
      edges: [],
    },
  });
  manager.start(chatId, {
    content: "Move the selected block",
    clientRequestId: randomUUID(),
    context: {
      boardId: board.id,
      boardNodes: [{ id: "node-0", title: "Selected" }],
    },
  });
  await Promise.resolve();
  const prompt = vi.mocked(startAgentTurn).mock.calls[0][0].prompt;
  const context = JSON.parse(
    prompt.split("Project context (data):\n")[1].split("\n")[0],
  );
  expect(context.board).toMatchObject({
    id: board.id,
    revision: board.revision,
    nodeCount: 200,
    edgeCount: 0,
  });
  expect(context.board.selectedNodes.map((node: any) => node.id)).toEqual([
    "node-0",
  ]);
  expect(context.board.nodes).toBeUndefined();
  expect(prompt).not.toContain("PRIVATE_BODY");
  expect(prompt).not.toContain("UNSELECTED_TITLE");
  expect(Buffer.byteLength(JSON.stringify(context.board))).toBeLessThan(2048);
});

it("keeps selected connector identity but does not copy unrelated connections into the prompt", async () => {
  const board = ops.createBoard({
    name: "Links",
    document: {
      schemaVersion: 1,
      nodes: ["a", "b"].map((id) => ({
        id,
        type: "artifact",
        position: { x: 0, y: 0 },
        data: { kind: "note", title: id },
      })),
      edges: [
        { id: "chosen", source: "a", target: "b", label: "Actual label" },
        {
          id: "other",
          source: "a",
          target: "b",
          label: "UNSELECTED_LINK_LABEL",
        },
      ],
    },
  });
  manager.start(chatId, {
    content: "Move this arrow",
    clientRequestId: randomUUID(),
    context: {
      boardId: board.id,
      boardEdges: [{ id: "chosen", label: "Untrusted client label" }],
    },
  });
  await Promise.resolve();
  const prompt = vi.mocked(startAgentTurn).mock.calls[0][0].prompt;
  const context = JSON.parse(
    prompt.split("Project context (data):\n")[1].split("\n")[0],
  );
  expect(context.targets.boardEdges).toEqual([
    { id: "chosen", label: "Actual label" },
  ]);
  expect(context.board.selectedEdges).toMatchObject([
    { id: "chosen", label: "Actual label" },
  ]);
  expect(context.board.edgeCount).toBe(2);
  expect(prompt).not.toContain("UNSELECTED_LINK_LABEL");
  expect(prompt).not.toContain("Untrusted client label");
});

it("does not copy an open SQL buffer into a board task's initial context", async () => {
  const sql = "SELECT 'PRIVATE_SQL_BODY'; --" + " large query".repeat(10000);
  const editor = store.createEditor({
    id: randomUUID(),
    name: "large.sql",
    sql,
    connectionId: randomUUID(),
  });
  const board = ops.createBoard({ name: "Board task" });
  manager.start(chatId, {
    content: "Arrange the board",
    clientRequestId: randomUUID(),
    context: { boardId: board.id, editorDocumentId: editor.id },
  });
  await Promise.resolve();
  const prompt = vi.mocked(startAgentTurn).mock.calls[0][0].prompt;
  const context = JSON.parse(
    prompt.split("Project context (data):\n")[1].split("\n")[0],
  );
  expect(context.editor).toMatchObject({
    id: editor.id,
    revision: editor.revision,
    sqlLength: sql.length,
  });
  expect(context.editor.sql).toBeUndefined();
  expect(prompt).not.toContain("PRIVATE_SQL_BODY");
});
