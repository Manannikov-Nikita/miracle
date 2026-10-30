import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/server/app.js";
const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const origin = "http://127.0.0.1:3001";
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "miracle-local-"));
  dirs.push(d);
  return d;
};
async function open(dataDir = dir()) {
  const app = await buildApp({
    dataDir,
    appOrigin: origin,
    serveStatic: false,
  });
  apps.push(app);
  return app;
}
async function session(app: Awaited<ReturnType<typeof buildApp>>) {
  const r = await app.inject({
    url: "/api/session",
    headers: { host: "127.0.0.1:3001" },
  });
  expect(r.statusCode, r.body).toBe(200);
  return {
    body: r.json(),
    headers: {
      host: "127.0.0.1:3001",
      origin,
      cookie: String(r.headers["set-cookie"]).split(";")[0]!,
      "x-csrf-token": r.json().csrfToken,
    },
    cookie: r.headers["set-cookie"],
  };
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("opens directly, persists workspace and JSON content across restart, and rejects stale revisions", async () => {
  const dataDir = dir();
  let app = await open(dataDir);
  const s = await session(app);
  expect(s.body.workspaceId).toMatch(/^[a-f0-9-]{36}$/);
  expect(s.body.csrfToken).toHaveLength(43);
  expect(s.cookie).toContain("HttpOnly");
  expect(s.cookie).toContain("SameSite=Strict");
  const r = await app.inject({
    method: "POST",
    url: "/api/boards",
    headers: s.headers,
    payload: { name: "Personal" },
  });
  expect(r.statusCode, r.body).toBe(201);
  const board = r.json();
  await app.close();
  app = await open(dataDir);
  const next = await session(app);
  expect(next.body.workspaceId).toBe(s.body.workspaceId);
  const got = await app.inject({
    url: `/api/boards/${board.id}`,
    headers: next.headers,
  });
  expect(got.json()).toEqual(board);
  const patch = {
    method: "PATCH" as const,
    url: `/api/boards/${board.id}`,
    headers: next.headers,
    payload: {
      baseRevision: board.revision,
      document: board.document,
      name: "Updated",
    },
  };
  expect((await app.inject(patch)).statusCode).toBe(200);
  expect((await app.inject(patch)).statusCode).toBe(409);
});
it("validates Host, every supplied Origin and Fetch Metadata before exposing data; requires session and CSRF", async () => {
  const app = await open();
  const s = await session(app);
  for (const headers of [
    { host: "evil.test" },
    { host: "127.0.0.1:3001", origin: "http://evil.test" },
    { host: "127.0.0.1:3001", "sec-fetch-site": "cross-site" },
  ])
    expect(
      (await app.inject({ url: "/api/session", headers })).statusCode,
    ).toBe(403);
  expect(
    (
      await app.inject({
        url: "/api/boards",
        headers: { host: "127.0.0.1:3001" },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/boards",
        headers: { host: "127.0.0.1:3001", cookie: s.headers.cookie },
        payload: { name: "Bad" },
      })
    ).statusCode,
  ).toBe(403);
  for (const url of ["/api/auth/me", "/api/setup/status", "/api/users"])
    expect((await app.inject({ url, headers: s.headers })).statusCode).toBe(
      404,
    );
});
it("creates a private key only for a new workspace and refuses missing or wrong keys", async () => {
  const dataDir = dir();
  const app = await open(dataDir);
  const key = readFileSync(join(dataDir, "encryption.key"));
  await app.close();
  writeFileSync(
    join(dataDir, "encryption.key"),
    Buffer.alloc(32, 9).toString("base64"),
  );
  await expect(open(dataDir)).rejects.toThrow(/key.*match/i);
  unlinkSync(join(dataDir, "encryption.key"));
  await expect(open(dataDir)).rejects.toThrow(/missing.*key|key.*missing/i);
  writeFileSync(join(dataDir, "encryption.key"), key);
  await open(dataDir);
});
it("control endpoint requires an independent bearer token", async () => {
  const app = await buildApp({
    dataDir: dir(),
    appOrigin: origin,
    controlToken: "private-instance-token",
    serveStatic: false,
  });
  apps.push(app);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/local/control",
        headers: { host: "127.0.0.1:3001" },
        payload: { action: "status" },
      })
    ).statusCode,
  ).toBe(401);
  const r = await app.inject({
    method: "POST",
    url: "/api/local/control",
    headers: {
      host: "127.0.0.1:3001",
      authorization: "Bearer private-instance-token",
    },
    payload: { action: "status" },
  });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toEqual({ ok: true });
});
it("refuses existing workspace without the key sentinel rather than blessing a replacement key", async () => {
  const dataDir = dir();
  const app = await open(dataDir);
  app.miracle.db.query(
    "DELETE FROM app_settings WHERE key='encryption_key_check'",
  );
  await app.close();
  await expect(open(dataDir)).rejects.toThrow(/key.*check.*missing/i);
});

it("keeps concurrent tab bootstraps compatible with the shared browser cookie after restart and expiry", async () => {
  const dataDir = dir();
  let app = await open(dataDir);
  const before = await session(app);
  await app.close();
  app = await open(dataDir);
  const bootstrap = () =>
    app.inject({
      url: "/api/session",
      headers: { host: "127.0.0.1:3001", cookie: before.headers.cookie },
    });
  const tabs = await Promise.all([bootstrap(), bootstrap()]);
  const browserCookie = String(tabs[1].headers["set-cookie"]).split(";")[0]!;
  for (const tab of tabs) {
    expect(tab.statusCode).toBe(200);
    const written = await app.inject({
      method: "POST",
      url: "/api/boards",
      headers: {
        host: "127.0.0.1:3001",
        cookie: browserCookie,
        "x-csrf-token": tab.json().csrfToken,
      },
      payload: { name: "tab" },
    });
    expect(written.statusCode, written.body).toBe(201);
  }
  expect(tabs[0].json().csrfToken).toBe(tabs[1].json().csrfToken);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 604800001);
  try {
    const expired = await app.inject({
      url: "/api/boards",
      headers: { host: "127.0.0.1:3001", cookie: browserCookie },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe("LOCAL_SESSION_EXPIRED");
    const renew = () =>
      app.inject({
        url: "/api/session",
        headers: { host: "127.0.0.1:3001", cookie: browserCookie },
      });
    const renewed = await Promise.all([renew(), renew()]);
    expect(renewed[0].json().csrfToken).toBe(renewed[1].json().csrfToken);
    expect(renewed[0].json().csrfToken).not.toBe(tabs[0].json().csrfToken);
    const nextCookie = String(renewed[1].headers["set-cookie"]).split(";")[0]!;
    const invalid = await app.inject({
      method: "POST",
      url: "/api/boards",
      headers: {
        host: "127.0.0.1:3001",
        cookie: nextCookie,
        "x-csrf-token": tabs[0].json().csrfToken,
      },
      payload: { name: "stale" },
    });
    expect(invalid.statusCode).toBe(403);
    for (const tab of renewed)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/boards",
            headers: {
              host: "127.0.0.1:3001",
              cookie: nextCookie,
              "x-csrf-token": tab.json().csrfToken,
            },
            payload: { name: "renewed" },
          })
        ).statusCode,
      ).toBe(201);
  } finally {
    clock.mockRestore();
  }
});
it.each([
  ["origin", { appOrigin: "not-a-url" }],
  ["origin protocol", { appOrigin: "ftp://127.0.0.1:3001" }],
  ["origin credentials", { appOrigin: "http://user:secret@127.0.0.1:3001" }],
  ["origin path", { appOrigin: "http://127.0.0.1:3001/path" }],
  ["limit", { limits: { maxRows: 0 } }],
  ["control token", { controlToken: "bad\nheader" }],
  ["key", { encryptionKey: Buffer.alloc(1) }],
] as const)(
  "validates %s before any workspace writes and permits corrected retry",
  async (_name, invalid) => {
    const dataDir = dir();
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      app = await buildApp({
        dataDir,
        appOrigin: origin,
        serveStatic: false,
        ...invalid,
      } as any);
    } catch {}
    if (app) {
      apps.push(app);
      await app.close();
    }
    expect(readdirSync(dataDir)).toEqual([]);
    await open(dataDir);
  },
);
it("validates environment limits before creating SQLite/key files", async () => {
  const dataDir = dir();
  vi.stubEnv("MAX_RESULT_ROWS", "bad");
  try {
    await expect(open(dataDir)).rejects.toThrow(/Invalid MAX_RESULT_ROWS/);
    expect(readdirSync(dataDir)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
  await open(dataDir);
});
it("rejects a stale workspace namespace even with the current workspace cookie", async () => {
  const previous = await open();
  const a = await session(previous);
  await previous.close();
  const current = await open();
  const b = await session(current);
  for (const method of ["GET", "POST"] as const) {
    const response = await current.inject({
      method,
      url: "/api/boards",
      headers: { ...b.headers, "x-miracle-workspace": a.body.workspaceId },
      ...(method === "POST" ? { payload: { name: "Must not write" } } : {}),
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe("WORKSPACE_CHANGED");
  }
  expect(current.miracle.db.query("SELECT * FROM boards").rowCount).toBe(0);
  expect(
    (
      await current.inject({
        url: "/api/boards",
        headers: { ...b.headers, "x-miracle-workspace": b.body.workspaceId },
      })
    ).statusCode,
  ).toBe(200);
});
it("identifies a dormant tab stale CSRF before execution after another tab renews the browser cookie", async () => {
  const dataDir = dir();
  let app = await open(dataDir);
  const oldTab = await session(app);
  await app.close();
  app = await open(dataDir);
  const renewedTab = await session(app);
  const headers = {
    ...renewedTab.headers,
    "x-csrf-token": oldTab.body.csrfToken,
  };
  const rejected = await app.inject({
    method: "POST",
    url: "/api/boards",
    headers,
    payload: { name: "Dormant tab" },
  });
  expect(rejected.statusCode).toBe(403);
  expect(rejected.json().code).toBe("LOCAL_SESSION_STALE");
  expect(app.miracle.db.query("SELECT * FROM boards").rowCount).toBe(0);
  const refresh = await app.inject({
    url: "/api/session",
    headers: { host: "127.0.0.1:3001", cookie: renewedTab.headers.cookie },
  });
  expect(refresh.statusCode).toBe(200);
  const written = await app.inject({
    method: "POST",
    url: "/api/boards",
    headers: { ...headers, "x-csrf-token": refresh.json().csrfToken },
    payload: { name: "Dormant tab" },
  });
  expect(written.statusCode, written.body).toBe(201);
  expect(app.miracle.db.query("SELECT * FROM boards").rowCount).toBe(1);
  for (const unsafe of [
    { ...headers, host: "evil.test" },
    { ...headers, origin: "http://evil.test" },
    { ...headers, "sec-fetch-site": "cross-site" },
    { ...headers, "x-csrf-token": "malformed" },
    { ...headers, "x-csrf-token": "" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/boards",
      headers: unsafe,
      payload: { name: "Invalid" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBeUndefined();
  }
});
