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
import { callMiracleTool } from "../src/server/agents/tools";

vi.mock("../src/server/agents/adapter", () => ({ startAgentTurn: vi.fn() }));
let root: string,
  db: Database,
  store: ProjectStore,
  manager: AgentManager,
  chatId: string;
let finish: () => void;
let services: AgentToolServices;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-tool-activity-")));
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
  services = {
    connections: vi.fn(() => []),
    schema: vi.fn(async () => ({ items: [] })),
    run: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(),
    result: vi.fn(),
    rows: vi.fn(),
  };
  manager = new AgentManager(
    store,
    new WorkspaceOperations(store, async () => {}),
    services,
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
  const profile = store.saveProfile({
    name: "Test",
    provider: "codex",
    command: "codex",
  });
  chatId = store.createChat({ profileId: profile.id }).id;
  manager.start(chatId, {
    content: "Inspect the project",
    context: {},
    clientRequestId: randomUUID(),
  });
  await Promise.resolve();
});
afterEach(async () => {
  finish?.();
  await manager.close();
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
const actions = () =>
  store
    .conversation(chatId)
    .messages.filter((message) => message.role === "action");
const call = (name: string, args: unknown = {}) =>
  callMiracleTool(manager, manager.active!, name, args);

it("persists a running step before asynchronous work and completes the same call identity", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(services.schema).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = call("read_schema", { connectionId: randomUUID() });
  expect(actions()).toHaveLength(1);
  expect(actions()[0].details).toMatchObject({
    source: "miracle",
    tool: "read_schema",
    phase: "started",
    status: "running",
  });
  resolve({ items: [{ name: "orders" }, { name: "customers" }] });
  await pending;
  const records = actions();
  expect(records).toHaveLength(2);
  expect(records[1].details).toMatchObject({
    id: records[0].details!.id,
    phase: "completed",
    status: "completed",
    summary: "Получено объектов: 2",
  });
  expect(records[1].details!.durationMs).toBeGreaterThanOrEqual(0);
});

it("keeps identical repeated tool calls distinct and reloads their lifecycle metadata", async () => {
  await call("list_connections");
  await call("list_connections");
  const records = actions();
  expect(records).toHaveLength(4);
  expect(records[0].details!.id).toBe(records[1].details!.id);
  expect(records[2].details!.id).toBe(records[3].details!.id);
  expect(records[0].details!.id).not.toBe(records[2].details!.id);
  expect(
    store
      .since(0)
      .filter(
        (event) =>
          event.type === "agent.event" &&
          (event.data as { role?: string }).role === "action",
      ),
  ).toHaveLength(4);
});

it("records invalid tool arguments without persisting the submitted payload", async () => {
  await expect(
    call("read_schema", { connectionId: "secret-token", sql: "private SQL" }),
  ).rejects.toThrow();
  expect(actions()).toHaveLength(2);
  expect(actions()[1].details).toMatchObject({
    phase: "completed",
    status: "failed",
    summary: "Некорректные параметры действия",
  });
  expect(JSON.stringify(actions())).not.toMatch(/secret-token|private SQL/);
});

it("keeps execution errors generic even when the service error contains credentials and SQL", async () => {
  vi.mocked(services.schema).mockRejectedValue(
    new Error("password=hidden SELECT private FROM data"),
  );
  await expect(
    call("read_schema", { connectionId: randomUUID() }),
  ).rejects.toThrow("password=hidden");
  expect(actions()[1].details).toMatchObject({
    status: "failed",
    summary: "Не удалось выполнить действие",
  });
  expect(JSON.stringify(actions())).not.toMatch(/hidden|SELECT private/);
});

it("bounds named resource summaries and never copies connection credentials", async () => {
  vi.mocked(services.connections).mockReturnValue(
    Array.from({ length: 20 }, (_, i) => ({
      id: randomUUID(),
      name: `Connection ${i} ${"x".repeat(500)}`,
      password: "DO_NOT_LOG",
      url: "https://user:password@example.test",
    })),
  );
  await call("list_connections");
  const details = actions()[1].details!;
  expect(details.summary).toBe("Найдено подключений: 20");
  expect(details.resources).toHaveLength(6);
  expect(
    (details.resources as { label: string }[]).every(
      (value) => value.label.length <= 120,
    ),
  ).toBe(true);
  expect(JSON.stringify(actions())).not.toMatch(/DO_NOT_LOG|https:|password/);
});

it("reports only the returned result page row count, without row contents or SQL", async () => {
  vi.mocked(services.result).mockResolvedValue({
    id: randomUUID(),
    rowCount: 1000,
    source: { sql: "SELECT sensitive FROM table" },
  } as never);
  vi.mocked(services.rows).mockResolvedValue([
    { secret: "ROW_SECRET" },
    { secret: "ROW_SECRET" },
  ]);
  await call("read_result", { id: randomUUID() });
  expect(actions()[1].details).toMatchObject({ summary: "Получено строк: 2" });
  expect(JSON.stringify(actions())).not.toMatch(/ROW_SECRET|SELECT sensitive/);
});

it("reports run_query as launched rather than SQL execution completed", async () => {
  vi.mocked(services.run).mockResolvedValue({
    id: randomUUID(),
    status: "running",
    sql: "SELECT private",
  } as never);
  await call("run_query", {
    connectionId: randomUUID(),
    sql: "SELECT private",
    mutationId: randomUUID(),
  });
  expect(actions()[1].details).toMatchObject({
    status: "completed",
    summary: "Запрос запущен",
  });
  expect(JSON.stringify(actions())).not.toContain("SELECT private");
});

it("uses the saved editor name and revision without exposing its SQL", async () => {
  const id = randomUUID();
  const result = (await call("create_editor", {
    id,
    name: "Monthly revenue",
    sql: "SELECT SECRET_SOURCE FROM private_table",
    connectionId: "",
  })) as { revision: number };
  expect(actions()[1].details).toMatchObject({
    summary: `Monthly revenue · Версия ${result.revision}`,
    resources: [{ id, label: "Monthly revenue" }],
  });
  expect(JSON.stringify(actions())).not.toMatch(/SECRET_SOURCE|private_table/);
});

it("records cancellation while the original task still owns the pending tool", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(services.schema).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const active = manager.active!;
  const pending = call("read_schema", { connectionId: randomUUID() });
  active.cancelled = true;
  resolve({ items: [] });
  await expect(pending).rejects.toThrow();
  expect(actions()).toHaveLength(2);
  expect(actions()[1].details).toMatchObject({
    status: "cancelled",
    summary: "Действие отменено",
  });
});

it("does not append successful work after its original agent task has ended", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(services.schema).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const active = manager.active!;
  const pending = call("read_schema", { connectionId: randomUUID() });
  finish();
  await active.completion;
  resolve({ items: [] });
  await expect(pending).rejects.toThrow();
  expect(actions()).toHaveLength(1);
  expect(actions()[0].details?.status).toBe("running");
});

it("keeps permission callbacks in their existing approval flow without tool steps", async () => {
  manager.updateChat(chatId, { autoApprove: true });
  await expect(
    call("permission_prompt", { tool_name: "Bash", input: { command: "pwd" } }),
  ).resolves.toMatchObject({ behavior: "allow" });
  expect(actions()).toHaveLength(0);
});
