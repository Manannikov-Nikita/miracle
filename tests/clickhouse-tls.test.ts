import { beforeAll, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  executeEngine,
  type EngineConnection,
} from "../src/server/connectors.js";
import {
  clickhouseOptionsSchema,
  mergeClickHouseOptions,
  validateClickHouseConnection,
} from "../src/server/clickhouseOptions.js";
import type { ConnectionDiagnosticError } from "../src/server/connectionErrors.js";
import {
  certificates,
  tlsServer,
  closeTls,
  compactResult,
} from "./clickhouse-fixture.js";
let certs: ReturnType<typeof certificates>;
beforeAll(() => {
  certs = certificates();
}, 20000);
const limits = { timeoutMs: 3000, maxRows: 10, maxBytes: 10000 };
function conn(url: string): EngineConnection {
  return {
    name: "fixture",
    engine: "clickhouse",
    url,
    username: "test",
    password: "secret",
    clickhouse: { tls: { caCert: certs.caCert } },
  };
}
function run(
  c: EngineConnection,
  signal = AbortSignal.timeout(4000),
  onCancel: (fn: () => Promise<void>) => void = () => {},
) {
  return executeEngine(
    c,
    { connectionId: "fixture", sql: "SELECT 1" },
    "tls-test-id",
    limits,
    signal,
    onCancel,
  );
}
it("uses an explicit CA and preserves lossless streamed values", async () => {
  const f = await tlsServer(certs, (_req, res) => res.end(compactResult));
  try {
    expect((await run(conn(f.url))).rows).toEqual([["9007199254740993"]]);
  } finally {
    await closeTls(f.server);
  }
});
it("keeps certificate trust and hostname verification mandatory", async () => {
  const f = await tlsServer(certs, (_req, res) => res.end(compactResult));
  try {
    const c = conn(f.url);
    c.clickhouse!.tls!.caCert = certs.wrongCa;
    await expect(run(c)).rejects.toMatchObject({ code: "CONNECTION_TLS_CA" });
    await expect(
      run(conn(f.url.replace("localhost", "127.0.0.1"))),
    ).rejects.toMatchObject({ code: "CONNECTION_TLS_HOSTNAME" });
    c.clickhouse = undefined;
    await expect(run(c)).rejects.toMatchObject({ code: "CONNECTION_TLS_CA" });
  } finally {
    await closeTls(f.server);
  }
});
it.each([false, true])(
  "uses mTLS and independently selects certificate database auth=%s",
  async (certificateAuth) => {
    let headers: any;
    const f = await tlsServer(
      certs,
      (req, res) => {
        headers = req.headers;
        res.end(compactResult);
      },
      { ca: certs.caCert, requestCert: true, rejectUnauthorized: true },
    );
    try {
      await expect(run(conn(f.url))).rejects.toThrow();
      const c = conn(f.url);
      c.clickhouse!.tls = {
        caCert: certs.caCert,
        clientCert: certs.clientCert,
        clientKey: certs.clientKey,
        certificateAuth,
      };
      expect((await run(c)).rows).toHaveLength(1);
      expect(headers.authorization).toBe(
        certificateAuth
          ? undefined
          : "Basic " + Buffer.from("test:secret").toString("base64"),
      );
      expect(headers["x-clickhouse-ssl-certificate-auth"]).toBe(
        certificateAuth ? "on" : undefined,
      );
      expect(headers["x-clickhouse-user"]).toBe(
        certificateAuth ? "test" : undefined,
      );
    } finally {
      await closeTls(f.server);
    }
  },
);
it("supports gzip requests and decoded streamed results with fixed output limits", async () => {
  let sql = "";
  let settings: URLSearchParams | undefined;
  const f = await tlsServer(certs, async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk);
    sql = gunzipSync(Buffer.concat(parts)).toString();
    settings = new URL(req.url!, "https://localhost").searchParams;
    res.setHeader("Content-Encoding", "gzip");
    res.end(gzipSync(compactResult));
  });
  try {
    const c = conn(f.url);
    c.clickhouse = {
      ...c.clickhouse,
      compression: true,
      settings: { max_threads: "2", session_timezone: "UTC" },
    };
    expect((await run(c)).rows).toHaveLength(1);
    expect(sql).toBe("SELECT 1");
    expect(settings!.get("max_threads")).toBe("2");
    expect(settings!.get("default_format")).toBe(
      "JSONCompactEachRowWithNamesAndTypes",
    );
    expect(settings!.get("max_result_rows")).toBe("10");
  } finally {
    await closeTls(f.server);
  }
});
it("enforces timeout over a continuously active response stream and kills separately using the same TLS", async () => {
  let killed = false;
  const f = await tlsServer(certs, async (req, res) => {
    let sql = "";
    for await (const chunk of req) sql += chunk;
    if (sql.startsWith("KILL QUERY")) {
      killed = true;
      res.end("killed");
      return;
    }
    res.write('["n"]\n["UInt64"]\n');
    const timer = setInterval(() => res.write("\n"), 30);
    res.on("close", () => clearInterval(timer));
  });
  try {
    const c = conn(f.url);
    c.clickhouse!.requestTimeoutMs = 1000;
    let cancel: (() => Promise<void>) | undefined;
    const started = Date.now();
    await expect(
      run(c, AbortSignal.timeout(4000), (fn) => {
        cancel = fn;
      }),
    ).rejects.toThrow("таймаут");
    expect(Date.now() - started).toBeLessThan(2200);
    await cancel!();
    expect(killed).toBe(true);
    await expect(run(conn(f.url), AbortSignal.timeout(30))).rejects.toThrow(
      "отменён",
    );
  } finally {
    await closeTls(f.server);
  }
});
it("rejects redirects, bounded error text and gzip bombs safely", async () => {
  let mode = "redirect";
  const f = await tlsServer(certs, (_req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { Location: "https://example.invalid" });
      res.end();
    } else if (mode === "error") {
      res.writeHead(500);
      res.end(
        "Code: 62. DB::Exception: syntax error secret " + certs.clientKey,
      );
    } else {
      res.setHeader("Content-Encoding", "gzip");
      res.end(gzipSync("x".repeat(1200000)));
    }
  });
  try {
    await expect(run(conn(f.url))).rejects.toMatchObject({
      code: "CONNECTION_REDIRECT",
      details: "ClickHouse HTTP 302",
    });
    mode = "error";
    const failure = await run(conn(f.url)).catch(
      (error) => error as ConnectionDiagnosticError,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as ConnectionDiagnosticError).details!;
    expect(message).toContain("Code: 62.");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("BEGIN PRIVATE");
    expect(message.length).toBeLessThan(2100);
    mode = "gzip";
    await expect(run(conn(f.url))).rejects.toThrow("Слишком больш");
  } finally {
    await closeTls(f.server);
  }
});
it("suppresses incomplete engine errors when the connection drops inside a reflected secret", async () => {
  const password = "fixture-interrupted-" + "z".repeat(100);
  const f = await tlsServer(certs, (_req, res) => {
    res.writeHead(401);
    res.flushHeaders();
    res.write("Code: 516. " + password.slice(0, 40));
    const timer = setTimeout(() => res.socket?.destroy(), 30);
    res.once("close", () => clearTimeout(timer));
  });
  try {
    const c = conn(f.url);
    c.password = password;
    const error = await run(c).catch((value) => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as ConnectionDiagnosticError).details).toBe(
      "ClickHouse HTTP 401: не удалось прочитать сообщение движка",
    );
  } finally {
    await closeTls(f.server);
  }
});
it.each(["password", "authorization", "partial-password"] as const)(
  "suppresses truncated engine errors reflecting %s across the byte limit",
  async (reflection) => {
    const password =
      reflection === "partial-password"
        ? "fixture-partial-" + "z".repeat(85)
        : "fixture-" + "z".repeat(3000);
    const f = await tlsServer(certs, (req, res) => {
      res.writeHead(401);
      const reflected =
        reflection === "authorization"
          ? req.headers.authorization!.slice(6)
          : password;
      res.end("x".repeat(1024 * 1024 - 20) + reflected);
    });
    try {
      const c = conn(f.url);
      c.password = password;
      const error = await run(c).catch((value) => value as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as ConnectionDiagnosticError).details).toBe(
        "ClickHouse HTTP 401: Ответ превышает 1 МБ; полные подробности доступны в журнале сервера БД.",
      );
    } finally {
      await closeTls(f.server);
    }
  },
);
it("strictly validates options, PEM pairs and preserved merged secrets", () => {
  for (const x of [
    { insecure: true },
    { settings: { default_format: "JSON" } },
    { settings: { max_threads: "1.2" } },
    { tls: { rejectUnauthorized: false } },
    { requestTimeoutMs: 999 },
    { tls: { caCert: "x".repeat(131073) } },
  ])
    expect(clickhouseOptionsSchema.safeParse(x).success).toBe(false);
  const c = conn("https://localhost:8443");
  c.clickhouse!.tls!.clientCert = certs.clientCert;
  expect(() => validateClickHouseConnection(c)).toThrow("вместе");
  c.clickhouse!.tls!.clientKey = certs.serverKey;
  expect(() => validateClickHouseConnection(c)).toThrow("соответствие");
  c.clickhouse!.tls!.clientKey = certs.clientKey;
  expect(() => validateClickHouseConnection(c)).not.toThrow();
  c.url = "http://localhost:8123";
  expect(() => validateClickHouseConnection(c)).toThrow("https");
  c.url = "https://localhost:8443";
  c.engine = "trino";
  expect(() => validateClickHouseConnection(c)).toThrow("Trino");
  const merged = mergeClickHouseOptions(
    {
      settings: { max_threads: "2" },
      tls: { caCert: certs.caCert, clientKey: certs.clientKey },
    },
    { settings: {}, tls: { caCert: null } },
  );
  expect(merged!.settings).toEqual({});
  expect(merged!.tls!.caCert).toBeNull();
  expect(merged!.tls!.clientKey).toBe(certs.clientKey);
  expect(mergeClickHouseOptions(merged, undefined)).toEqual(merged);
  expect(mergeClickHouseOptions(merged, null)).toBeUndefined();
});
