import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import type { AgentContextSnapshot } from "../src/shared/agent-context";

vi.mock("../src/server/agents/adapter", () => ({ startAgentTurn: vi.fn() }));
let root: string, db: Database, store: ProjectStore, manager: AgentManager;
let finish: () => void;
const oldSnapshot: AgentContextSnapshot = {
  provider: "codex",
  usedTokens: 1400,
  contextWindow: 32000,
  measuredAt: "2026-11-11T09:00:00.000Z",
  estimates: { conversation: 10, project: 20, tools: 30, instructions: 40 },
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-context-manager-")));
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
  manager = new AgentManager(
    store,
    new WorkspaceOperations(store, async () => {}),
    {} as AgentToolServices,
    () => "http://127.0.0.1:3001",
  );
  vi.mocked(startAgentTurn)
    .mockReset()
    .mockImplementation(() => ({
      completion: new Promise((resolve) => {
        finish = () => resolve({});
      }),
      cancel: async () => finish(),
      respond: () => {},
    }));
});
afterEach(async () => {
  finish?.();
  await manager.close();
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function chat(nativeSession?: string) {
  const profile = store.saveProfile({
    name: "Test",
    provider: "codex",
    command: "codex",
  });
  const chat = store.createChat({ profileId: profile.id });
  if (nativeSession)
    db.query("UPDATE agent_chats SET native_session_id=?2 WHERE id=?1", [
      chat.id,
      nativeSession,
    ]);
  return chat;
}
async function begin(chatId: string, content = "3333", context = {}) {
  const turn = manager.start(chatId, {
    content,
    context,
    clientRequestId: randomUUID(),
  });
  await Promise.resolve();
  return { turn, options: vi.mocked(startAgentTurn).mock.calls.at(-1)![0] };
}

it("persists latest root telemetry and includes flushed visible text while excluding undelivered messages", async () => {
  const first = chat("existing");
  store.message(first.id, undefined, "user", "1111");
  store.message(first.id, undefined, "assistant", "2222");
  store.message(first.id, undefined, "user", "not delivered".repeat(100), {
    steer: { status: "failed" },
  });
  store.message(first.id, undefined, "user", "not yet delivered".repeat(100), {
    steer: { status: "sending" },
  });
  store.message(first.id, undefined, "action", "action output".repeat(100));
  writeFileSync(join(root, "query.sql"), "PRIVATE_FILE_CONTENT".repeat(10000));
  const { turn, options } = await begin(first.id, "3333", {
    filePaths: ["query.sql"],
  });
  options.onEvent({ type: "message", text: "4444" });
  const cursor = store.since(0).at(-1)!.id;
  options.onEvent({
    type: "context-usage",
    usage: { provider: "codex", usedTokens: 1200, contextWindow: 32000 },
  });

  const rootMessage = store
    .conversation(first.id)
    .messages.find(
      (message) => message.turnId === turn.id && message.role === "user",
    )!;
  const usage = rootMessage.details?.contextUsage;
  expect(usage).toMatchObject({
    provider: "codex",
    usedTokens: 1200,
    contextWindow: 32000,
    estimates: { conversation: 5 },
  });
  expect(Number.isNaN(Date.parse(usage!.measuredAt))).toBe(false);
  expect(usage!.estimates.project).toBeGreaterThan(0);
  expect(usage!.estimates.project).toBeLessThan(200);
  expect(usage!.estimates.instructions).toBeGreaterThan(100);
  expect(usage!.estimates.tools).toBeGreaterThan(100);
  expect(options.prompt).toContain('"filePaths":["query.sql"]');
  expect(options.prompt).not.toContain("PRIVATE_FILE_CONTENT");
  expect(store.since(cursor).map((event) => event.type)).toEqual([
    "agent.event",
    "agent.context.updated",
  ]);
  expect(store.conversation(first.id).messages.at(-1)).toMatchObject({
    role: "assistant",
    content: "4444",
  });

  const nextCursor = store.since(0).at(-1)!.id;
  options.onEvent({
    type: "context-usage",
    usage: { provider: "codex", usedTokens: 700 },
  });
  expect(
    store
      .conversation(first.id)
      .messages.find((message) => message.id === rootMessage.id)?.details
      ?.contextUsage,
  ).toMatchObject({ usedTokens: 700 });
  expect(
    store
      .conversation(first.id)
      .messages.find((message) => message.id === rootMessage.id)?.details
      ?.contextUsage,
  ).not.toHaveProperty("contextWindow");
  expect(store.since(nextCursor).map((event) => event.type)).toEqual([
    "agent.context.updated",
  ]);
});

it("preserves the previous measurement while resuming the same native session", async () => {
  const first = chat("existing");
  store.message(first.id, undefined, "user", "Earlier", {
    contextUsage: oldSnapshot,
  });
  const { options } = await begin(first.id);
  expect(options.resumeSessionId).toBe("existing");
  expect(
    store.conversation(first.id).messages[0].details?.contextUsage,
  ).toEqual(oldSnapshot);
});

it("reconciles accepted steer estimates when telemetry and completion precede the delivery continuation", async () => {
  const first = chat("existing");
  vi.mocked(startAgentTurn).mockImplementationOnce((options) => ({
    completion: new Promise((resolve) => {
      finish = () => resolve({});
    }),
    cancel: async () => finish(),
    respond: () => {},
    steer: async () => {
      options.onEvent({
        type: "context-usage",
        usage: { provider: "codex", usedTokens: 800 },
      });
      finish();
    },
  }));
  const { turn } = await begin(first.id, "abcd");
  const completion = manager.active!.completion;
  await manager.steer(turn.id, {
    content: "efgh",
    clientRequestId: randomUUID(),
    context: { selection: "x".repeat(8000) },
  });
  await completion;
  const messages = store.conversation(first.id).messages;
  expect(messages[1].details?.steer).toMatchObject({ status: "accepted" });
  expect(messages[0].details?.contextUsage).toMatchObject({
    usedTokens: 800,
    estimates: { conversation: 3 },
  });
  expect(messages[0].details!.contextUsage!.estimates.project).toBeGreaterThan(
    2000,
  );
  expect(store.turn(turn.id).status).toBe("completed");
});

it("invalidates saved context before starting a new native session", async () => {
  const first = chat();
  store.message(first.id, undefined, "user", "Earlier", {
    contextUsage: oldSnapshot,
  });
  const { options } = await begin(first.id);
  expect(options.resumeSessionId).toBeUndefined();
  expect(
    store.conversation(first.id).messages[0].details?.contextUsage,
  ).toBeNull();
});

it.each(["AGENT_SESSION_UNAVAILABLE", "AGENT_SESSION_TOO_LARGE"])(
  "invalidates old context before a %s fallback",
  async (code) => {
    const first = chat("existing");
    store.message(first.id, undefined, "user", "Earlier", {
      contextUsage: oldSnapshot,
    });
    vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
      completion: Promise.reject(
        Object.assign(new Error("resume failed"), { code }),
      ),
      cancel: async () => {},
      respond: () => {},
    }));
    await begin(first.id);
    await Promise.resolve();
    expect(
      vi.mocked(startAgentTurn).mock.calls.at(-1)![0].resumeSessionId,
    ).toBeUndefined();
    expect(
      store.conversation(first.id).messages[0].details?.contextUsage,
    ).toBeNull();
  },
);

it("ignores events from an old turn after another turn starts", async () => {
  const first = chat("existing");
  const previous = await begin(first.id);
  finish();
  await manager.active!.completion;
  await begin(first.id);
  const cursor = store.since(0).at(-1)!.id;
  previous.options.onEvent({
    type: "context-usage",
    usage: { provider: "codex", usedTokens: 800 },
  });
  expect(store.since(cursor)).toEqual([]);
  expect(
    store
      .conversation(first.id)
      .messages.every((message) => message.details?.contextUsage === undefined),
  ).toBe(true);
});

it("ignores a superseded native process after session fallback", async () => {
  const first = chat("existing");
  vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
    completion: Promise.reject(
      Object.assign(new Error("resume failed"), {
        code: "AGENT_SESSION_UNAVAILABLE",
      }),
    ),
    cancel: async () => {},
    respond: () => {},
  }));
  await begin(first.id);
  await Promise.resolve();
  const previous = vi.mocked(startAgentTurn).mock.calls[0][0];
  const current = vi.mocked(startAgentTurn).mock.calls[1][0];
  current.onEvent({
    type: "context-usage",
    usage: { provider: "codex", usedTokens: 800 },
  });
  const cursor = store.since(0).at(-1)!.id;
  previous.onEvent({
    type: "context-usage",
    usage: { provider: "codex", usedTokens: 5000, contextWindow: 32000 },
  });
  expect(store.since(cursor)).toEqual([]);
  expect(
    store.conversation(first.id).messages[0].details?.contextUsage,
  ).toMatchObject({ usedTokens: 800 });
});

it("scopes native action IDs to their launch when resuming falls back", async () => {
  const first = chat("existing");
  vi.mocked(startAgentTurn).mockImplementationOnce((options) => {
    options.onEvent({
      type: "action",
      text: "Read",
      details: { id: "same", phase: "started" },
    });
    return {
      completion: Promise.reject(
        Object.assign(new Error("resume failed"), {
          code: "AGENT_SESSION_UNAVAILABLE",
        }),
      ),
      cancel: async () => {},
      respond: () => {},
    };
  });
  await begin(first.id);
  await Promise.resolve();
  vi.mocked(startAgentTurn).mock.calls[1][0].onEvent({
    type: "action",
    text: "Read",
    details: { id: "same", phase: "started" },
  });
  const actions = store
    .conversation(first.id)
    .messages.filter((message) => message.role === "action");
  expect(actions.map((message) => message.details?.activityScope)).toEqual([
    1, 2,
  ]);
});

it("keeps zero usage truthful and ignores invalid usage without inventing a capacity", async () => {
  const first = chat("existing");
  const { turn, options } = await begin(first.id);
  for (const usedTokens of [
    -1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
  ]) {
    options.onEvent({
      type: "context-usage",
      usage: { provider: "codex", usedTokens },
    });
  }
  expect(
    store.conversation(first.id).messages[0].details?.contextUsage,
  ).toBeUndefined();
  options.onEvent({
    type: "context-usage",
    usage: { provider: "codex", usedTokens: 0, contextWindow: -1 },
  });
  const usage = store
    .conversation(first.id)
    .messages.find((message) => message.turnId === turn.id)
    ?.details?.contextUsage;
  expect(usage).toMatchObject({ usedTokens: 0 });
  expect(usage).not.toHaveProperty("contextWindow");
  expect(
    Object.values(usage!.estimates).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ),
  ).toBe(true);
});
