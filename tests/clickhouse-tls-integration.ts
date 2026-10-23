/** Real ClickHouse 25.8 HTTPS/mTLS checks. Run: npx tsx tests/clickhouse-tls-integration.ts.
 * Requires Docker and openssl; creates only a disposable container and synthetic PKI.
 * --serve retains the fixture for manual connection-form checks until Ctrl-C.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { request } from "node:https";
import {
  executeEngine,
  engineMetadata,
  type EngineConnection,
} from "../src/server/connectors.js";

const exec = promisify(execFile);
const name = `miracle-clickhouse-tls-${randomUUID()}`;
await mkdir(resolve(".local"), { recursive: true });
const directory = await mkdtemp(resolve(".local/clickhouse-tls-"));
let started = false;
const file = (name: string) => join(directory, name);
const pem = (name: string) => readFile(file(name), "utf8");
async function openssl(...args: string[]) {
  await exec("openssl", args, { cwd: directory });
}
async function signedCertificate(name: string, extension: string) {
  await openssl(
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.csr`,
    "-subj",
    `/CN=${name === "server" ? "localhost" : "miracle-test-client"}`,
  );
  await writeFile(file(`${name}.ext`), extension);
  await openssl(
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    `${name}.crt`,
    "-days",
    "1",
    "-extfile",
    `${name}.ext`,
  );
}
async function cleanup() {
  if (started) await exec("docker", ["rm", "-f", name]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
try {
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "1",
    "-subj",
    "/CN=Miracle disposable TLS integration CA",
  );
  await signedCertificate(
    "server",
    "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
  );
  await signedCertificate("client", "extendedKeyUsage=clientAuth\n");
  // The container runs as clickhouse; these are disposable test keys, never real credentials.
  await chmod(directory, 0o755);
  for (const filename of ["server.key", "server.crt", "ca.crt"])
    await chmod(file(filename), 0o644);
  await writeFile(
    file("tls.xml"),
    `<clickhouse>
    <https_port>8443</https_port>
    <listen_host>0.0.0.0</listen_host>
    <openSSL><server>
      <certificateFile>/tls/server.crt</certificateFile><privateKeyFile>/tls/server.key</privateKeyFile>
      <caConfig>/tls/ca.crt</caConfig><verificationMode>strict</verificationMode>
      <loadDefaultCAFile>false</loadDefaultCAFile><cacheSessions>true</cacheSessions>
    </server></openSSL>
    <access_control_improvements><settings_constraints_replace_previous>true</settings_constraints_replace_previous></access_control_improvements>
  </clickhouse>`,
  );
  const originalUsers = await readFile(
    resolve("infra/clickhouse/users.xml"),
    "utf8",
  );
  await writeFile(
    file("users.xml"),
    originalUsers
      .replace(
        "</users>",
        `<miracle_cert_reader>
      <ssl_certificates><common_name>miracle-test-client</common_name></ssl_certificates>
      <networks><ip>::/0</ip></networks><profile>miracle_readonly</profile><quota>default</quota>
      <grants><query>GRANT SELECT ON demo.*</query><query>GRANT SELECT ON system.tables</query><query>GRANT SELECT ON system.columns</query></grants>
    </miracle_cert_reader></users>`,
      )
      .replace(
        "<constraints>",
        `<constraints>
    <enable_http_compression><changeable_in_readonly/></enable_http_compression>
    <join_use_nulls><changeable_in_readonly/></join_use_nulls>
    <max_threads><min>1</min><max>2</max><changeable_in_readonly/></max_threads>
  `,
      ),
  );
  await exec("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    "127.0.0.1::8443",
    "--tmpfs",
    "/var/lib/clickhouse",
    "--tmpfs",
    "/var/log/clickhouse-server",
    "--mount",
    `type=bind,source=${directory},target=/tls,readonly`,
    "--mount",
    `type=bind,source=${file("tls.xml")},target=/etc/clickhouse-server/config.d/tls.xml,readonly`,
    "--mount",
    `type=bind,source=${file("users.xml")},target=/etc/clickhouse-server/users.d/miracle.xml,readonly`,
    "--mount",
    `type=bind,source=${resolve("infra/clickhouse/seed.sql")},target=/docker-entrypoint-initdb.d/seed.sql,readonly`,
    "clickhouse/clickhouse-server:25.8",
  ]);
  started = true;
  const published = (
    await exec("docker", ["port", name, "8443/tcp"])
  ).stdout.trim();
  const url = `https://${published}`;
  const caCert = await pem("ca.crt"),
    clientCert = await pem("client.crt"),
    clientKey = await pem("client.key");
  const connection: EngineConnection = {
    name: "Disposable native ClickHouse TLS",
    engine: "clickhouse",
    url,
    username: "miracle_reader",
    password: "miracle_reader_local",
    database: "demo",
    clickhouse: {
      tls: { caCert, clientCert, clientKey },
      requestTimeoutMs: 5000,
      compression: true,
      settings: { join_use_nulls: "1", max_threads: "2" },
    },
  };
  async function probe() {
    return await new Promise<string>((resolve, reject) => {
      const req = request(
        `${url}/ping`,
        { ca: caCert, cert: clientCert, key: clientKey },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            res.statusCode === 200 ? resolve(body) : reject(new Error(body)),
          );
        },
      );
      req.on("error", reject);
      req.setTimeout(1000, () => req.destroy(new Error("probe timeout")));
      req.end();
    });
  }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (
      await probe().then(
        () => true,
        () => false,
      )
    ) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ready, "Disposable native ClickHouse HTTPS did not become ready");
  if (process.argv.includes("--serve")) {
    await writeFile(
      file("fixture.json"),
      JSON.stringify(
        {
          containerName: name,
          url,
          username: connection.username,
          password: connection.password,
          database: "demo",
          caCertPath: file("ca.crt"),
          clientCertPath: file("client.crt"),
          clientKeyPath: file("client.key"),
        },
        null,
        2,
      ),
    );
    console.log(
      `Native HTTPS/mTLS ClickHouse fixture: ${url}\nSynthetic connection and PEM paths: ${file("fixture.json")}`,
    );
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => {}, 1000);
      const stop = () => {
        clearInterval(keepAlive);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      process.stdin.once("data", stop);
    });
  } else {
    const run = (sql: string, c = connection) =>
      executeEngine(
        c,
        { connectionId: "tls-integration", sql },
        randomUUID(),
        { timeoutMs: 5000, maxRows: 100, maxBytes: 65536 },
        AbortSignal.timeout(8000),
        () => {},
      );
    const values = await run(
      "SELECT toUInt64('9007199254740993') AS duplicate, toUInt64('9007199254740993') AS duplicate, toDecimal64('123.45', 2) AS amount, CAST(NULL AS Nullable(String)) AS empty, [1, 2] AS items",
    );
    assert.deepEqual(
      values.columns.map((c) => [c.id, c.name, c.type]),
      [
        ["0", "duplicate", "UInt64"],
        ["1", "duplicate", "UInt64"],
        ["2", "amount", "Decimal(18, 2)"],
        ["3", "empty", "Nullable(String)"],
        ["4", "items", "Array(UInt8)"],
      ],
    );
    assert.deepEqual(values.rows, [
      ["9007199254740993", "9007199254740993", "123.45", null, [1, 2]],
    ]);
    assert.ok(values.byteCount > 0);
    console.log(
      "PASS native ClickHouse HTTPS+mTLS compressed results, duplicate column names, exact UInt64/Decimal and metadata",
    );
    const settings = await run(
      "SELECT toString(toUInt8(getSetting('join_use_nulls'))), toString(getSetting('max_threads'))",
    );
    assert.deepEqual(settings.rows, [["1", "2"]]);
    const metadata = await engineMetadata(
      connection,
      "SELECT name FROM system.tables WHERE database = 'demo' AND name = 'sales'",
    );
    assert.deepEqual(metadata.rows, [["sales"]]);
    console.log(
      "PASS readonly permitted query settings and metadata over native TLS",
    );
    const certificateAuth = await run("SELECT 42", {
      ...connection,
      username: "miracle_cert_reader",
      password: "",
      clickhouse: {
        ...connection.clickhouse,
        tls: { caCert, clientCert, clientKey, certificateAuth: true },
      },
    });
    assert.deepEqual(certificateAuth.rows, [[42]]);
    console.log(
      "PASS native ClickHouse certificate authentication with matching client common name",
    );
    const timeoutStarted = Date.now();
    await assert.rejects(
      run("SELECT sleepEachRow(0.2) FROM numbers(15)", {
        ...connection,
        clickhouse: { ...connection.clickhouse, requestTimeoutMs: 1000 },
      }),
      /таймаут|отменён/,
    );
    assert.ok(
      Date.now() - timeoutStarted >= 800,
      "Connection timeout must not fail immediately",
    );
    assert.ok(
      Date.now() - timeoutStarted < 4000,
      "Connection timeout must be shorter than the global 5s limit",
    );
    console.log("PASS per-connection timeout over native HTTPS");
    const noCa = {
      ...connection,
      clickhouse: { ...connection.clickhouse, tls: { clientCert, clientKey } },
    };
    await assert.rejects(run("SELECT 1", noCa));
    const noClient = {
      ...connection,
      clickhouse: { ...connection.clickhouse, tls: { caCert } },
    };
    await assert.rejects(run("SELECT 1", noClient));
    console.log(
      "PASS untrusted server rejection and required client-certificate rejection",
    );
    const plain: EngineConnection = {
      ...connection,
      url: process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:18123",
      clickhouse: undefined,
    };
    const baseline = await run(
      "SELECT customer_id FROM demo.sales ORDER BY id LIMIT 1",
      plain,
    );
    assert.deepEqual(baseline.rows, [["9007199254740993"]]);
    await assert.rejects(
      run("SELECT 1", {
        ...plain,
        clickhouse: { settings: { join_use_nulls: "1" } },
      }),
      /readonly|read.only|READONLY|setting|ClickHouse HTTP/i,
    );
    console.log(
      "PASS existing synthetic readonly HTTP baseline and server settings constraints",
    );
  }
} finally {
  await cleanup();
}
