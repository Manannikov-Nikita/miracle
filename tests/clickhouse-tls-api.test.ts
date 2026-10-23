import { beforeAll, afterAll, expect, it } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { bootstrapAdmin } from "../src/server/db.js";
import { SecretBox } from "../src/server/secrets.js";
import {
  certificates,
  tlsServer,
  closeTls,
  compactResult,
} from "./clickhouse-fixture.js";
const databaseUrl =
  process.env.DATABASE_URL ||
  "postgres://miracle:miracle_local@127.0.0.1:5544/miracle";
const admin = new pg.Pool({ connectionString: databaseUrl });
const dbName = "miracle_tls_test_" + Date.now();
const target = new URL(databaseUrl);
target.pathname = "/" + dbName;
const key = Buffer.alloc(32, 7);
let app: FastifyInstance;
let cookie = "",
  csrf = "",
  viewerCookie = "",
  viewerCsrf = "";
let certs: ReturnType<typeof certificates>;
let fixture: Awaited<ReturnType<typeof tlsServer>>;
let id = "";
let receivedAuthorization: string | undefined;
const request = (method: any, url: string, payload?: any, viewer = false) =>
  app.inject({
    method,
    url,
    payload,
    headers: {
      cookie: viewer ? viewerCookie : cookie,
      "x-csrf-token": viewer ? viewerCsrf : csrf,
      origin: "http://127.0.0.1:5178",
    },
  });
function input() {
  return {
    name: "TLS fixture",
    engine: "clickhouse",
    url: fixture.url,
    username: "tls-user",
    password: "saved-test-password",
    clickhouse: {
      compression: false,
      settings: { max_threads: "2" },
      tls: {
        caCert: certs.caCert,
        clientCert: certs.clientCert,
        clientKey: certs.clientKey,
      },
    },
  };
}
beforeAll(async () => {
  certs = certificates();
  fixture = await tlsServer(
    certs,
    (req, res) => {
      receivedAuthorization = req.headers.authorization;
      res.end(compactResult);
    },
    { ca: certs.caCert, requestCert: true, rejectUnauthorized: true },
  );
  await admin.query(`CREATE DATABASE ${dbName}`);
  app = await buildApp({
    databaseUrl: target.href,
    encryptionKey: key,
    cookieSecure: false,
    serveStatic: false,
  });
  await bootstrapAdmin(
    app.miracle.db,
    "tls-admin@example.test",
    "Admin",
    "correct-password-long",
  );
  const login = await request("POST", "/api/auth/login", {
    email: "tls-admin@example.test",
    password: "correct-password-long",
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  csrf = login.json().csrfToken;
  await app.miracle.db.query(
    "INSERT INTO users(id,email,name,role,password_hash) SELECT gen_random_uuid(),'tls-viewer@example.test','Viewer','viewer',password_hash FROM users WHERE email='tls-admin@example.test'",
  );
  const v = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "tls-viewer@example.test",
      password: "correct-password-long",
    },
    headers: { origin: "http://127.0.0.1:5178" },
  });
  viewerCookie = String(v.headers["set-cookie"]).split(";")[0]!;
  viewerCsrf = v.json().csrfToken;
}, 30000);
afterAll(async () => {
  if (app) await app.close();
  if (fixture) await closeTls(fixture.server);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
it("encrypts TLS materials and exposes only presence flags to all connection readers", async () => {
  const response = await request("POST", "/api/connections", input());
  expect(response.statusCode, response.body).toBe(201);
  id = response.json().id;
  const dto = response.json();
  expect(dto.clickhouse.tls).toMatchObject({
    hasCaCert: true,
    hasClientCert: true,
    hasClientKey: true,
  });
  expect(response.body).not.toMatch(
    /BEGIN CERTIFICATE|BEGIN PRIVATE|saved-test-password|clientKey"/,
  );
  const row = (
    await app.miracle.db.query("SELECT * FROM connections WHERE id=$1", [id])
  ).rows[0];
  expect(row.clickhouse_options_encrypted).not.toContain("BEGIN");
  expect(
    JSON.parse(new SecretBox(key).decrypt(row.clickhouse_options_encrypted)).tls
      .clientKey,
  ).toBe(certs.clientKey);
  const list = await request("GET", "/api/connections", undefined, true);
  expect(list.statusCode).toBe(200);
  expect(list.body).not.toMatch(
    /BEGIN CERTIFICATE|BEGIN PRIVATE|saved-test-password/,
  );
});
it("preserves omitted secrets, replaces settings and validates the fully merged patch", async () => {
  const response = await request("PATCH", "/api/connections/" + id, {
    name: "renamed",
    clickhouse: { requestTimeoutMs: 5000, settings: {} },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().clickhouse.settings).toEqual({});
  expect(response.json().clickhouse.tls.hasClientKey).toBe(true);
  expect(
    (
      await request("PATCH", "/api/connections/" + id, {
        url: "http://localhost:8123",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await request("PATCH", "/api/connections/" + id, { engine: "trino" }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await request("PATCH", "/api/connections/" + id, {
        clickhouse: { tls: { clientKey: null } },
      })
    ).statusCode,
  ).toBe(400);
  const tested = await request("POST", "/api/connections/" + id + "/test");
  expect(tested.statusCode, tested.body).toBe(200);
  expect(receivedAuthorization).toBe(
    "Basic " + Buffer.from("tls-user:saved-test-password").toString("base64"),
  );
});
it("tests unsaved state against saved secrets without writing, and requires admin", async () => {
  const before = (
    await app.miracle.db.query("SELECT * FROM connections ORDER BY id")
  ).rows;
  const { password: _password, clickhouse: _options, ...draft } = input();
  const tested = await request("POST", "/api/connections/test", {
    ...draft,
    id,
    clickhouse: { tls: { certificateAuth: true } },
  });
  expect(tested.statusCode, tested.body).toBe(200);
  expect(tested.json().version).toBe("9007199254740993");
  expect(receivedAuthorization).toBeUndefined();
  expect(
    (await app.miracle.db.query("SELECT * FROM connections ORDER BY id")).rows,
  ).toEqual(before);
  expect(
    (await request("POST", "/api/connections/test", input(), true)).statusCode,
  ).toBe(403);
  expect(
    (
      await request("POST", "/api/connections/test", {
        ...draft,
        id,
        clickhouse: { tls: { caCert: certs.wrongCa } },
      })
    ).statusCode,
  ).toBe(400);
  const unsaved = await request("POST", "/api/connections/test", input());
  expect(unsaved.statusCode, unsaved.body).toBe(200);
  expect(
    (await app.miracle.db.query("SELECT count(*) FROM connections")).rows[0]
      .count,
  ).toBe("1");
});
it("rejects unknown settings and secrets safely, supports explicit TLS and option clearing", async () => {
  for (const clickhouse of [
    { insecure: true },
    { settings: { default_format: "JSON" } },
    { tls: { caCert: "DO_NOT_ECHO_PRIVATE_TEXT" } },
    { tls: { certificateAuth: true, clientKey: null, clientCert: null } },
  ]) {
    const r = await request("PATCH", "/api/connections/" + id, { clickhouse });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain("DO_NOT_ECHO_PRIVATE_TEXT");
  }
  const cleared = await request("PATCH", "/api/connections/" + id, {
    url: "http://localhost:8123",
    clickhouse: {
      tls: {
        caCert: null,
        clientCert: null,
        clientKey: null,
        certificateAuth: false,
      },
    },
  });
  expect(cleared.statusCode, cleared.body).toBe(200);
  expect(cleared.json().clickhouse.tls.hasClientKey).toBe(false);
  expect(
    (
      await request("PATCH", "/api/connections/" + id, {
        engine: "trino",
        clickhouse: null,
      })
    ).statusCode,
  ).toBe(200);
  const row = (
    await app.miracle.db.query("SELECT * FROM connections WHERE id=$1", [id])
  ).rows[0];
  expect(row.clickhouse_options_encrypted).toBeNull();
});
