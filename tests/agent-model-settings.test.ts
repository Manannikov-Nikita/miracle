import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Database, migrate, WORKSPACE_SCHEMA_VERSION } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";
import {
  AgentManager,
  type AgentToolServices,
} from "../src/server/agents/manager";
import { startAgentTurn } from "../src/server/agents/adapter";
import Fastify from "fastify";
import { registerProjectRoutes } from "../src/server/project-routes";
import { discoverCodexModels } from "../src/server/agents/codex-models";
import { removeDatasetSchema } from "./helpers/legacy-workspace";

vi.mock("../src/server/agents/adapter", () => ({ startAgentTurn: vi.fn() }));
vi.mock("../src/server/agents/codex-models", () => ({
  discoverCodexModels: vi.fn(),
}));
let root: string, db: Database, store: ProjectStore, manager: AgentManager;
const settings = { model: "test-model", reasoningEffort: "high" };
beforeEach(() => {
  vi.mocked(discoverCodexModels).mockReset();
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-model-settings-")));
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
      completion: Promise.resolve({ sessionId: "native" }),
      cancel: async () => {},
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
function chat(
  provider: "codex" | "claude" = "codex",
  modelSettings?: typeof settings,
) {
  const profile = store.saveProfile({
    name: "Test",
    provider,
    command: provider,
  });
  return store.createChat({ profileId: profile.id, modelSettings });
}
async function run(chatId: string) {
  manager.start(chatId, { content: "Hello", clientRequestId: randomUUID() });
  await manager.active!.completion;
  return vi.mocked(startAgentTurn).mock.calls.at(-1)![0];
}

it("persists choices per chat and keeps approval and profile command independent", () => {
  const first = chat("codex", settings);
  const second = store.createChat({ profileId: first.profileId });
  expect(store.chat(first.id).modelSettings).toEqual(settings);
  expect(store.chat(second.id).modelSettings).toBeUndefined();
  store.updateChat(first.id, { autoApprove: true });
  expect(store.chat(first.id).modelSettings).toEqual(settings);
  store.updateChat(first.id, { modelSettings: {} });
  expect(store.chat(first.id)).toMatchObject({
    autoApprove: true,
    modelSettings: {},
  });
  expect(store.profile(first.profileId).command).toBe("codex");
});

it("validates settings without restricting future provider reasoning values", () => {
  const first = chat();
  expect(
    store.updateChat(first.id, {
      modelSettings: { model: "model-v2", reasoningEffort: "ultra" },
    }).modelSettings?.reasoningEffort,
  ).toBe("ultra");
  for (const value of [
    { model: "" },
    { model: "a\nb" },
    { model: "x".repeat(513) },
    { reasoningEffort: 3 },
    { unknown: true },
  ])
    expect(() =>
      store.updateChat(first.id, { modelSettings: value }),
    ).toThrow();
  expect(() => store.updateChat(first.id, {})).toThrow();
});

it("passes saved choices to the adapter and preserves Codex resume", async () => {
  const first = chat("codex", settings);
  db.query("UPDATE agent_chats SET native_session_id='previous' WHERE id=?1", [
    first.id,
  ]);
  const options = await run(first.id);
  expect(options).toMatchObject({
    modelSettings: settings,
    resumeSessionId: "previous",
  });
  expect((await run(chat().id)).modelSettings).toBeUndefined();
});

it("refuses model changes during a turn while still allowing approval changes", async () => {
  let finish!: () => void;
  vi.mocked(startAgentTurn).mockImplementationOnce(() => ({
    completion: new Promise<any>((resolve) => {
      finish = () => resolve({});
    }),
    cancel: async () => finish(),
    respond: () => {},
  }));
  const first = chat();
  manager.start(first.id, { content: "Wait", clientRequestId: randomUUID() });
  await Promise.resolve();
  expect(() => store.updateChat(first.id, { modelSettings: settings })).toThrow(
    /завершения/,
  );
  expect(store.updateChat(first.id, { autoApprove: true }).autoApprove).toBe(
    true,
  );
  finish();
  await manager.active!.completion;
});

it("starts Claude with saved history after changing settings, preserving the chat", async () => {
  const first = chat("claude", settings);
  store.message(first.id, undefined, "user", "Keep this context");
  db.query("UPDATE agent_chats SET native_session_id='previous' WHERE id=?1", [
    first.id,
  ]);
  store.updateChat(first.id, { modelSettings: {} });
  const options = await run(first.id);
  expect(options.resumeSessionId).toBeUndefined();
  expect(options.modelSettings).toEqual({});
  expect(options.prompt).toContain("Keep this context");
  expect(
    store
      .conversation(first.id)
      .messages.some((m) => m.content.includes("Настройки модели изменены")),
  ).toBe(true);
});

it("does not restart Claude when saving unchanged choices", async () => {
  const first = chat("claude", settings);
  db.query("UPDATE agent_chats SET native_session_id='previous' WHERE id=?1", [
    first.id,
  ]);
  store.updateChat(first.id, { modelSettings: settings });
  expect((await run(first.id)).resumeSessionId).toBe("previous");
});

it("explicitly resets a legacy Claude session to its profile defaults", async () => {
  const first = chat("claude");
  db.query("UPDATE agent_chats SET native_session_id='previous' WHERE id=?1", [
    first.id,
  ]);
  store.updateChat(first.id, { modelSettings: {} });
  expect((await run(first.id)).resumeSessionId).toBeUndefined();
});

it("keeps the legacy Codex launch path when no override was ever chosen", async () => {
  const first = chat();
  store.updateChat(first.id, { modelSettings: {} });
  expect(store.chat(first.id).modelSettings).toBeUndefined();
  expect((await run(first.id)).modelSettings).toBeUndefined();
  expect(
    store.createChat({ profileId: first.profileId, modelSettings: {} })
      .modelSettings,
  ).toBeUndefined();
});

it("migrates v6 chats without changing their history or defaults", () => {
  const first = chat();
  store.message(first.id, undefined, "user", "Preserved");
  removeDatasetSchema(db);
  db.sqlite.exec(
    "ALTER TABLE agent_chats DROP COLUMN model_settings_json; ALTER TABLE agent_chats DROP COLUMN native_session_reset; DROP TABLE board_images; PRAGMA user_version=6;",
  );
  migrate(db);
  migrate(db);
  expect(db.sqlite.prepare("PRAGMA user_version").get()!.user_version).toBe(
    WORKSPACE_SCHEMA_VERSION,
  );
  expect(store.chat(first.id).modelSettings).toBeUndefined();
  expect(store.conversation(first.id).messages[0].content).toBe("Preserved");
});

it("discovers models through the trusted profile command without returning it", async () => {
  const first = chat();
  const app = Fastify();
  const need = vi.fn();
  registerProjectRoutes(app, store, need);
  const catalog = {
    models: [
      {
        id: "test-model",
        name: "Test model",
        reasoningEfforts: [{ id: "high" }],
      },
    ],
  };
  vi.mocked(discoverCodexModels).mockResolvedValue(catalog);
  try {
    const response = await app.inject({
      url: `/api/agent-profiles/${first.profileId}/models`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(catalog);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(need).toHaveBeenCalledOnce();
    expect(discoverCodexModels).toHaveBeenCalledWith(
      "codex",
      root,
      expect.any(AbortSignal),
    );
  } finally {
    await app.close();
  }
});

it("never launches discovery for an untrusted profile", async () => {
  const first = chat();
  const profile = store.profile(first.profileId);
  const spy = vi
    .spyOn(store, "profile")
    .mockReturnValue({ ...profile, trusted: false });
  const app = Fastify();
  registerProjectRoutes(app, store, () => {});
  try {
    const response = await app.inject({
      url: `/api/agent-profiles/${first.profileId}/models`,
    });
    expect(response.statusCode).toBe(403);
    expect(discoverCodexModels).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    await app.close();
  }
});

it("rejects a catalog if its profile was edited while discovery was running", async () => {
  const first = chat();
  const app = Fastify();
  registerProjectRoutes(app, store, () => {});
  vi.mocked(discoverCodexModels).mockImplementation(async () => {
    store.saveProfile(
      { name: "Changed", provider: "codex", command: "codex -c changed=true" },
      first.profileId,
    );
    return { models: [] };
  });
  try {
    const response = await app.inject({
      url: `/api/agent-profiles/${first.profileId}/models`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("AGENT_PROFILE_CHANGED");
  } finally {
    await app.close();
  }
});
