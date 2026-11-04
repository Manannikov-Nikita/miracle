import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app.js";
import { engineMetadata } from "../src/server/connectors.js";
import { certificates, tlsServer, closeTls } from "./clickhouse-fixture.js";

const root = mkdtempSync(join(tmpdir(), "miracle-trino-auth-"));
let app: FastifyInstance;
let cookie = "",
  csrf = "";
let certs: ReturnType<typeof certificates>;
let fixture: Awaited<ReturnType<typeof tlsServer>>;
let mode:
  | "success"
  | "unsafe"
  | "error"
  | "pending"
  | "unsafe-next"
  | "huge"
  | "hold"
  | "http-echo"
  | "query-echo" = "success";
let serial = 0;
const tokens = new Set<string>();
let pollingStarted: (() => void) | undefined;
const requests: {
  method: string;
  url: string;
  authorization?: string;
  user?: string;
}[] = [];
const input = () => ({
  name: "External Trino",
  engine: "trino",
  url: fixture.url,
  username: "",
  password: "must-not-send-basic",
  trino: { externalAuthentication: true, tls: { caCert: certs.caCert } },
});
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
beforeAll(async () => {
  certs = certificates();
  fixture = await tlsServer(certs, async (req, res) => {
    for await (const _ of req) {
      /* drain statement */
    }
    requests.push({
      method: req.method!,
      url: req.url!,
      authorization: req.headers.authorization,
      user: req.headers["x-trino-user"] as string | undefined,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url!.startsWith("/oauth2/token/")) {
      if (req.method === "DELETE") return res.writeHead(204).end();
      if (mode === "hold") {
        res.write("{");
        pollingStarted?.();
        return;
      }
      if (mode === "unsafe-next")
        return res.end(
          JSON.stringify({ nextUri: "https://foreign.invalid/secret" }),
        );
      if (mode === "huge")
        return res.end(JSON.stringify({ token: "x".repeat(200000) }));
      if (mode === "error")
        return res.end(
          JSON.stringify({ error: "sensitive-error-with-token-secret" }),
        );
      if (!req.url!.endsWith("/ready") || mode === "pending")
        return res.end(
          JSON.stringify({
            nextUri: fixture.url + req.url!.replace(/\/ready$/, "") + "/ready",
          }),
        );
      const token = "fixture-secret-token-" + req.url!.split("/")[3];
      tokens.add(token);
      return res.end(JSON.stringify({ token }));
    }
    if (mode === "http-echo" && req.headers.authorization)
      return res
        .writeHead(403)
        .end(`Proxy rejected ${req.headers.authorization}`);
    if (mode === "query-echo" && req.headers.authorization)
      return res.end(
        JSON.stringify({
          error: {
            errorName: "PERMISSION_DENIED",
            message: `Rejected ${req.headers.authorization}`,
          },
        }),
      );
    if (
      req.headers.authorization?.startsWith("Bearer ") &&
      tokens.has(req.headers.authorization.slice(7))
    )
      return res.end(
        JSON.stringify({
          columns: [{ name: "version", type: "varchar" }],
          data: [["auth-fixture"]],
        }),
      );
    const id = ++serial;
    const tokenUrl =
      mode === "unsafe"
        ? "https://foreign.invalid/token/secret"
        : fixture.url + "/oauth2/token/" + id;
    res.setHeader(
      "WWW-Authenticate",
      `Basic realm="Trino", Bearer realm="Trino, SSO", x_redirect_server="${fixture.url}/oauth2/authorize/${id}", x_token_server="${tokenUrl}"`,
    );
    res.writeHead(401).end("authentication required");
  });
  app = await buildApp({
    projectRoot: root,
    dataDir: join(root, "data"),
    encryptionKey: Buffer.alloc(32, 23),
    appOrigin: "http://127.0.0.1:5178",
    serveStatic: false,
  });
  const session = await request("GET", "/api/session");
  cookie = String(session.headers["set-cookie"]).split(";")[0]!;
  csrf = session.json().csrfToken;
}, 30000);
afterAll(async () => {
  await app?.close();
  if (fixture) await closeTls(fixture.server);
  rmSync(root, { recursive: true, force: true });
});
async function login(id?: string) {
  const start = await request("POST", "/api/connections/auth/start", {
    ...input(),
    id,
  });
  expect(start.statusCode, start.body).toBe(200);
  expect(start.json()).toMatchObject({
    status: "pending",
    redirectUrl: expect.stringContaining("/oauth2/authorize/"),
  });
  const sessionId = start.json().id as string;
  expect(
    (await request("POST", `/api/connections/auth/${sessionId}/poll`)).json(),
  ).toEqual({ status: "pending" });
  const done = await request("POST", `/api/connections/auth/${sessionId}/poll`);
  expect(done.statusCode, done.body).toBe(200);
  expect(done.json()).toEqual({ status: "authenticated" });
  return sessionId;
}
it("authenticates a draft through browser polling, tests it and promotes only its token when saved", async () => {
  mode = "success";
  requests.length = 0;
  const authSessionId = await login();
  const tested = await request("POST", "/api/connections/test", {
    ...input(),
    authSessionId,
  });
  expect(tested.statusCode, tested.body).toBe(200);
  expect(tested.json().version).toBe("auth-fixture");
  const saved = await request("POST", "/api/connections", {
    ...input(),
    authSessionId,
  });
  expect(saved.statusCode, saved.body).toBe(201);
  expect(saved.json().trino.externalAuthentication).toBe(true);
  const id = saved.json().id;
  expect(
    (await request("POST", `/api/connections/${id}/test`)).statusCode,
  ).toBe(200);
  const run = await request("POST", "/api/query-runs", {
    connectionId: id,
    sql: "SELECT 1",
    mutationId: crypto.randomUUID(),
  });
  expect(run.statusCode, run.body).toBe(202);
  await expect
    .poll(
      async () =>
        (await request("GET", `/api/query-runs/${run.json().id}`)).json()
          .status,
    )
    .toBe("completed");
  const other = await request("POST", "/api/connections", input());
  const refused = await request(
    "POST",
    `/api/connections/${other.json().id}/test`,
  );
  expect(refused.json().code).toBe("TRINO_AUTH_REQUIRED");
  const list = await request("GET", "/api/connections");
  expect(list.body).not.toMatch(/fixture-secret-token|oauth2\/token/);
  const stored = app.miracle.db.query("SELECT * FROM connections").rows;
  expect(JSON.stringify(stored)).not.toContain("fixture-secret-token");
  expect(
    readFileSync(join(root, "data", "miracle.sqlite")).includes(
      Buffer.from("fixture-secret-token"),
    ),
  ).toBe(false);
  expect(
    requests
      .filter((r) => r.url.startsWith("/oauth2/token/"))
      .every((r) => !r.authorization),
  ).toBe(true);
  expect(
    requests.some((r) => r.method === "DELETE" && r.url.endsWith("/ready")),
  ).toBe(true);
  expect(
    requests.every((r) => !r.authorization?.startsWith("Basic ") && !r.user),
  ).toBe(true);
});
it("invalidates rejected tokens and changed settings while preserving other saved connections", async () => {
  mode = "success";
  const a = (await request("POST", "/api/connections", input())).json().id;
  const b = (await request("POST", "/api/connections", input())).json().id;
  await login(a);
  await login(b);
  expect(
    (
      await request("PATCH", `/api/connections/${a}`, {
        username: "different-user",
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await request("POST", `/api/connections/${a}/test`)).json().code,
  ).toBe("TRINO_AUTH_REQUIRED");
  expect((await request("POST", `/api/connections/${b}/test`)).statusCode).toBe(
    200,
  );
  tokens.clear();
  expect(
    (await request("POST", `/api/connections/${b}/test`)).json().code,
  ).toBe("TRINO_AUTH_REQUIRED");
  await login(b);
  expect((await request("POST", `/api/connections/${b}/test`)).statusCode).toBe(
    200,
  );
});
it("cancels pending login and rejects a cross-origin token endpoint without requesting it", async () => {
  mode = "pending";
  const start = await request("POST", "/api/connections/auth/start", input());
  expect(start.statusCode, start.body).toBe(200);
  expect(
    (await request("DELETE", `/api/connections/auth/${start.json().id}`))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await request("POST", `/api/connections/auth/${start.json().id}/poll`)
    ).json().code,
  ).toBe("TRINO_AUTH_EXPIRED");
  mode = "unsafe";
  const unsafe = await request("POST", "/api/connections/auth/start", input());
  expect(unsafe.statusCode).toBe(400);
  expect(unsafe.json().code).toBe("TRINO_AUTH_PROTOCOL");
  expect(unsafe.body).not.toContain("foreign.invalid");
  mode = "success";
});
it("redacts identity-provider errors and keeps TLS certificate and hostname verification enabled", async () => {
  mode = "error";
  const start = await request("POST", "/api/connections/auth/start", input());
  const polled = await request(
    "POST",
    `/api/connections/auth/${start.json().id}/poll`,
  );
  expect(polled.json().code).toBe("TRINO_AUTH_FAILED");
  expect(polled.body).not.toContain("sensitive-error");
  mode = "success";
  for (const patch of [
    { url: fixture.url.replace("localhost", "127.0.0.1") },
    { trino: { externalAuthentication: true } },
  ]) {
    const response = await request("POST", "/api/connections/auth/start", {
      ...input(),
      ...patch,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toMatch(/^CONNECTION_TLS_/);
  }
});
it("does not copy a saved connection's authenticated session into another saved connection", async () => {
  mode = "success";
  const first = (await request("POST", "/api/connections", input())).json().id;
  const second = (await request("POST", "/api/connections", input())).json().id;
  const authSessionId = await login(first);
  const copied = await request("PATCH", `/api/connections/${second}`, {
    ...input(),
    authSessionId,
  });
  expect(copied.statusCode).toBe(400);
  expect(copied.json().code).toBe("TRINO_AUTH_EXPIRED");
  expect(
    (await request("POST", `/api/connections/${second}/test`)).json().code,
  ).toBe("TRINO_AUTH_REQUIRED");
  expect(
    (await request("POST", "/api/connections", { ...input(), authSessionId }))
      .statusCode,
  ).toBe(400);
  expect(
    (await request("POST", `/api/connections/${first}/test`)).statusCode,
  ).toBe(200);
});
it("binds draft login to its settings, expires pending login and rejects unbounded or unsafe polling replies", async () => {
  mode = "success";
  const authSessionId = await login();
  expect(
    (
      await request("POST", "/api/connections/test", {
        ...input(),
        username: "changed",
        authSessionId,
      })
    ).json().code,
  ).toBe("TRINO_AUTH_EXPIRED");
  expect(
    (await request("DELETE", `/api/connections/auth/${authSessionId}`))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await request("POST", "/api/connections/test", {
        ...input(),
        authSessionId,
      })
    ).json().code,
  ).toBe("TRINO_AUTH_EXPIRED");
  for (const failure of ["unsafe-next", "huge"] as const) {
    mode = failure;
    const start = await request("POST", "/api/connections/auth/start", input());
    expect(
      (
        await request("POST", `/api/connections/auth/${start.json().id}/poll`)
      ).json().code,
    ).toBe("TRINO_AUTH_PROTOCOL");
  }
  mode = "pending";
  const timer = vi.spyOn(globalThis, "setTimeout");
  try {
    const start = await request("POST", "/api/connections/auth/start", input());
    expect(start.statusCode, start.body).toBe(200);
    const pending = await request(
      "POST",
      `/api/connections/auth/${start.json().id}/poll`,
    );
    expect(pending.statusCode, pending.body).toBe(200);
    expect(pending.json()).toEqual({ status: "pending" });
    const expiration = timer.mock.calls.filter(([, ms]) => ms === 300000);
    expect(expiration).toHaveLength(1);
    const [expire, , ...args] = expiration[0]!;
    expire(...args);
    expect(
      (
        await request("POST", `/api/connections/auth/${start.json().id}/poll`)
      ).json().code,
    ).toBe("TRINO_AUTH_EXPIRED");
  } finally {
    timer.mockRestore();
    mode = "success";
  }
});
it("aborts an in-flight token poll when its saved connection is deleted", async () => {
  mode = "hold";
  const id = (await request("POST", "/api/connections", input())).json().id;
  const start = await request("POST", "/api/connections/auth/start", {
    ...input(),
    id,
  });
  let started!: () => void;
  const arrived = new Promise<void>((resolve) => {
    started = resolve;
  });
  pollingStarted = started;
  const pending = request(
    "POST",
    `/api/connections/auth/${start.json().id}/poll`,
  ).then((response) => response);
  try {
    await arrived;
    expect((await request("DELETE", `/api/connections/${id}`)).statusCode).toBe(
      200,
    );
    expect((await pending).json().code).toBe("TRINO_AUTH_EXPIRED");
    expect(
      (
        await request("POST", `/api/connections/auth/${start.json().id}/poll`)
      ).json().code,
    ).toBe("TRINO_AUTH_EXPIRED");
  } finally {
    pollingStarted = undefined;
    mode = "success";
  }
});
it("keeps a login made with new settings when saving that same connection edit", async () => {
  mode = "success";
  const id = (await request("POST", "/api/connections", input())).json().id;
  await login(id);
  const start = await request("POST", "/api/connections/auth/start", {
    ...input(),
    id,
    username: "new-user",
  });
  const authSessionId = start.json().id;
  await request("POST", `/api/connections/auth/${authSessionId}/poll`);
  expect(
    (
      await request("POST", `/api/connections/auth/${authSessionId}/poll`)
    ).json().status,
  ).toBe("authenticated");
  const saved = await request("PATCH", `/api/connections/${id}`, {
    username: "new-user",
    authSessionId,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(
    (await request("POST", `/api/connections/${id}/test`)).statusCode,
  ).toBe(200);
  expect(requests.at(-1)?.user).toBe("new-user");
});
it("redacts echoed Bearer tokens from HTTP diagnostics and persisted query errors", async () => {
  mode = "success";
  const id = (await request("POST", "/api/connections", input())).json().id;
  await login(id);
  for (const failure of ["http-echo", "query-echo"] as const) {
    mode = failure;
    const tested = await request("POST", `/api/connections/${id}/test`);
    expect(tested.statusCode).toBe(400);
    expect(tested.body).not.toContain("fixture-secret-token");
    expect(tested.body).toContain("[скрыто]");
    const run = await request("POST", "/api/query-runs", {
      connectionId: id,
      sql: "SELECT 1",
      mutationId: crypto.randomUUID(),
    });
    expect(run.statusCode, run.body).toBe(202);
    await expect
      .poll(
        async () =>
          (await request("GET", `/api/query-runs/${run.json().id}`)).json()
            .status,
      )
      .toBe("failed");
    const result = await request("GET", `/api/query-runs/${run.json().id}`);
    expect(result.body).not.toContain("fixture-secret-token");
    expect(
      JSON.stringify(app.miracle.db.query("SELECT error FROM query_runs").rows),
    ).not.toContain("fixture-secret-token");
  }
  mode = "success";
});
it("redacts the token actually sent even if its cache is cleared while the reply is in flight", async () => {
  let cached: string | undefined = "expired-in-flight-secret";
  const isolated = await tlsServer(certs, (req, res) => {
    cached = undefined;
    res.writeHead(403).end(`Rejected ${req.headers.authorization}`);
  });
  try {
    const error = await engineMetadata(
      {
        name: "in-flight token",
        engine: "trino",
        url: isolated.url,
        username: "",
        password: "",
        trino: { externalAuthentication: true, tls: { caCert: certs.caCert } },
        trinoAuth: {
          getToken: () => cached,
          rejectToken: () => {
            cached = undefined;
          },
        },
      },
      "SELECT 1",
    ).catch((error) => error);
    expect(error.code).toBe("CONNECTION_ACCESS");
    expect(error.details).not.toContain("expired-in-flight-secret");
    expect(error.details).toContain("[скрыто]");
  } finally {
    await closeTls(isolated.server);
  }
});
