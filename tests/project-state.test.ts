import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/server/app.js";

const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), "miracle-project-state-"));
  dirs.push(path);
  return path;
};
async function open(root = dir(), port = 3001) {
  vi.stubEnv("MIRACLE_INSTALL_ROOT", join(root, "install"));
  const app = await buildApp({
    dataDir: join(root, ".miracle"),
    projectRoot: root,
    appOrigin: `http://127.0.0.1:${port}`,
    serveStatic: false,
  } as any);
  apps.push(app);
  const session = await app.inject({
    url: "/api/session",
    headers: { host: `127.0.0.1:${port}` },
  });
  const headers = {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    cookie: String(session.headers["set-cookie"]).split(";")[0]!,
    "x-csrf-token": session.json().csrfToken,
  };
  const request = (method: any, url: string, payload?: any) =>
    app.inject({ method, url, headers, payload });
  return { app, root, headers, session, request };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of dirs.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("persists revisioned editor documents, rejects stale writes, and deduplicates a retried edit", async () => {
  const s = await open();
  const created = await s.request("POST", "/api/editor-documents", {
    name: "analysis.sql",
    sql: "select 1",
    connectionId: "",
  });
  expect(created.statusCode, created.body).toBe(201);
  const doc = created.json();
  const payload = {
    baseRevision: doc.revision,
    mutationId: randomUUID(),
    sql: "select 2",
  };
  const saved = await s.request(
    "PATCH",
    `/api/editor-documents/${doc.id}`,
    payload,
  );
  expect(saved.json()).toMatchObject({ sql: "select 2", revision: 2 });
  expect(
    (
      await s.request("PATCH", `/api/editor-documents/${doc.id}`, payload)
    ).json(),
  ).toEqual(saved.json());
  expect(
    (
      await s.request("PATCH", `/api/editor-documents/${doc.id}`, {
        ...payload,
        mutationId: randomUUID(),
        sql: "select 3",
      })
    ).statusCode,
  ).toBe(409);
  expect(
    (
      await s.request("PATCH", `/api/editor-documents/${doc.id}`, {
        ...payload,
        sql: "select 4",
      })
    ).statusCode,
  ).toBe(409);
  await s.app.close();
  const next = await open(s.root);
  expect((await next.request("GET", "/api/editor-documents")).json()).toEqual([
    saved.json(),
  ]);
});
it("imports legacy tabs once without duplicating or overwriting newer server edits", async () => {
  const s = await open();
  const id = randomUUID();
  const body = {
    migrationId: "legacy-browser-1",
    documents: [
      { id, name: "old.sql", sql: "select 1", connectionId: "", revision: 7 },
    ],
  };
  const imported = await s.request(
    "POST",
    "/api/editor-documents/import",
    body,
  );
  expect(imported.statusCode, imported.body).toBe(200);
  expect(imported.json()[0]).toMatchObject({
    id,
    queryRevision: 7,
    revision: 1,
  });
  await s.request("PATCH", `/api/editor-documents/${id}`, {
    baseRevision: 1,
    mutationId: randomUUID(),
    sql: "select 2",
  });
  await s.request("POST", "/api/editor-documents/import", body);
  expect(
    (await s.request("GET", "/api/editor-documents")).json(),
  ).toMatchObject([{ id, sql: "select 2" }]);
});
it("isolates cookies by port and rejects an old instance header after a restart", async () => {
  const a = await open(undefined, 3001),
    b = await open(undefined, 3002);
  expect(a.headers.cookie.split("=")[0]).not.toBe(
    b.headers.cookie.split("=")[0],
  );
  expect(a.session.json().instanceId).toBeTruthy();
  const bad = await a.app.inject({
    url: "/api/project",
    headers: { ...a.headers, "x-miracle-instance": "old-instance" },
  });
  expect(bad.statusCode).toBe(409);
  expect((await a.request("GET", "/api/project")).json()).toMatchObject({
    projectRoot: a.root,
    dataDir: join(a.root, ".miracle"),
  });
});
it("encrypts launch commands at rest and keeps chat provider fixed", async () => {
  const s = await open();
  const profile = await s.request("POST", "/api/agent-profiles", {
    name: "Local",
    provider: "codex",
    command: "MY_PRIVATE_VAR=very-private-value /bin/codex --model example",
  });
  expect(profile.statusCode, profile.body).toBe(201);
  expect(profile.json().trusted).toBe(true);
  const chat = await s.request("POST", "/api/chats", {
    profileId: profile.json().id,
  });
  expect(chat.statusCode, chat.body).toBe(201);
  expect(chat.json().provider).toBe("codex");
  expect(
    (
      await s.request("PATCH", `/api/agent-profiles/${profile.json().id}`, {
        name: "Changed",
        provider: "claude",
        command: "claude",
      })
    ).statusCode,
  ).toBe(409);
  expect(
    readFileSync(join(s.root, ".miracle/miracle.sqlite")).includes(
      Buffer.from("very-private-value"),
    ),
  ).toBe(false);
});

const waitFor = async <T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
) => {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Timed out waiting for agent state");
};
const fixtureCommand = (provider: string, scenario: string) =>
  `FIXTURE_PROVIDER=${provider} FIXTURE_SCENARIO=${scenario} '${process.execPath}' '${resolve("tests/fixtures/agents/provider.mjs")}'`;
it("runs a persisted conversation independently of the browser and deduplicates sends", async () => {
  const s = await open();
  const profile = (
    await s.request("POST", "/api/agent-profiles", {
      name: "Fixture",
      provider: "claude",
      command: fixtureCommand("claude", "normal"),
    })
  ).json();
  const chat = (
    await s.request("POST", "/api/chats", { profileId: profile.id })
  ).json();
  const payload = {
    content: "Read the fixture",
    clientRequestId: randomUUID(),
    context: {},
  };
  const sent = await s.request(
    "POST",
    `/api/chats/${chat.id}/messages`,
    payload,
  );
  expect(sent.statusCode, sent.body).toBe(202);
  const duplicate = await s.request(
    "POST",
    `/api/chats/${chat.id}/messages`,
    payload,
  );
  expect(duplicate.json().id).toBe(sent.json().id);
  const conversation = await waitFor(
    async () => (await s.request("GET", `/api/chats/${chat.id}`)).json(),
    (c) => c.turns[0]?.status === "completed",
  );
  expect(
    conversation.messages.filter((m: any) => m.role === "user"),
  ).toHaveLength(1);
  expect(
    conversation.messages.find((m: any) => m.role === "assistant").content,
  ).toBe("Hello 🌍");
  await s.app.close();
  const again = await open(s.root);
  expect(
    (await again.request("GET", `/api/chats/${chat.id}`)).json().messages,
  ).toEqual(conversation.messages);
});
it("enforces one active turn, supports native approvals and cancels owned work", async () => {
  const s = await open();
  const p = (
    await s.request("POST", "/api/agent-profiles", {
      name: "Fixture",
      provider: "codex",
      command: fixtureCommand("codex", "normal"),
    })
  ).json();
  const c = (await s.request("POST", "/api/chats", { profileId: p.id })).json();
  const sent = await s.request("POST", `/api/chats/${c.id}/messages`, {
    content: "Go",
    clientRequestId: randomUUID(),
    context: {},
  });
  expect(sent.statusCode, sent.body).toBe(202);
  const waiting = await waitFor(
    async () => (await s.request("GET", `/api/chats/${c.id}`)).json(),
    (v) => v.turns[0]?.status === "waiting",
  );
  expect(
    (
      await s.request("POST", `/api/chats/${c.id}/messages`, {
        content: "duplicate active",
        clientRequestId: randomUUID(),
        context: {},
      })
    ).statusCode,
  ).toBe(409);
  expect(
    waiting.messages.find((m: any) => m.role === "approval").details.approvalId,
  ).toBeTruthy();
  expect(
    (await s.request("POST", `/api/agent-turns/${sent.json().id}/cancel`, {}))
      .statusCode,
  ).toBe(200);
  expect(
    (await s.request("GET", "/api/agent-state")).json().activeTurn,
  ).toBeNull();
  expect(
    (await s.request("GET", `/api/chats/${c.id}`)).json().turns[0].status,
  ).toBe("cancelled");
});

it("guards query and board deletion against newer revisions and deduplicates retries", async () => {
  const s = await open();
  const connection = (
    await s.request("POST", "/api/connections", {
      name: "Fixture",
      engine: "clickhouse",
      url: "http://127.0.0.1:18123",
      username: "default",
      password: "",
      database: "demo",
    })
  ).json();
  for (const kind of ["queries", "boards"]) {
    const payload =
      kind === "queries"
        ? { name: "Original", sql: "select 1", connectionId: connection.id }
        : {
            name: "Original",
            document: { schemaVersion: 1, nodes: [], edges: [] },
          };
    const created = (await s.request("POST", `/api/${kind}`, payload)).json();
    const updated = await s.request("PATCH", `/api/${kind}/${created.id}`, {
      ...payload,
      name: "Agent edit",
      baseRevision: created.revision,
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const stale = await s.request("DELETE", `/api/${kind}/${created.id}`, {
      baseRevision: created.revision,
      mutationId: randomUUID(),
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const deletion = {
      baseRevision: updated.json().revision,
      mutationId: randomUUID(),
    };
    expect(
      (await s.request("DELETE", `/api/${kind}/${created.id}`, deletion))
        .statusCode,
    ).toBe(200);
    expect(
      (await s.request("DELETE", `/api/${kind}/${created.id}`, deletion))
        .statusCode,
    ).toBe(200);
  }
});

it("publishes approval resolution before a later prompt and persists cancellation resolution", async () => {
  const s = await open();
  const profile = (
    await s.request("POST", "/api/agent-profiles", {
      name: "Approval fixture",
      provider: "codex",
      command: fixtureCommand("codex", "normal"),
    })
  ).json();
  const chat = (
    await s.request("POST", "/api/chats", { profileId: profile.id })
  ).json();
  const turn = (
    await s.request("POST", `/api/chats/${chat.id}/messages`, {
      content: "Go",
      clientRequestId: randomUUID(),
      context: {},
    })
  ).json();
  const c = await waitFor(
    async () => (await s.request("GET", `/api/chats/${chat.id}`)).json(),
    (c) => c.turns[0]?.status === "waiting",
  );
  const prompt = c.messages.find((m: any) => m.role === "approval");
  const answer = await s.request(
    "POST",
    `/api/agent-approvals/${prompt.details.approvalId}`,
    { decision: "allow" },
  );
  expect(answer.statusCode, answer.body).toBe(200);
  const events = (s.app as any).miracle.db
    .query("SELECT payload FROM project_events WHERE type='agent.event'")
    .rows.map((r: any) => JSON.parse(r.payload));
  expect(
    events.some(
      (m: any) => m.id === prompt.id && m.details?.decision === "allow",
    ),
  ).toBe(true);
  await waitFor(
    async () => (await s.request("GET", `/api/chats/${chat.id}`)).json(),
    (c) => c.messages.filter((m: any) => m.role === "approval").length === 2,
  );
  await s.request("POST", `/api/agent-turns/${turn.id}/cancel`, {});
  const done = (await s.request("GET", `/api/chats/${chat.id}`)).json();
  expect(
    done.messages
      .filter((m: any) => m.role === "approval")
      .every((m: any) => m.details?.resolved === true),
  ).toBe(true);
});

it("marks an unfinished persisted turn interrupted on restart without replay", async () => {
  const s = await open();
  const profile = (
    await s.request("POST", "/api/agent-profiles", {
      name: "Fixture",
      provider: "claude",
      command: fixtureCommand("claude", "normal"),
    })
  ).json();
  const chat = (
    await s.request("POST", "/api/chats", { profileId: profile.id })
  ).json();
  const turnId = randomUUID();
  (s.app as any).miracle.db.query(
    "INSERT INTO agent_turns(id,chat_id,request_id,status,context_json,created_at) VALUES(?1,?2,?3,'running','{}',?4)",
    [turnId, chat.id, randomUUID(), new Date().toISOString()],
  );
  await s.app.close();
  const next = await open(s.root);
  const conversation = (
    await next.request("GET", `/api/chats/${chat.id}`)
  ).json();
  expect(conversation.turns).toHaveLength(1);
  expect(conversation.turns[0]).toMatchObject({
    id: turnId,
    status: "interrupted",
  });
  expect(
    conversation.messages.filter((m: any) => m.role === "assistant"),
  ).toHaveLength(0);
  expect(
    (await next.request("GET", "/api/agent-state")).json().activeTurn,
  ).toBeNull();
});

it("requires local profile confirmation after a stopped project is copied", async () => {
  const s = await open();
  const profile = (
    await s.request("POST", "/api/agent-profiles", {
      name: "Fixture",
      provider: "claude",
      command: fixtureCommand("claude", "normal"),
    })
  ).json();
  const chat = (
    await s.request("POST", "/api/chats", { profileId: profile.id })
  ).json();
  await s.app.close();
  const copiedRoot = dir();
  cpSync(join(s.root, ".miracle"), join(copiedRoot, ".miracle"), {
    recursive: true,
  });
  const copied = await open(copiedRoot);
  expect(
    (await copied.request("GET", "/api/agent-profiles")).json()[0].trusted,
  ).toBe(false);
  expect(
    (
      await copied.request("POST", `/api/chats/${chat.id}/messages`, {
        content: "Go",
        clientRequestId: randomUUID(),
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await copied.request(
        "POST",
        `/api/agent-profiles/${profile.id}/trust`,
        {},
      )
    ).json().trusted,
  ).toBe(true);
});

it("starts a fresh native session with transcript when the saved session is missing", async () => {
  const s = await open(),
    trace = join(s.root, "resume trace.jsonl");
  const profile = (
    await s.request("POST", "/api/agent-profiles", {
      name: "Fixture",
      provider: "codex",
      command: `FIXTURE_TRACE='${trace}' ${fixtureCommand("codex", "normal")}`,
    })
  ).json();
  const chat = (
    await s.request("POST", "/api/chats", { profileId: profile.id })
  ).json();
  const db = (s.app as any).miracle.db;
  db.query("UPDATE agent_chats SET native_session_id='missing' WHERE id=?1", [
    chat.id,
  ]);
  db.query(
    "INSERT INTO agent_messages(id,chat_id,role,content,created_at) VALUES(?1,?2,'assistant','Previous task completed: ORBIT',?3)",
    [randomUUID(), chat.id, new Date().toISOString()],
  );
  await s.request("POST", `/api/chats/${chat.id}/messages`, {
    content: "Continue",
    clientRequestId: randomUUID(),
  });
  const c = await waitFor(
    async () => {
      const value = (await s.request("GET", `/api/chats/${chat.id}`)).json();
      for (const m of value.messages.filter(
        (m: any) => m.role === "approval" && !m.details.resolved,
      ))
        await s.request(
          "POST",
          `/api/agent-approvals/${m.details.approvalId}`,
          { decision: "allow" },
        );
      return value;
    },
    (c) => c.turns[0]?.status === "completed",
  );
  expect(
    c.messages.some(
      (m: any) =>
        m.role === "system" &&
        m.content.includes("Исходная сессия CLI недоступна"),
    ),
  ).toBe(true);
  const wire = readFileSync(trace, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).wire)
    .filter(Boolean);
  expect(wire.filter((m) => m.method === "thread/resume")).toHaveLength(1);
  expect(wire.filter((m) => m.method === "turn/start")).toHaveLength(1);
  expect(
    wire.find((m) => m.method === "turn/start").params.input[0].text,
  ).toContain("Previous task completed: ORBIT");
});
