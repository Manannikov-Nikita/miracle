import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { buildApp } from "../src/server/app.js";
import * as database from "../src/server/db.js";
import { SecretBox } from "../src/server/secrets.js";
import { dropTestDatabase } from "./test-database.js";

const rootUrl =
  process.env.DATABASE_URL ||
  "postgres://miracle:miracle_local@127.0.0.1:5544/miracle";
const management = new pg.Pool({ connectionString: rootUrl });
const dbName = `miracle_setup_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const url = new URL(rootUrl);
url.pathname = `/${dbName}`;
let app: Awaited<ReturnType<typeof buildApp>>;
const options = {
  databaseUrl: url.href,
  encryptionKey: Buffer.alloc(32, 23),
  cookieSecure: false,
  serveStatic: false,
};
const account = {
  email: "owner@example.test",
  name: "Owner",
  password: "correct-password-long",
};
const issue = (db = app.miracle.db) =>
  (database as any).issueSetupToken(db) as Promise<string | null>;
const complete = (token: string, extra = {}) =>
  app.inject({
    method: "POST",
    url: "/api/setup/complete",
    payload: { token, ...account },
    ...extra,
  });
beforeAll(async () => {
  await management.query(`CREATE DATABASE ${dbName}`);
  app = await buildApp(options);
}, 30000);
beforeEach(async () => {
  await app.miracle.db.query("TRUNCATE users CASCADE");
  // The setup-token table is managed by migrations; guard absent table in the initial red run.
  if (
    (
      await app.miracle.db.query(
        "SELECT to_regclass('setup_tokens') AS relation",
      )
    ).rows[0].relation
  )
    await app.miracle.db.query("DELETE FROM setup_tokens");
});
afterAll(async () => {
  try {
    await app?.close();
    await dropTestDatabase(management, dbName);
  } finally {
    await management.end();
  }
});
it("exposes only setup necessity and completes into an authenticated admin session", async () => {
  expect((await app.inject("/api/setup/status")).json()).toEqual({
    required: true,
  });
  const token = await issue();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const saved = (await app.miracle.db.query("SELECT * FROM setup_tokens"))
    .rows[0];
  expect(JSON.stringify(saved)).not.toContain(token);
  expect(saved.token_hash).toBe(
    createHash("sha256").update(token!).digest("hex"),
  );
  const response = await complete(token!);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({
    user: { email: account.email, name: account.name, role: "admin" },
    csrfToken: expect.any(String),
  });
  expect(response.body).not.toContain("password_hash");
  const cookie = String(response.headers["set-cookie"]);
  expect(cookie).toContain("HttpOnly");
  const me = await app.inject({
    url: "/api/auth/me",
    headers: { cookie: cookie.split(";")[0] },
  });
  expect(me.json().user.email).toBe(account.email);
  expect((await app.inject("/api/setup/status")).json()).toEqual({
    required: false,
  });
  expect(await issue()).toBeNull();
  expect((await complete(token!)).statusCode).toBe(409);
});
it("rejects rotated, expired and unknown tokens without creating users", async () => {
  const rotated = await issue();
  const current = await issue();
  const rejected = await complete(rotated!);
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json().code).toBe("SETUP_TOKEN_INVALID");
  expect((await complete("x".repeat(43))).statusCode).toBe(400);
  await app.miracle.db.query(
    "UPDATE setup_tokens SET expires_at=now()-interval '1 second'",
  );
  expect((await complete(current!)).statusCode).toBe(400);
  expect((await app.miracle.db.query("SELECT * FROM users")).rowCount).toBe(0);
});
it("serializes concurrent completion and bootstrap-admin using the same lock", async () => {
  const token = await issue();
  const responses = await Promise.all([complete(token!), complete(token!)]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  expect((await app.miracle.db.query("SELECT * FROM users")).rowCount).toBe(1);
  await app.miracle.db.query("TRUNCATE users CASCADE");
  const next = await issue();
  const raced = await Promise.allSettled([
    complete(next!),
    database.bootstrapAdmin(
      app.miracle.db,
      "cli@example.test",
      "CLI",
      account.password,
    ),
  ]);
  expect((await app.miracle.db.query("SELECT * FROM users")).rowCount).toBe(1);
  const http = raced[0];
  expect(http.status).toBe("fulfilled");
  if (http.status === "fulfilled")
    expect([200, 409]).toContain((http.value as any).statusCode);
  expect((await app.inject("/api/setup/status")).json()).toEqual({
    required: false,
  });
});
it("enforces setup Origin, password length and request throttling", async () => {
  const token = await issue();
  expect(
    (await complete(token!, { headers: { origin: "http://evil.test" } }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/setup/complete",
        payload: { ...account, token, password: "short" },
      })
    ).statusCode,
  ).toBe(400);
  let response;
  for (let i = 0; i < 21; i++)
    response = await app.inject({
      method: "POST",
      url: "/api/setup/complete",
      remoteAddress: "127.0.0.8",
      payload: { ...account, token: "x".repeat(43) },
    });
  expect(response!.statusCode).toBe(429);
});
it("refuses a second server before interrupting active runs and releases its session lock on close", async () => {
  const id = randomUUID();
  await app.miracle.db.query(
    "INSERT INTO query_runs(id,status,source) VALUES($1,'running','{}')",
    [id],
  );
  await expect(buildApp(options)).rejects.toThrow(
    /already running|already holds/i,
  );
  expect(
    (
      await app.miracle.db.query("SELECT status FROM query_runs WHERE id=$1", [
        id,
      ])
    ).rows[0].status,
  ).toBe("running");
  await app.close();
  app = await buildApp(options);
  expect(
    (
      await app.miracle.db.query("SELECT status FROM query_runs WHERE id=$1", [
        id,
      ])
    ).rows[0].status,
  ).toBe("interrupted");
});
it("detects a changed encryption key even in an empty workspace", async () => {
  await app.close();
  await expect(
    buildApp({ ...options, encryptionKey: Buffer.alloc(32, 24) }),
  ).rejects.toThrow(/encryption key.*restore|restore.*encryption key/i);
  app = await buildApp(options);
});
it("checks legacy connection ciphertext before saving the first key sentinel", async () => {
  const box = new SecretBox(options.encryptionKey);
  await app.miracle.db.query(
    "INSERT INTO connections(id,name,engine,url,username,password_encrypted,clickhouse_options_encrypted) VALUES($1,'Legacy','clickhouse','http://localhost','reader',$2,$3)",
    [
      randomUUID(),
      box.encrypt("legacy-password"),
      box.encrypt('{"tls":{"ca":"cert"}}'),
    ],
  );
  await app.miracle.db.query(
    "DELETE FROM app_settings WHERE key='encryption_key_check'",
  );
  await app.close();
  await expect(
    buildApp({ ...options, encryptionKey: Buffer.alloc(32, 24) }),
  ).rejects.toThrow(/encryption key.*restore|restore.*encryption key/i);
  app = await buildApp(options);
  expect(
    (
      await app.miracle.db.query(
        "SELECT * FROM app_settings WHERE key='encryption_key_check'",
      )
    ).rowCount,
  ).toBe(1);
});
it("closes the server when its dedicated lock session is terminated", async () => {
  await app.close();
  let notify!: (error: Error) => void;
  const lost = new Promise<Error>((resolve) => {
    notify = resolve;
  });
  app = await buildApp({ ...options, onLockLost: notify });
  let didClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    didClose = resolve;
  });
  app.addHook("onClose", async () => {
    didClose();
  });
  const pid = (
    await app.miracle.db.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name='miracle-app-lock' AND datname=current_database()",
    )
  ).rows[0].pid;
  await app.miracle.db.query("SELECT pg_terminate_backend($1)", [pid]);
  expect((await lost).message).toMatch(/lock lost/i);
  await closed;
  await app.close();
  app = await buildApp(options);
});

it("prints exactly one setup URL, rotates it, and returns the ordinary origin after initialization", async () => {
  const exec = promisify(execFile);
  const invoke = () =>
    exec(
      process.execPath,
      ["--import", "tsx", "src/server/cli.ts", "setup-link"],
      {
        env: {
          ...process.env,
          DATABASE_URL: url.href,
          ENCRYPTION_KEY: options.encryptionKey.toString("base64"),
          ENCRYPTION_KEY_FILE: "",
          APP_ORIGIN: "http://localhost:3001",
        },
      },
    );
  const first = await invoke();
  expect(first.stderr).toBe("");
  expect(first.stdout).toMatch(
    /^http:\/\/localhost:3001\/#setup=[A-Za-z0-9_-]{43}\n$/,
  );
  const second = await invoke();
  expect(second.stdout).not.toBe(first.stdout);
  const firstToken = first.stdout.trim().split("#setup=")[1]!;
  const secondToken = second.stdout.trim().split("#setup=")[1]!;
  expect((await complete(firstToken)).statusCode).toBe(400);
  expect((await complete(secondToken)).statusCode).toBe(200);
  expect((await invoke()).stdout).toBe("http://localhost:3001\n");
});

it("does not interrupt runs if its ownership connection dies during startup", async () => {
  await app.close();
  const probe = new pg.Pool({ connectionString: url.href });
  const gate = await probe.connect();
  const id = randomUUID();
  try {
    await probe.query("INSERT INTO query_runs(id,status,source) VALUES($1,'running','{}')", [id]);
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(67432917)");
    const starting = buildApp(options).then(
      value => ({ value, error: undefined }),
      error => ({ value: undefined, error }),
    );
    await expect.poll(async () => (await probe.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND query='SELECT pg_advisory_xact_lock(67432917)' AND wait_event='advisory'",
    )).rows[0].count).toBe(1);
    await probe.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='miracle-app-lock'");
    await gate.query("ROLLBACK");
    const outcome = await starting;
    await outcome.value?.close();
    expect((await probe.query("SELECT status FROM query_runs WHERE id=$1", [id])).rows[0].status).toBe("running");
    expect(outcome.error).toBeDefined();
  } finally {
    await gate.query("ROLLBACK"); gate.release(); await probe.end();
    app = await buildApp(options);
  }
});
