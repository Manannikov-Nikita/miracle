import { beforeAll, expect, it } from "vitest";
import {
  executeEngine,
  engineMetadata,
  type EngineConnection,
} from "../src/server/connectors.js";
import { certificates, tlsServer, closeTls } from "./clickhouse-fixture.js";
import { trinoConnectionError } from "../src/server/trinoTransport.js";

let certs: ReturnType<typeof certificates>;
beforeAll(() => {
  certs = certificates();
}, 20000);

const result = { columns: [{ name: "n", type: "bigint" }], data: [[1]] };
async function connectionCount(
  server: Awaited<ReturnType<typeof tlsServer>>["server"],
) {
  return new Promise<number>((resolve, reject) =>
    server.getConnections((error, count) =>
      error ? reject(error) : resolve(count),
    ),
  );
}
function connection(
  url: string,
  caCert: string | undefined = certs.caCert,
): EngineConnection {
  return {
    name: "Trino TLS fixture",
    engine: "trino",
    url,
    username: "fixture-user",
    password: "fixture-secret",
    ...(caCert ? { trino: { tls: { caCert } } } : {}),
  };
}
function run(
  c: EngineConnection,
  signal = AbortSignal.timeout(3000),
  onCancel: (fn: () => Promise<void>) => void = () => {},
) {
  return executeEngine(
    c,
    { connectionId: "fixture", sql: "SELECT 1" },
    "trino-tls-fixture",
    { timeoutMs: 3000, maxRows: 10, maxBytes: 10000 },
    signal,
    onCancel,
  );
}

it("uses the connection CA for the initial request and every result page", async () => {
  let origin = "";
  const requests: string[] = [];
  const authentication: (string | undefined)[] = [];
  const f = await tlsServer(certs, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    authentication.push(req.headers.authorization);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/v1/statement"
          ? { nextUri: origin + "/v1/statement/one" }
          : req.url === "/v1/statement/one"
            ? { ...result, nextUri: origin + "/v1/statement/two" }
            : { data: [[2]] },
      ),
    );
  });
  origin = f.url;
  try {
    expect((await run(connection(origin))).rows).toEqual([[1], [2]]);
    expect(requests).toEqual([
      "POST /v1/statement",
      "GET /v1/statement/one",
      "GET /v1/statement/two",
    ]);
    expect(authentication).toEqual(
      Array(3).fill(
        "Basic " +
          Buffer.from("fixture-user:fixture-secret").toString("base64"),
      ),
    );
    await expect.poll(() => connectionCount(f.server)).toBe(0);
  } finally {
    await closeTls(f.server);
  }
});

it("rejects an untrusted certificate with a CA diagnostic instead of fetch failed", async () => {
  const f = await tlsServer(certs, (_req, res) =>
    res.end(JSON.stringify(result)),
  );
  try {
    const c = connection(f.url);
    delete c.trino;
    await expect(run(c)).rejects.toThrow(/CA.*PEM/);
  } finally {
    await closeTls(f.server);
  }
});

it("keeps a trusted connection isolated from missing or unrelated CA settings", async () => {
  const f = await tlsServer(certs, (_req, res) =>
    res.end(JSON.stringify(result)),
  );
  try {
    expect((await run(connection(f.url))).rows).toEqual([[1]]);
    await expect(run(connection(f.url, certs.wrongCa))).rejects.toThrow(
      /CA.*PEM/,
    );
    const c = connection(f.url);
    delete c.trino;
    await expect(run(c)).rejects.toThrow(/CA.*PEM/);
    expect((await run(connection(f.url))).rows).toEqual([[1]]);
  } finally {
    await closeTls(f.server);
  }
});

it("still verifies the server hostname when an explicit CA is trusted", async () => {
  const f = await tlsServer(certs, (_req, res) =>
    res.end(JSON.stringify(result)),
  );
  try {
    await expect(
      run(connection(f.url.replace("localhost", "127.0.0.1"))),
    ).rejects.toThrow(/Имя сервера Trino.*сертификат/);
  } finally {
    await closeTls(f.server);
  }
});

it("uses the CA for cancellation after the failed metadata request has released its transport", async () => {
  let origin = "";
  let deleted = false;
  const f = await tlsServer(certs, (req, res) => {
    if (req.method === "DELETE") {
      deleted = true;
      res.writeHead(204).end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          nextUri: origin + "/v1/statement/failed",
          error: { message: "fixture query failed" },
        }),
      );
    }
  });
  origin = f.url;
  try {
    await expect(
      engineMetadata(connection(origin), "SELECT version()"),
    ).rejects.toThrow("fixture query failed");
    expect(deleted).toBe(true);
  } finally {
    await closeTls(f.server);
  }
});

it("cancels over the same CA while an aborted continuation is being cleaned up", async () => {
  let origin = "";
  let continuing!: () => void;
  const continuation = new Promise<void>((resolve) => {
    continuing = resolve;
  });
  let deleted = false;
  const f = await tlsServer(certs, (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "DELETE") {
      deleted = true;
      res.writeHead(204).end();
    } else if (req.url === "/v1/statement") {
      res.end(JSON.stringify({ nextUri: origin + "/v1/statement/running" }));
    } else {
      res.write('{"data":[');
      continuing();
    }
  });
  origin = f.url;
  const abort = new AbortController();
  let cancel: (() => Promise<void>) | undefined;
  try {
    const execution = run(connection(origin), abort.signal, (fn) => {
      cancel = fn;
    });
    const outcome = execution.then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    );
    await Promise.race([
      continuation,
      outcome.then(({ error }) => {
        throw error || new Error("Query finished before continuation");
      }),
    ]);
    abort.abort();
    await cancel!();
    expect((await outcome).error).toBeInstanceOf(Error);
    expect(deleted).toBe(true);
    await expect.poll(() => connectionCount(f.server)).toBe(0);
  } finally {
    abort.abort();
    await closeTls(f.server);
  }
});

it.each(["initial", "continuation", "cancel"] as const)(
  "does not follow a custom-CA Trino %s redirect or forward credentials",
  async (stage) => {
    let reached = 0;
    const foreign = await tlsServer(certs, (_req, res) => {
      reached++;
      res.end(JSON.stringify(result));
    });
    let origin = "";
    const coordinator = await tlsServer(certs, (req, res) => {
      const redirect =
        stage === "initial" ||
        (stage === "continuation" && req.url === "/v1/statement/next") ||
        (stage === "cancel" && req.method === "DELETE");
      if (redirect) res.writeHead(302, { Location: foreign.url }).end();
      else
        res.end(
          JSON.stringify(
            req.url === "/v1/statement"
              ? { nextUri: origin + "/v1/statement/next" }
              : result,
          ),
        );
    });
    origin = coordinator.url;
    let cancel: (() => Promise<void>) | undefined;
    try {
      const execution = run(
        connection(origin),
        AbortSignal.timeout(3000),
        (fn) => {
          cancel = fn;
        },
      );
      if (stage === "cancel") {
        await execution;
        await expect(cancel!()).rejects.toThrow();
      } else await expect(execution).rejects.toThrow();
      expect(reached).toBe(0);
    } finally {
      await closeTls(coordinator.server);
      await closeTls(foreign.server);
    }
  },
);

it("enforces the response limit and closes custom-CA sockets on a rejected response", async () => {
  const f = await tlsServer(certs, (_req, res) => {
    res.end(JSON.stringify({ data: [["x".repeat(1100000)]] }));
  });
  try {
    await expect(run(connection(f.url))).rejects.toThrow(
      "Слишком большой ответ Trino",
    );
    await expect.poll(() => connectionCount(f.server)).toBe(0);
  } finally {
    await closeTls(f.server);
  }
});

it.each([
  ["CERT_HAS_EXPIRED", /просрочен/],
  ["CERT_NOT_YET_VALID", /ещё не действует/],
  ["ERR_TLS_CERT_ALTNAME_INVALID", /Имя сервера/],
  ["SELF_SIGNED_CERT_IN_CHAIN", /доверенный CA/],
  ["ENOTFOUND", /найти сервер/],
  ["ECONNREFUSED", /доступность сети/],
] as const)(
  "explains %s without exposing raw TLS exception data",
  (code, message) => {
    const secret = "-----BEGIN CERTIFICATE-----private diagnostic data";
    const cause = Object.assign(new Error(secret), { code });
    const error = trinoConnectionError(
      new TypeError("fetch failed: " + secret, { cause }),
    );
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain(secret);
    expect(error.cause).toBeUndefined();
  },
);
