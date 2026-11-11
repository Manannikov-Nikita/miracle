import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database, migrate } from "../src/server/db";
import { ProjectStore } from "../src/server/project-store";
import { SecretBox } from "../src/server/secrets";
import type { AgentContextSnapshot } from "../src/shared/agent-context";

let root: string, db: Database, store: ProjectStore;
const snapshot: AgentContextSnapshot = {
  provider: "codex",
  usedTokens: 1200,
  contextWindow: 32000,
  model: "test-model",
  measuredAt: "2026-11-11T10:00:00.000Z",
  estimates: { conversation: 20, project: 30, tools: 40, instructions: 50 },
};
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-context-store-")));
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
});
afterEach(() => {
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function chat(provider: "codex" | "claude" = "codex") {
  const profile = store.saveProfile({
    name: "Test",
    provider,
    command: provider,
  });
  return store.createChat({
    profileId: profile.id,
    modelSettings: { model: "test-model", reasoningEffort: "high" },
  });
}
function turn(chatId: string) {
  const id = randomUUID();
  db.query(
    "INSERT INTO agent_turns(id,chat_id,request_id,status,context_json,created_at) VALUES(?1,?2,?3,'completed','{}',?4)",
    [id, chatId, randomUUID(), "2026-11-11T09:00:00.000Z"],
  );
  return id;
}
function lastEventId() {
  return store.since(0).at(-1)!.id;
}

it("merges telemetry into the originating user message without changing transcript, references, or chat order", () => {
  const first = chat();
  const turnId = turn(first.id);
  const details = {
    context: {
      filePaths: ["query.sql"],
      boardNodes: [{ id: "chart", title: "Chart" }],
    },
    images: [{ id: "image", name: "plot.png", mimeType: "image/png" }],
    unrelated: { preserved: true },
  };
  const rootMessage = store.message(
    first.id,
    turnId,
    "user",
    "Keep my text",
    details,
  );
  const steer = store.message(first.id, turnId, "user", "Also this", {
    steer: { status: "accepted" },
  });
  store.message(first.id, turnId, "assistant", "Answer");
  const before = store.conversation(first.id);
  const cursor = lastEventId();

  store.setContextUsage(first.id, turnId, snapshot);

  const after = store.conversation(first.id);
  expect(after.messages).toHaveLength(3);
  expect(after.messages[0]).toEqual({
    ...rootMessage,
    details: { ...details, contextUsage: snapshot },
  });
  expect(after.messages[1]).toEqual(steer);
  expect(after.chat.updatedAt).toBe(before.chat.updatedAt);
  expect(store.since(cursor)).toEqual([
    expect.objectContaining({
      type: "agent.context.updated",
      entityId: first.id,
      data: {
        chatId: first.id,
        messageId: rootMessage.id,
        contextUsage: snapshot,
      },
    }),
  ]);
  const reloadedStore = new ProjectStore(
    db,
    new SecretBox(Buffer.alloc(32, 1)),
    store.context,
  );
  expect(
    reloadedStore.conversation(first.id).messages[0].details?.contextUsage,
  ).toEqual(snapshot);
  reloadedStore.close();
});

it("keeps the latest measurement instead of summing repeated telemetry", () => {
  const first = chat();
  const turnId = turn(first.id);
  store.message(first.id, turnId, "user", "Request");
  store.setContextUsage(first.id, turnId, snapshot);
  store.setContextUsage(first.id, turnId, {
    ...snapshot,
    usedTokens: 700,
    contextWindow: undefined,
  });
  expect(
    store.conversation(first.id).messages[0].details?.contextUsage,
  ).toEqual({
    ...snapshot,
    usedTokens: 700,
    contextWindow: undefined,
  });
});

it("ignores missing roots and another chat's turn", () => {
  const first = chat();
  const second = chat();
  const turnId = turn(first.id);
  store.message(first.id, turnId, "user", "Steer only", {
    steer: { status: "accepted" },
  });
  const cursor = lastEventId();
  store.setContextUsage(first.id, turnId, snapshot);
  store.setContextUsage(second.id, turnId, snapshot);
  expect(store.since(cursor)).toEqual([]);
  expect(
    store.conversation(first.id).messages[0].details?.contextUsage,
  ).toBeUndefined();
});

it("clears every saved measurement with a tombstone while preserving metadata and avoiding transcript events", () => {
  const first = chat();
  const firstRoot = store.message(first.id, turn(first.id), "user", "First", {
    contextUsage: snapshot,
    context: { filePaths: ["one.sql"] },
  });
  const secondRoot = store.message(first.id, turn(first.id), "user", "Second", {
    contextUsage: snapshot,
    custom: true,
  });
  const untouched = store.message(first.id, undefined, "assistant", "Answer");
  const before = store.chat(first.id);
  const cursor = lastEventId();
  store.clearContextUsage(first.id);
  expect(store.conversation(first.id).messages).toEqual([
    { ...firstRoot, details: { ...firstRoot.details, contextUsage: null } },
    { ...secondRoot, details: { ...secondRoot.details, contextUsage: null } },
    untouched,
  ]);
  expect(store.chat(first.id).updatedAt).toBe(before.updatedAt);
  expect(
    store
      .since(cursor)
      .map((event) => ({ type: event.type, data: event.data })),
  ).toEqual([
    {
      type: "agent.context.updated",
      data: { chatId: first.id, messageId: firstRoot.id, contextUsage: null },
    },
    {
      type: "agent.context.updated",
      data: { chatId: first.id, messageId: secondRoot.id, contextUsage: null },
    },
  ]);
  const clearCursor = lastEventId();
  store.clearContextUsage(first.id);
  expect(store.since(clearCursor)).toEqual([]);
});

it.each(["codex", "claude"] as const)(
  "invalidates %s context before publishing changed model settings",
  (provider) => {
    const first = chat(provider);
    const message = store.message(first.id, turn(first.id), "user", "Request", {
      contextUsage: { ...snapshot, provider },
    });
    const cursor = lastEventId();
    store.updateChat(first.id, {
      modelSettings: { model: "another-model", reasoningEffort: "high" },
    });
    expect(
      store.conversation(first.id).messages[0].details?.contextUsage,
    ).toBeNull();
    expect(store.since(cursor).map((event) => event.type)).toEqual([
      "agent.context.updated",
      "chat.updated",
    ]);
    expect(store.since(cursor)[0].data).toEqual({
      chatId: first.id,
      messageId: message.id,
      contextUsage: null,
    });
  },
);

it("retains measurements for unchanged settings and approval-only updates", () => {
  const first = chat();
  store.message(first.id, turn(first.id), "user", "Request", {
    contextUsage: snapshot,
  });
  const cursor = lastEventId();
  store.updateChat(first.id, {
    modelSettings: { reasoningEffort: "high", model: "test-model" },
  });
  store.updateChat(first.id, { autoApprove: true });
  expect(
    store.conversation(first.id).messages[0].details?.contextUsage,
  ).toEqual(snapshot);
  expect(store.since(cursor).map((event) => event.type)).toEqual([
    "chat.updated",
    "chat.updated",
  ]);
});
