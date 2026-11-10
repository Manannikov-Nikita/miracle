import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { get as httpsGet } from "node:https";
import {
  executeEngine,
  type EngineConnection,
} from "../src/server/connectors.js";
import { TrinoAuthManager } from "../src/server/trinoAuth.js";
import { certificates, tlsServer, closeTls } from "./clickhouse-fixture.js";

// Substitute only OS/default CA discovery. TLS handshakes, hostname verification,
// HTTP clients and engine execution remain real; machine trust stores are untouched.
const stores = vi.hoisted(() => ({
  default: [] as string[],
  system: [] as string[],
}));
vi.mock("node:tls", async (original) => ({
  ...(await original<typeof import("node:tls")>()),
  getCACertificates: (type: "default" | "system") => stores[type],
}));

let certs: ReturnType<typeof certificates>;
let other: ReturnType<typeof certificates>;
beforeAll(() => {
  certs = certificates();
  other = certificates();
}, 20000);
beforeEach(() => {
  stores.default = [];
  stores.system = [];
});

function connection(
  engine: "clickhouse" | "trino",
  url: string,
): EngineConnection {
  return {
    name: "Automatic TLS fixture",
    engine,
    url,
    username: "reader",
    password: "fixture-secret",
  };
}
function run(
  c: EngineConnection,
  onCancel: (fn: () => Promise<void>) => void = () => {},
) {
  return executeEngine(
    c,
    { connectionId: "fixture", sql: "SELECT 1" },
    "automatic-tls",
    {
      timeoutMs: 3000,
      maxRows: 10,
      maxBytes: 10000,
    },
    AbortSignal.timeout(4000),
    onCancel,
  );
}
function response(engine: "clickhouse" | "trino") {
  return engine === "trino"
    ? JSON.stringify({ columns: [{ name: "n", type: "bigint" }], data: [[1]] })
    : '["n"]\n["UInt8"]\n[1]\n';
}

it.each([
  ["trino", "system"],
  ["trino", "default"],
  ["clickhouse", "system"],
  ["clickhouse", "default"],
] as const)(
  "automatically trusts %s HTTPS through the %s CA store",
  async (engine, store) => {
    stores[store] = [certs.caCert];
    const f = await tlsServer(certs, (_req, res) => res.end(response(engine)));
    try {
      expect((await run(connection(engine, f.url))).rows).toEqual([[1]]);
    } finally {
      await closeTls(f.server);
    }
  },
);

it.each(["trino", "clickhouse"] as const)(
  "keeps automatic %s trust strict and manual trust isolated",
  async (engine) => {
    const f = await tlsServer(certs, (_req, res) => res.end(response(engine)));
    const c = connection(engine, f.url);
    try {
      await expect(run(c)).rejects.toMatchObject({ code: "CONNECTION_TLS_CA" });
      stores.system = [certs.caCert];
      await expect(
        run({ ...c, url: f.url.replace("localhost", "127.0.0.1") }),
      ).rejects.toMatchObject({ code: "CONNECTION_TLS_HOSTNAME" });
      c[engine] = { tls: { caCert: certs.wrongCa } };
      await expect(run(c)).rejects.toMatchObject({ code: "CONNECTION_TLS_CA" });
      c[engine] = { tls: { caCert: null } };
      expect((await run(c)).rows).toEqual([[1]]);

      // Trust acquired by Miracle must not become Node's process-wide trust.
      await expect(
        new Promise<void>((resolve, reject) => {
          const request = httpsGet(f.url, { agent: false }, (res) => {
            res.resume();
            resolve();
          });
          request.on("error", reject);
        }),
      ).rejects.toMatchObject({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    } finally {
      await closeTls(f.server);
    }
  },
);

it.each(["trino", "clickhouse"] as const)(
  "combines default and system CA trust for %s",
  async (engine) => {
    stores.default = [certs.caCert];
    stores.system = [other.caCert];
    const bundled = await tlsServer(certs, (_req, res) =>
      res.end(response(engine)),
    );
    const system = await tlsServer(other, (_req, res) =>
      res.end(response(engine)),
    );
    try {
      expect((await run(connection(engine, bundled.url))).rows).toEqual([[1]]);
      expect((await run(connection(engine, system.url))).rows).toEqual([[1]]);
    } finally {
      await closeTls(bundled.server);
      await closeTls(system.server);
    }
  },
);

it("uses automatic Trino trust for result pages and a separate cancellation transport", async () => {
  stores.system = [certs.caCert];
  let origin = "";
  const requests: string[] = [];
  const f = await tlsServer(certs, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "DELETE") res.writeHead(204).end();
    else if (req.url === "/v1/statement")
      res.end(JSON.stringify({ nextUri: origin + "/v1/statement/one" }));
    else res.end(response("trino"));
  });
  origin = f.url;
  let cancel!: () => Promise<void>;
  try {
    expect(
      (
        await run(connection("trino", origin), (fn) => {
          cancel = fn;
        })
      ).rows,
    ).toEqual([[1]]);
    await cancel();
    expect(requests).toEqual([
      "POST /v1/statement",
      "GET /v1/statement/one",
      "DELETE /v1/statement/one",
    ]);
  } finally {
    await closeTls(f.server);
  }
});

it("uses automatic Trino trust for authentication challenge, token polling and receipt", async () => {
  stores.system = [certs.caCert];
  let origin = "";
  const requests: string[] = [];
  const f = await tlsServer(certs, (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/v1/statement") {
      res
        .writeHead(401, {
          "WWW-Authenticate": `Bearer x_token_server="${origin}/token", x_redirect_server="${origin}/login"`,
        })
        .end();
    } else if (req.method === "DELETE") res.writeHead(204).end();
    else res.end(JSON.stringify({ token: "synthetic-token" }));
  });
  origin = f.url;
  const manager = new TrinoAuthManager();
  const c = {
    ...connection("trino", origin),
    trino: { externalAuthentication: true },
  };
  try {
    const login = await manager.start(c, "saved:fixture");
    expect(login).toMatchObject({
      status: "pending",
      redirectUrl: origin + "/login",
    });
    expect(await manager.poll(login.id)).toEqual({ status: "authenticated" });
    expect(manager.context(c, "saved:fixture").getToken()).toBe(
      "synthetic-token",
    );
    expect(requests).toEqual([
      "POST /v1/statement",
      "GET /token",
      "DELETE /token",
    ]);
  } finally {
    manager.close();
    await closeTls(f.server);
  }
});
