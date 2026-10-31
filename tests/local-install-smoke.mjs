// Runs the native release using only its bundled runtime, from unrelated Unicode paths.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createServer as createHttpsServer } from "node:https";
const archive = resolve(process.argv[2] || "");
if (!process.argv[2])
  throw Error("Usage: node tests/local-install-smoke.mjs archive.tar.gz");
const root = await realpath(
  await mkdtemp(join(tmpdir(), "miracle native Проверка ")),
);
const install = join(root, "installed code"),
  bin = join(root, "bin"),
  data = join(root, ".miracle"),
  legacyData = join(install, "data"),
  secondProject = join(root, "second project");
const env = {
  ...process.env,
  MIRACLE_INSTALL_ROOT: install,
  MIRACLE_BIN_DIR: bin,
  MIRACLE_ARCHIVE: archive,
};
delete env.MIRACLE_DATA_DIR;
delete env.MIRACLE_CONTROL_TOKEN;
delete env.APP_ORIGIN;
delete env.PORT;
delete env.MIRACLE_RUNTIME_PORT;
delete env.MIRACLE_PROJECT_ROOT;
delete env.MIRACLE_INSTANCE_ID;
const safePath = "/usr/bin:/bin";
async function command(
  executable,
  args,
  { allowFailure = false, customEnv = env } = {},
) {
  return await new Promise((res, rej) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: customEnv,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", rej);
    child.on("close", (code) => {
      if (code !== 0 && !allowFailure) rej(Error(`${executable}: ${stderr}`));
      else res({ stdout, stderr, code });
    });
  });
}
async function installArchive() {
  return await command("sh", [join(dirname(archive), "install.sh")]);
}
let node, cli, trinoServer;
async function run(...args) {
  return await command(join(bin, "miracle"), args, {
    customEnv: { ...env, PATH: safePath },
  });
}

try {
  await installArchive();
  const version = (
    await readFile(join(install, "current-version"), "utf8")
  ).trim();
  const code = join(install, "versions", version);
  // This upstream fixture is empty; reading it still proves the Unicode path survived.
  await readFile(
    join(code, "node_modules/@fastify/send/test/fixtures/snow ☃/index.html"),
  );
  node = join(code, "runtime/bin/node");
  cli = join(code, "dist/server/server/cli.js");
  assert.equal((await command(node, ["--version"])).stdout.trim(), "v24.22.2");
  assert.equal((await run("--version")).stdout.trim(), version);
  console.log(
    "Starting bundled application, with system Node absent from PATH",
  );
  await run("start");
  const state = JSON.parse((await run("status", "--json")).stdout);
  assert.equal(state.status, "running");
  const port = state.port;
  assert(Number.isInteger(port) && port > 0);
  assert.equal(state.projectRoot, root);
  assert.equal(state.dataDir, data);
  await run("start");
  assert.equal(
    JSON.parse((await run("status", "--json")).stdout).pid,
    state.pid,
  );
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  async function session() {
    const r = await fetch(`http://127.0.0.1:${port}/api/session`);
    assert.equal(r.status, 200);
    return {
      body: await r.json(),
      cookie: r.headers.get("set-cookie").split(";")[0],
    };
  }
  let browser = await session();
  const workspaceId = browser.body.workspaceId;
  // Exercise the installed runtime against a synthetic private CA, never a real source.
  const certificateFile = join(root, "fixture-ca.pem");
  const keyFile = join(root, "fixture-key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=Miracle native TLS fixture",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyFile,
      "-out",
      certificateFile,
    ],
    { stdio: "ignore" },
  );
  const caCert = await readFile(certificateFile, "utf8");
  trinoServer = createHttpsServer(
    { key: await readFile(keyFile), cert: caCert },
    async (req, res) => {
      for await (const chunk of req) {
        /* Drain the statement body. */
      }
      if (req.method !== "POST" || req.url !== "/v1/statement") {
        res.writeHead(404).end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          columns: [{ name: "version", type: "varchar" }],
          data: [["native-trino-tls"]],
        }),
      );
    },
  );
  await new Promise((resolve, reject) => {
    trinoServer.once("error", reject);
    trinoServer.listen(0, "127.0.0.1", resolve);
  });
  const trinoInput = {
    name: "Native Trino TLS",
    engine: "trino",
    username: "fixture-reader",
    url: `https://127.0.0.1:${trinoServer.address().port}`,
  };
  async function post(path, payload) {
    return await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        "x-csrf-token": browser.body.csrfToken,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  }
  const untrusted = await post("/api/connections/test", trinoInput);
  assert.equal(untrusted.status, 400);
  assert.match((await untrusted.json()).error, /CA|сертификат/i);
  const trusted = await post("/api/connections", {
    ...trinoInput,
    trino: { tls: { caCert } },
  });
  assert.equal(trusted.status, 201, await trusted.clone().text());
  const trinoConnection = await trusted.json();
  assert.equal(trinoConnection.trino.tls.hasCaCert, true);
  assert(!JSON.stringify(trinoConnection).includes("BEGIN CERTIFICATE"));
  async function verifySavedTrino() {
    const response = await post(
      `/api/connections/${trinoConnection.id}/test`,
      {},
    );
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).version, "native-trino-tls");
  }
  await verifySavedTrino();
  const response = await fetch(`http://127.0.0.1:${port}/api/boards`, {
    method: "POST",
    headers: {
      cookie: browser.cookie,
      "x-csrf-token": browser.body.csrfToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Persistent native smoke",
      document: { schemaVersion: 1, nodes: [], edges: [] },
    }),
  });
  assert.equal(response.status, 201);
  const board = await response.json();
  const key = await readFile(join(data, "encryption.key"));
  await mkdir(secondProject);
  await run("start", "--project-dir", secondProject);
  const second = JSON.parse(
    (await run("status", "--json", "--project-dir", secondProject)).stdout,
  );
  assert.equal(second.status, "running");
  assert.notEqual(second.port, port);
  assert.equal(second.dataDir, join(secondProject, ".miracle"));
  await installArchive();
  assert.equal(
    JSON.parse((await run("status", "--json")).stdout).status,
    "stopped",
  );
  assert.equal(
    JSON.parse(
      (await run("status", "--json", "--project-dir", secondProject)).stdout,
    ).status,
    "stopped",
  );
  const backup = join(root, "portable backup");
  await run("backup", backup);
  await installArchive();
  assert.deepEqual(await readFile(join(data, "encryption.key")), key);
  await run("start", "--port", String(port));
  browser = await session();
  assert.equal(browser.body.workspaceId, workspaceId);
  await verifySavedTrino();
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/boards/${board.id}`, {
        headers: { cookie: browser.cookie },
      })
    ).status,
    200,
  );
  await run("stop");
  // A former global installation data directory remains explicitly accessible.
  const restored = legacyData;
  await run("restore", backup, "--data-dir", restored);
  await run("start", "--data-dir", restored, "--port", String(port));
  const legacyState = JSON.parse(
    (await run("status", "--json", "--data-dir", restored)).stdout,
  );
  assert.equal(legacyState.dataDir, legacyData);
  assert.equal(legacyState.projectRoot, root);
  const wrongStorage = await command(
    join(bin, "miracle"),
    ["status", "--json"],
    {
      allowFailure: true,
      customEnv: { ...env, PATH: safePath },
    },
  );
  assert.notEqual(wrongStorage.code, 0);
  assert.match(
    wrongStorage.stderr,
    /already running with different data storage/,
  );
  browser = await session();
  assert.equal(browser.body.workspaceId, workspaceId);
  await verifySavedTrino();
  await run("stop", "--data-dir", restored);
  const prodPackages = await readdir(join(code, "node_modules"));
  assert(!prodPackages.includes("pg"));
  assert(!prodPackages.includes("react"));
  assert(!prodPackages.includes("@node-rs"));
  console.log(
    `PASS: ${process.platform}-${process.arch}, project .miracle and ephemeral ports, live multi-project reinstall, explicit legacy storage, authenticated lifecycle, Trino HTTPS CA persistence and backup/restore, private state, no system runtime`,
  );
} finally {
  if (node && cli) {
    await run("stop").catch(() => {});
    await run("stop", "--data-dir", legacyData).catch(() => {});
    await run("stop", "--project-dir", secondProject).catch(() => {});
  }
  if (trinoServer) {
    trinoServer.closeAllConnections();
    await new Promise((resolve) => trinoServer.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
