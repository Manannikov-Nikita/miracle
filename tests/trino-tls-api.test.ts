import { beforeAll, afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { SecretBox } from "../src/server/secrets.js";
import { certificates, tlsServer, closeTls } from "./clickhouse-fixture.js";
import {
  backupWorkspace,
  restoreWorkspace,
} from "../src/server/maintenance.js";

const root = mkdtempSync(join(tmpdir(), "miracle-trino-tls-api-"));
const dataDir = join(root, "data");
const key = Buffer.alloc(32, 19);
let app: FastifyInstance;
let cookie = "",
  csrf = "";
let certs: ReturnType<typeof certificates>;
let fixture: Awaited<ReturnType<typeof tlsServer>>;
let receivedAuthorization: string | undefined;
const request = (method: any, url: string, payload?: any) =>
  app.inject({
    method,
    url,
    payload,
    headers: {
      host: "127.0.0.1:5178",
      origin: "http://127.0.0.1:5178",
      cookie,
      "x-csrf-token": csrf,
    },
  });
const input = () => ({
  name: "Trino TLS fixture",
  engine: "trino",
  url: fixture.url,
  username: "tls-reader",
  password: "test-trino-password",
  catalog: "memory",
  schema: "default",
  trino: { tls: { caCert: certs.caCert } },
});
async function create() {
  const response = await request("POST", "/api/connections", input());
  expect(response.statusCode, response.body).toBe(201);
  return response.json().id as string;
}
function saved(id: string) {
  const row = app.miracle.db.query("SELECT * FROM connections WHERE id=?1", [
    id,
  ]).rows[0];
  return {
    row,
    options: row.trino_options_encrypted
      ? JSON.parse(new SecretBox(key).decrypt(row.trino_options_encrypted))
      : undefined,
  };
}
async function session() {
  const response = await request("GET", "/api/session");
  cookie = String(response.headers["set-cookie"]).split(";")[0]!;
  csrf = response.json().csrfToken;
}
beforeAll(async () => {
  certs = certificates();
  fixture = await tlsServer(certs, async (req, res) => {
    for await (const chunk of req) {
      /* consume statement */
    }
    receivedAuthorization = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "test",
        columns: [{ name: "version", type: "varchar" }],
        data: [["Trino test"]],
      }),
    );
  });
  app = await buildApp({
    dataDir,
    encryptionKey: key,
    appOrigin: "http://127.0.0.1:5178",
    serveStatic: false,
  });
  await session();
}, 30000);
afterAll(async () => {
  await app?.close();
  if (fixture) await closeTls(fixture.server);
  rmSync(root, { recursive: true, force: true });
});

it("encrypts each Trino CA and only returns its presence to connection readers", async () => {
  const id = await create();
  const { row, options } = saved(id);
  expect(row.trino_options_encrypted).not.toContain("BEGIN");
  expect(options).toEqual({ tls: { caCert: certs.caCert } });
  const list = await request("GET", "/api/connections");
  expect(list.statusCode).toBe(200);
  expect(list.json().find((c: any) => c.id === id).trino).toEqual({
    tls: { hasCaCert: true },
  });
  expect(list.body).not.toMatch(
    /BEGIN CERTIFICATE|test-trino-password|caCert"/,
  );
});

it("preserves omitted CA, replaces it explicitly and validates the fully merged patch", async () => {
  const id = await create();
  for (const patch of [
    { name: "Renamed" },
    { trino: {} },
    { trino: { tls: {} } },
  ]) {
    const response = await request("PATCH", `/api/connections/${id}`, patch);
    expect(response.statusCode, response.body).toBe(200);
    expect(saved(id).options.tls.caCert).toBe(certs.caCert);
  }
  for (const patch of [
    { engine: "clickhouse" },
    { url: "http://localhost:8080" },
  ]) {
    expect(
      (await request("PATCH", `/api/connections/${id}`, patch)).statusCode,
    ).toBe(400);
    expect(saved(id).options.tls.caCert).toBe(certs.caCert);
  }
  expect(
    (
      await request("PATCH", `/api/connections/${id}`, {
        trino: { tls: { caCert: certs.wrongCa } },
      })
    ).statusCode,
  ).toBe(200);
  expect(saved(id).options.tls.caCert).toBe(certs.wrongCa);
});

it.each([{ tls: { caCert: null } }, { tls: null }, null])(
  "explicitly clears saved CA with %j before permitting HTTP",
  async (trino) => {
    const id = await create();
    const response = await request("PATCH", `/api/connections/${id}`, {
      trino,
      url: "http://localhost:8080",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(saved(id).options?.tls?.caCert).toBeFalsy();
    expect(response.json().trino?.tls?.hasCaCert).toBeFalsy();
    if (trino === null)
      expect(saved(id).row.trino_options_encrypted).toBeNull();
  },
);

it("tests drafts with saved or replacement CA without persisting them", async () => {
  const id = await create();
  const before = saved(id).row;
  const { trino: _trino, password: _password, ...draft } = input();
  const response = await request("POST", "/api/connections/test", {
    ...draft,
    id,
    trino: { tls: {} },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ ok: true, version: "Trino test" });
  expect(receivedAuthorization).toBe(
    "Basic " + Buffer.from("tls-reader:test-trino-password").toString("base64"),
  );
  const untrusted = await request("POST", "/api/connections/test", {
    ...draft,
    id,
    trino: { tls: { caCert: certs.wrongCa } },
  });
  expect(untrusted.statusCode).toBe(400);
  expect(untrusted.body).not.toMatch(/BEGIN CERTIFICATE|test-trino-password/);
  expect(saved(id).row).toEqual(before);
  const count = app.miracle.db.query("SELECT count(*) AS n FROM connections")
    .rows[0].n;
  expect(
    (await request("POST", "/api/connections/test", input())).statusCode,
  ).toBe(200);
  expect(
    app.miracle.db.query("SELECT count(*) AS n FROM connections").rows[0].n,
  ).toBe(count);
});

it("rejects malformed, oversized, unsafe and foreign-engine TLS options without exposing material", async () => {
  const id = await create();
  const badOptions = [
    { tls: { caCert: "DO_NOT_ECHO_CA" } },
    { tls: { caCert: certs.caCert + "DO_NOT_ECHO_CA" } },
    { tls: { caCert: "я".repeat(70000) } },
    { tls: { caCert: certs.caCert.repeat(150) } },
    { tls: { caCert: certs.clientKey } },
    { tls: { rejectUnauthorized: false } },
    { tls: { hasCaCert: true } },
    { clientKey: "DO_NOT_ECHO_CA" },
  ];
  for (const trino of badOptions) {
    const response = await request("PATCH", `/api/connections/${id}`, {
      trino,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).not.toMatch(
      /DO_NOT_ECHO_CA|BEGIN PRIVATE KEY|BEGIN CERTIFICATE/,
    );
    expect(saved(id).options.tls.caCert).toBe(certs.caCert);
  }
  const foreign = await request("POST", "/api/connections", {
    ...input(),
    engine: "clickhouse",
  });
  expect(foreign.statusCode).toBe(400);
  const chain = await request("PATCH", `/api/connections/${id}`, {
    trino: { tls: { caCert: certs.caCert + certs.wrongCa } },
  });
  expect(chain.statusCode, chain.body).toBe(200);
  expect(saved(id).options.tls.caCert).toBe(certs.caCert + certs.wrongCa);
});

it("keeps encrypted Trino CA across restart and paired backup/restore", async () => {
  const id = await create();
  const encrypted = saved(id).row.trino_options_encrypted;
  await app.close();
  await backupWorkspace(dataDir, join(root, "backup"));
  await restoreWorkspace(join(root, "backup"), join(root, "restored"));
  app = await buildApp({
    dataDir: join(root, "restored"),
    encryptionKey: key,
    appOrigin: "http://127.0.0.1:5178",
    serveStatic: false,
  });
  await session();
  expect(saved(id).row.trino_options_encrypted).toBe(encrypted);
  expect(saved(id).options.tls.caCert).toBe(certs.caCert);
  const response = await request("POST", `/api/connections/${id}/test`);
  expect(response.statusCode, response.body).toBe(200);
});
