import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/server/app";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";
import { loadEditorDocuments } from "../src/client/agents/useEditorSync";

let root: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let headers: Record<string, string>;
let workspace: string;
let key: string;
let bodies: { migrationId: string; documents: { id: string; sql: string }[] }[];
let loseReplyAt: number;
const draft = (sql: string) => ({
  id: randomUUID(),
  name: "draft.sql",
  connectionId: "",
  sql,
});
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-draft-import-")));
  vi.stubEnv("MIRACLE_INSTALL_ROOT", join(root, "install"));
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  });
  app = await buildApp({
    projectRoot: root,
    dataDir: join(root, ".miracle"),
    appOrigin: "http://127.0.0.1:3036",
    serveStatic: false,
  });
  const response = await app.inject({
    url: "/api/session",
    headers: { host: "127.0.0.1:3036" },
  });
  const session = response.json();
  workspace = session.workspaceId;
  key = `miracle:sql-tabs:${workspace}`;
  headers = {
    host: "127.0.0.1:3036",
    origin: "http://127.0.0.1:3036",
    cookie: String(response.headers["set-cookie"]).split(";")[0],
    "x-csrf-token": session.csrfToken,
    "content-type": "application/json",
  };
  bodies = [];
  loseReplyAt = -1;
  vi.mocked(api).mockImplementation(async (url, options) => {
    const payload = options?.body as string | undefined;
    if (payload) bodies.push(JSON.parse(payload));
    const response = await app.inject({
      method: payload ? "POST" : "GET",
      url,
      headers,
      ...(payload ? { payload } : {}),
    });
    if (response.statusCode >= 400)
      throw new Error(`${response.statusCode}: ${response.body}`);
    if (payload && bodies.length === loseReplyAt)
      throw new Error("Reply lost after commit");
    return response.json();
  });
});
afterEach(async () => {
  await app?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(api).mockReset();
});

it("imports nine large old SQL tabs in bounded requests", async () => {
  const drafts = Array.from({ length: 9 }, () => draft("x".repeat(240000)));
  localStorage.setItem(key, JSON.stringify(drafts));
  const documents = await loadEditorDocuments(workspace);
  expect(documents.map((d) => d.sql)).toEqual(drafts.map((d) => d.sql));
  expect(bodies.length).toBeGreaterThan(1);
  for (const body of bodies)
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  expect(localStorage.getItem(`${key}:imported`)).toBe("1");
});

it("counts UTF-8 bytes and respects the server's 200-document batch limit", async () => {
  const drafts = [
    ...Array.from({ length: 3 }, () => draft("界".repeat(240000))),
    ...Array.from({ length: 205 }, () => draft("SELECT '🙂'")),
  ];
  localStorage.setItem(key, JSON.stringify(drafts));
  expect(await loadEditorDocuments(workspace)).toHaveLength(drafts.length);
  for (const body of bodies) {
    expect(body.documents.length).toBeLessThanOrEqual(200);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      1024 * 1024,
    );
  }
});

it("accepts a single valid maximum-length Unicode draft only on the migration route", async () => {
  const value = draft("界".repeat(1000000));
  localStorage.setItem(key, JSON.stringify([value]));
  const imported = await loadEditorDocuments(workspace);
  expect(imported[0].sql).toBe(value.sql);
  expect(Buffer.byteLength(JSON.stringify(bodies[0]))).toBeLessThan(
    8 * 1024 * 1024,
  );
  const ordinary = await app.inject({
    method: "POST",
    url: "/api/editor-documents",
    headers,
    payload: JSON.stringify({ ...value, id: randomUUID() }),
  });
  expect(ordinary.statusCode).toBe(413);
});

it("replays committed batches after a lost response without duplicates or early completion", async () => {
  const drafts = Array.from({ length: 9 }, () => draft("x".repeat(240000)));
  const saved = JSON.stringify(drafts);
  localStorage.setItem(key, saved);
  loseReplyAt = 2;
  await expect(loadEditorDocuments(workspace)).rejects.toThrow(
    "Reply lost after commit",
  );
  expect(localStorage.getItem(`${key}:imported`)).toBeNull();
  expect(localStorage.getItem(key)).toBe(saved);
  const original = [...bodies];
  loseReplyAt = -1;
  const imported = await loadEditorDocuments(workspace);
  expect(new Set(imported.map((d) => d.id)).size).toBe(9);
  expect(imported).toHaveLength(9);
  expect(bodies[2].migrationId).toBe(original[0].migrationId);
  expect(bodies[3].migrationId).toBe(original[1].migrationId);
  expect(localStorage.getItem(`${key}:imported`)).toBe("1");
});

it("does not reuse an acknowledged batch id when legacy tabs change before retry", async () => {
  const drafts = Array.from({ length: 9 }, () => draft("x".repeat(240000)));
  localStorage.setItem(key, JSON.stringify(drafts));
  loseReplyAt = 2;
  await expect(loadEditorDocuments(workspace)).rejects.toThrow();
  const originalId = bodies[0].migrationId;
  const added = draft("SELECT 'newly recovered'");
  localStorage.setItem(key, JSON.stringify([added, ...drafts]));
  loseReplyAt = -1;
  const imported = await loadEditorDocuments(workspace);
  expect(imported).toHaveLength(10);
  expect(imported.some((d) => d.id === added.id && d.sql === added.sql)).toBe(
    true,
  );
  expect(bodies[2].migrationId).not.toBe(originalId);
});
