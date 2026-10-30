// Runs the native release using only its bundled runtime, from unrelated Unicode paths.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { createServer } from "node:net";
const archive = resolve(process.argv[2] || "");
if (!process.argv[2])
  throw Error("Usage: node tests/local-install-smoke.mjs archive.tar.gz");
const root = await mkdtemp(join(tmpdir(), "miracle native Проверка "));
const install = join(root, "installed code"),
  bin = join(root, "bin"),
  data = join(install, "data");
const env = {
  ...process.env,
  MIRACLE_INSTALL_ROOT: install,
  MIRACLE_BIN_DIR: bin,
  MIRACLE_ARCHIVE: archive,
};
delete env.MIRACLE_DATA_DIR;
delete env.MIRACLE_CONTROL_TOKEN;
delete env.APP_ORIGIN;
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
let node, cli;
async function run(...args) {
  return await command(join(bin, "miracle"), args, {
    customEnv: { ...env, PATH: safePath },
  });
}
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
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
  const port = await freePort();
  console.log(
    "Starting bundled application, with system Node absent from PATH",
  );
  await run("start", "--port", String(port));
  const state = JSON.parse((await run("status", "--json")).stdout);
  assert.equal(state.status, "running");
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
  const activeInstall = await installArchive().then(
    () => false,
    () => true,
  );
  assert(
    activeInstall,
    "Installer must refuse an authenticated running workspace",
  );
  const key = await readFile(join(data, "encryption.key"));
  await run("stop");
  const backup = join(root, "portable backup");
  await run("backup", backup);
  await installArchive();
  assert.deepEqual(await readFile(join(data, "encryption.key")), key);
  await run("start", "--port", String(port));
  browser = await session();
  assert.equal(browser.body.workspaceId, workspaceId);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/boards/${board.id}`, {
        headers: { cookie: browser.cookie },
      })
    ).status,
    200,
  );
  await run("stop");
  const restored = join(root, "restored workspace");
  await run("restore", backup, "--data-dir", restored);
  await run("start", "--data-dir", restored, "--port", String(port));
  browser = await session();
  assert.equal(browser.body.workspaceId, workspaceId);
  await run("stop", "--data-dir", restored);
  const prodPackages = await readdir(join(code, "node_modules"));
  assert(!prodPackages.includes("pg"));
  assert(!prodPackages.includes("react"));
  assert(!prodPackages.includes("@node-rs"));
  console.log(
    `PASS: ${process.platform}-${process.arch}, install/reinstall, immutable code, authenticated lifecycle, persistence, backup/restore, private state, no system runtime`,
  );
} finally {
  if (node && cli) {
    await run("stop").catch(() => {});
    await run("stop", "--data-dir", join(root, "restored workspace")).catch(
      () => {},
    );
  }
  await rm(root, { recursive: true, force: true });
}
