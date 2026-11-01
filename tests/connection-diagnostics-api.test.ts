import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { trinoConnectionError } from "../src/server/trinoTransport.js";

const dataDir = mkdtempSync(join(tmpdir(), "miracle-connection-errors-"));
let app: FastifyInstance;
let server: Server;
let base: string;
let cookie = "";
let csrf = "";
const password = "fixture-connection-password";
const authorization = Buffer.from(`reader:${password}`).toString("base64");
const request = (method: any, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    payload,
    headers: {
      host: "127.0.0.1:5178",
      cookie,
      "x-csrf-token": csrf,
    },
  });
beforeAll(async () => {
  server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume request */
    }
    if (req.url?.startsWith("/authentication")) {
      res.writeHead(403);
      res.end(
        "Code: 516. DB::Exception: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)",
      );
    } else if (req.url?.startsWith("/database")) {
      res.writeHead(404);
      res.end(
        "Code: 81. DB::Exception: Database fixture_database does not exist. (UNKNOWN_DATABASE)",
      );
    } else if (req.url?.startsWith("/large")) {
      res.writeHead(401);
      res.end("x".repeat(1024 * 1024 - 10) + password + "y".repeat(200));
    } else if (req.url?.startsWith("/long")) {
      res.writeHead(401);
      res.end("diagnostic\n".repeat(700) + password + "\nEND OF DIAGNOSTIC");
    } else if (req.url?.startsWith("/catalog")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            message: `Catalog missing: fixture_catalog ${password}`,
            errorName: "CATALOG_NOT_FOUND",
            errorCode: 44,
            failureInfo: { message: password, stack: ["private stack"] },
          },
        }),
      );
    } else {
      res.writeHead(401);
      res.end(
        `Engine authentication failed. ${password} Basic ${authorization}\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  app = await buildApp({
    dataDir,
    appOrigin: "http://127.0.0.1:5178",
    serveStatic: false,
  });
  const session = await request("GET", "/api/session");
  cookie = String(session.headers["set-cookie"]).split(";")[0]!;
  csrf = session.json().csrfToken;
});
afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

it.each(["clickhouse", "trino"])(
  "returns actionable %s authentication errors and safe diagnostics for both test routes",
  async (engine) => {
    const input = {
      name: engine,
      engine,
      url: base,
      username: "reader",
      password,
    };
    const saved = await request("POST", "/api/connections", input);
    expect(saved.statusCode).toBe(201);
    for (const [path, payload] of [
      ["/api/connections/test", input],
      [`/api/connections/${saved.json().id}/test`, undefined],
    ] as const) {
      const response = await request("POST", path, payload);
      expect(response.statusCode).toBe(400);
      const error = response.json();
      expect(error.code).toBe("CONNECTION_AUTH");
      expect(error.error).toMatch(/имя пользователя.*пароль/i);
      expect(error.details).toContain("HTTP 401");
      expect(error.details).toContain("Engine authentication failed");
      expect(response.body).not.toContain(password);
      expect(response.body).not.toContain(authorization);
      expect(response.body).not.toContain("BEGIN PRIVATE");
    }
  },
);

it("preserves Trino error identifiers and safe engine text without exposing failureInfo", async () => {
  const response = await request("POST", "/api/connections/test", {
    name: "Trino",
    engine: "trino",
    url: `${base}/catalog`,
    username: "reader",
    password,
  });
  const error = response.json();
  expect(response.statusCode).toBe(400);
  expect(error.code).toBe("CONNECTION_CATALOG");
  expect(error.error).toMatch(/каталог/i);
  expect(error.details).toContain("CATALOG_NOT_FOUND");
  expect(error.details).toContain("44");
  expect(error.details).toContain("fixture_catalog");
  expect(response.body).not.toContain(password);
  expect(response.body).not.toContain("private stack");
});

it("distinguishes a missing ClickHouse database from a missing HTTP endpoint", async () => {
  const response = await request("POST", "/api/connections/test", {
    name: "ClickHouse",
    engine: "clickhouse",
    url: `${base}/database`,
    username: "reader",
    password,
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().code).toBe("CONNECTION_DATABASE");
  expect(response.json().error).toMatch(/баз[ауы] данных/i);
  expect(response.json().details).toContain("Code: 81");
  expect(response.json().details).toContain("fixture_database");
});

it("uses ClickHouse's authentication code even when its HTTP status is 403", async () => {
  const response = await request("POST", "/api/connections/test", {
    name: "ClickHouse",
    engine: "clickhouse",
    url: `${base}/authentication`,
    username: "reader",
    password,
  });
  expect(response.json().code).toBe("CONNECTION_AUTH");
  expect(response.json().error).toMatch(/имя пользователя.*пароль/i);
  expect(response.json().details).toContain("Code: 516");
});

it.each(["clickhouse", "trino"])(
  "does not expose a clipped %s engine body containing a partial secret",
  async (engine) => {
    const response = await request("POST", "/api/connections/test", {
      name: engine,
      engine,
      url: `${base}/large`,
      username: "reader",
      password,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().details).toContain("Ответ превышает 1 МБ");
    expect(response.body).not.toContain(password.slice(0, 10));
    expect(response.body).not.toContain("xxxxxxxxxx");
  },
);

it.each(["clickhouse", "trino"])(
  "keeps the entire safe %s HTTP diagnostic above 2 KiB",
  async (engine) => {
    const response = await request("POST", "/api/connections/test", {
      name: engine,
      engine,
      url: `${base}/long`,
      username: "reader",
      password,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().details).toContain("diagnostic\n".repeat(700));
    expect(response.json().details).toContain("END OF DIAGNOSTIC");
    expect(response.body).not.toContain(password);
  },
);

it.each([false, true])(
  "retains full safe SQL diagnostics in persisted results (date batch: %s)",
  async (batch) => {
    const connection = await request("POST", "/api/connections", {
      name: "SQL fixture",
      engine: "clickhouse",
      url: `${base}/long`,
      username: "reader",
      password,
    });
    const started = await request("POST", "/api/query-runs", {
      connectionId: connection.json().id,
      sql: batch ? "SELECT '{{date}}'" : "SELECT 1",
      ...(batch
        ? {
            dateRange: {
              startDate: "2026-01-01",
              endDate: "2026-01-01",
              granularity: "day",
              retries: 0,
            },
          }
        : {}),
    });
    expect(started.statusCode).toBe(202);
    let finished = started.json();
    for (
      let attempt = 0;
      attempt < 100 && finished.status === "running";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = (
        await request("GET", `/api/query-runs/${started.json().id}`)
      ).json();
    }
    expect(finished.status).toBe("failed");
    const diagnostic = batch ? finished.batch.items[0].error : finished.error;
    expect(diagnostic).toContain("diagnostic\n".repeat(700));
    expect(diagnostic).toContain("END OF DIAGNOSTIC");
    expect(diagnostic).not.toContain(password);
  },
);

it("identifies every invalid connection field without returning its input values", async () => {
  const response = await request("POST", "/api/connections", {
    name: "",
    engine: "clickhouse",
    url: base,
    username: "reader",
    password,
    clickhouse: {
      requestTimeoutMs: 10,
      settings: { max_threads: "invalid-private-value" },
    },
  });
  expect(response.statusCode).toBe(400);
  const error = response.json();
  expect(error.code).toBe("VALIDATION_ERROR");
  expect(error.error).toMatch(/название/i);
  expect(error.details).toContain("name:");
  expect(error.details).toContain("clickhouse.requestTimeoutMs:");
  expect(error.details).toContain("clickhouse.settings.max_threads:");
  expect(response.body).not.toContain(password);
  expect(response.body).not.toContain("invalid-private-value");
});

it("explains an invalid connection URL using its field and required format", async () => {
  const response = await request("POST", "/api/connections", {
    name: "Invalid URL",
    engine: "trino",
    url: "not-a-url",
    username: "reader",
    password,
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().code).toBe("VALIDATION_ERROR");
  expect(response.json().error).toMatch(/адрес.*HTTP/i);
  expect(response.json().details).toContain("url:");
  expect(response.body).not.toContain(password);
});

it.each(["schema", "columns?schema=fixture&table=fixture", "functions"])(
  "retains engine diagnostics in the existing %s metadata route",
  async (path) => {
    const saved = await request("POST", "/api/connections", {
      name: "Metadata",
      engine: "clickhouse",
      url: `${base}/long`,
      username: "reader",
      password,
    });
    const response = await request(
      "GET",
      `/api/connections/${saved.json().id}/${path}`,
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("CONNECTION_AUTH");
    expect(response.json().details).toContain("END OF DIAGNOSTIC");
    expect(response.body).not.toContain(password);
  },
);

it.each([
  ["ENOTFOUND", "CONNECTION_DNS", /имя сервера/i],
  ["ECONNREFUSED", "CONNECTION_REFUSED", /порт/i],
  ["UND_ERR_CONNECT_TIMEOUT", "CONNECTION_TIMEOUT", /таймаут/i],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "CONNECTION_TLS_HOSTNAME", /HTTPS-адрес/i],
  ["CERT_HAS_EXPIRED", "CONNECTION_TLS_EXPIRED", /сертификат/i],
  ["SELF_SIGNED_CERT_IN_CHAIN", "CONNECTION_TLS_CA", /CA/],
] as const)(
  "classifies %s using only safe transport codes",
  (code, expectedCode, action) => {
    const cause = Object.assign(new Error(password), { code });
    const error = trinoConnectionError(
      new TypeError("fetch failed", { cause }),
    ) as Error & { code?: string; details?: string };
    expect(error.code).toBe(expectedCode);
    expect(error.message).toMatch(action);
    expect(error.details).toContain(code);
    expect(error.details).not.toContain(password);
    expect(error.cause).toBeUndefined();
  },
);
