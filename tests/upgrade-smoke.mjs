// Real published 0.2.x installations -> candidate, using only bundled runtimes.
// Usage: node tests/upgrade-smoke.mjs CANDIDATE.tar.gz OLD-0.2.0.tar.gz OLD-0.2.1.tar.gz
// Every archive needs its adjacent .sha256 and rendered install.sh. No live user
// installation or workspace is read, stopped, or modified by this test.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const [candidateArgument, ...legacyArguments] = process.argv.slice(2);
if (!candidateArgument || legacyArguments.length !== 2)
  throw new Error(
    "Usage: node tests/upgrade-smoke.mjs candidate.tar.gz 0.2.0.tar.gz 0.2.1.tar.gz",
  );
const candidate = resolve(candidateArgument);
const archives = legacyArguments.map((path) => resolve(path));
const target = `${process.platform}-${process.arch}`;
const candidateVersion = new RegExp(
  `^miracle-(\\d+\\.\\d+\\.\\d+)-${target}\\.tar\\.gz$`,
).exec(basename(candidate))?.[1];
assert(
  candidateVersion,
  "Candidate must target this operating system and architecture",
);
const expectedLegacyVersions = ["0.2.0", "0.2.1"];
for (const [index, archive] of archives.entries())
  assert.equal(
    basename(archive),
    `miracle-${expectedLegacyVersions[index]}-${target}.tar.gz`,
  );
for (const archive of [candidate, ...archives]) {
  const expected = (await readFile(`${archive}.sha256`, "utf8"))
    .trim()
    .split(/\s+/)[0];
  assert.match(expected, /^[a-f0-9]{64}$/i);
  const actual = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  assert.equal(
    actual,
    expected.toLowerCase(),
    `Archive checksum: ${basename(archive)}`,
  );
  await readFile(join(dirname(archive), "install.sh"));
}

const root = await realpath(
  await mkdtemp(join(tmpdir(), "miracle upgrade Проверка ")),
);
const fixtures = [];
const cleanup = [];
const username = "upgrade-reader",
  password = "synthetic-upgrade-secret";
const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const row = [42, "upgrade-preserved"];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const safePath = "/usr/bin:/bin";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((r) => server.close(r));
  return port;
}
function fixture(req, res) {
  req.resume();
  if (req.url !== "/v1/statement" || req.method !== "POST")
    return res.writeHead(404).end();
  if (req.headers.authorization !== expectedAuth)
    return res.writeHead(401).end("Fixture credentials missing");
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      columns: [
        { name: "answer", type: "integer" },
        { name: "label", type: "varchar" },
      ],
      data: [row],
    }),
  );
}

try {
  const http = createServer(fixture);
  fixtures.push(http);
  const httpPort = await listen(http);
  const certFile = join(root, "fixture-ca.pem"),
    keyFile = join(root, "fixture-key.pem");
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
      "/CN=Miracle upgrade fixture",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyFile,
      "-out",
      certFile,
    ],
    { stdio: "ignore" },
  );
  const caCert = await readFile(certFile, "utf8");
  const https = createHttpsServer(
    { key: await readFile(keyFile), cert: caCert },
    fixture,
  );
  fixtures.push(https);
  const httpsPort = await listen(https);

  for (const [index, legacyArchive] of archives.entries()) {
    const oldVersion = expectedLegacyVersions[index];
    for (const storage of ["global", "custom"]) {
      const project = join(root, `${oldVersion} ${storage} project`);
      const install = join(project, "installed code"),
        bin = join(project, "custom bin");
      const data =
        storage === "global"
          ? join(install, "data")
          : join(project, "данные вне установки");
      await mkdir(project, { recursive: true });
      const env = {
        ...process.env,
        PATH: safePath,
        MIRACLE_INSTALL_ROOT: install,
        MIRACLE_BIN_DIR: bin,
      };
      for (const name of [
        "MIRACLE_DATA_DIR",
        "MIRACLE_CONTROL_TOKEN",
        "APP_ORIGIN",
        "PORT",
        "MIRACLE_RUNTIME_PORT",
        "MIRACLE_PROJECT_ROOT",
        "MIRACLE_INSTANCE_ID",
        "MIRACLE_ARCHIVE",
        "MIRACLE_CHECKSUM_FILE",
      ])
        delete env[name];
      async function command(
        executable,
        args,
        { extraEnv = {}, allowFailure = false } = {},
      ) {
        return await new Promise((resolve, reject) => {
          const child = spawn(executable, args, {
            cwd: project,
            env: { ...env, ...extraEnv },
          });
          let stdout = "",
            stderr = "";
          const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
          child.stdout.on("data", (part) => (stdout += part));
          child.stderr.on("data", (part) => (stderr += part));
          child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0 && !allowFailure)
              reject(
                new Error(
                  `${basename(executable)} ${args[0] ?? ""}: ${stderr || stdout}`,
                ),
              );
            else resolve({ stdout, stderr, code });
          });
        });
      }
      const launcher = join(bin, "miracle");
      const run = (...args) => command(launcher, args);
      const oldStorageArgs = storage === "global" ? [] : ["--data-dir", data];
      // Both are explicit after the upgrade: default storage is now project/.miracle.
      const storageArgs = ["--data-dir", data];
      const installArchive = (archive, extraEnv) =>
        command("/bin/sh", [join(dirname(archive), "install.sh")], {
          extraEnv: { MIRACLE_ARCHIVE: archive, ...extraEnv },
        });
      await installArchive(legacyArchive);
      assert.equal((await run("--version")).stdout.trim(), oldVersion);
      cleanup.push(() => run("stop", ...storageArgs));
      const oldNode = join(install, "versions", oldVersion, "runtime/bin/node");
      const port = await freePort();
      await run("start", "--port", String(port), ...oldStorageArgs);
      const oldState = JSON.parse(
        (await run("status", "--json", ...oldStorageArgs)).stdout,
      );
      assert.equal(oldState.status, "running");
      assert.equal(oldState.dataDir, data);
      let browser;
      async function session(activePort = port) {
        const response = await fetch(
          `http://127.0.0.1:${activePort}/api/session`,
        );
        assert.equal(response.status, 200);
        browser = {
          port: activePort,
          body: await response.json(),
          cookie: response.headers.get("set-cookie").split(";")[0],
        };
        return browser.body;
      }
      async function api(path, payload) {
        const response = await fetch(
          `http://127.0.0.1:${browser.port}${path}`,
          {
            method: payload === undefined ? "GET" : "POST",
            headers: {
              cookie: browser.cookie,
              "x-csrf-token": browser.body.csrfToken,
              "content-type": "application/json",
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          },
        );
        assert(
          response.ok,
          `${path}: ${response.status} ${await response.clone().text()}`,
        );
        return response.json();
      }
      const workspaceId = (await session()).workspaceId;
      const connection = await api("/api/connections", {
        name: `Upgrade ${oldVersion} ${storage}`,
        engine: "trino",
        username,
        password,
        url:
          index === 0
            ? `http://127.0.0.1:${httpPort}`
            : `https://127.0.0.1:${httpsPort}`,
        catalog: "fixture",
        schema: "public",
        ...(index === 1 ? { trino: { tls: { caCert } } } : {}),
      });
      const source = {
        connectionId: connection.id,
        sql: "SELECT 42 AS answer, 'upgrade-preserved' AS label",
        catalog: "fixture",
        schema: "public",
      };
      const query = await api("/api/queries", {
        name: "Сохранённый запрос.sql",
        ...source,
      });
      async function execute() {
        let result = await api("/api/query-runs", source);
        for (
          let attempt = 0;
          attempt < 100 && ["running", "cancelling"].includes(result.status);
          attempt++
        ) {
          await delay(30);
          result = await api(`/api/query-runs/${result.id}`);
        }
        assert.equal(result.status, "completed", result.error);
        assert.deepEqual(
          (await api(`/api/result-sets/${result.resultSetId}/rows`)).rows,
          [row],
        );
        return result;
      }
      const completed = await execute();
      const board = await api("/api/boards", {
        name: "Доска до обновления",
        document: {
          schemaVersion: 1,
          nodes: [
            {
              id: randomUUID(),
              type: "artifact",
              position: { x: 123, y: 456 },
              width: 480,
              height: 300,
              data: {
                title: "Сохранённый результат",
                kind: "result",
                view: "table",
                source,
                resultSetId: completed.resultSetId,
              },
            },
          ],
          edges: [],
          viewport: { x: 10, y: 20, zoom: 0.75 },
        },
      });
      await run("stop", ...oldStorageArgs);
      const key = await readFile(join(data, "encryption.key"));
      async function sqliteSnapshot(node, directory = data) {
        const result = await command(node, [
          "--input-type=module",
          "-e",
          `
          import { DatabaseSync } from 'node:sqlite';
          const db = new DatabaseSync(process.argv[1], { readOnly: true });
          console.log(JSON.stringify({schema: db.prepare('PRAGMA user_version').get().user_version,
            connection: db.prepare('SELECT * FROM connections').get(),
            tables: db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name)}));
          db.close();`,
          join(directory, "miracle.sqlite"),
        ]);
        return JSON.parse(result.stdout);
      }
      const before = await sqliteSnapshot(oldNode);
      assert.equal(before.schema, index === 0 ? 2 : 3);
      assert.notEqual(before.connection.password_encrypted, password);
      const oldBackup = join(project, "backup before upgrade");
      await run("backup", oldBackup, ...oldStorageArgs);
      assert.equal(
        JSON.parse(await readFile(join(oldBackup, "manifest.json"), "utf8"))
          .schemaVersion,
        before.schema,
      );
      await run("start", "--port", String(port), ...oldStorageArgs);

      // A rejected artifact must leave both the old code and live process intact.
      const badChecksum = join(project, "invalid-checksum.sha256");
      await writeFile(
        badChecksum,
        `${"0".repeat(64)}  ${basename(candidate)}\n`,
      );
      const rejected = await command(
        "/bin/sh",
        [join(dirname(candidate), "install.sh")],
        {
          allowFailure: true,
          extraEnv: {
            MIRACLE_ARCHIVE: candidate,
            MIRACLE_CHECKSUM_FILE: badChecksum,
          },
        },
      );
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /checksum mismatch/i);
      assert.equal((await run("--version")).stdout.trim(), oldVersion);
      assert.equal(
        JSON.parse((await run("status", "--json", ...oldStorageArgs)).stdout)
          .status,
        "running",
      );

      const upgraded = await installArchive(candidate);
      assert(upgraded.stdout.includes(`Existing workspace preserved: ${data}`));
      assert(upgraded.stdout.includes(`--data-dir '${data}' --port ${port}`));
      const installation = JSON.parse(
        await readFile(join(install, "installation.json"), "utf8"),
      );
      assert.equal(installation.version, 1);
      assert.equal(installation.binDir, bin);
      assert.equal((await run("--version")).stdout.trim(), candidateVersion);
      assert.equal(
        JSON.parse((await run("status", "--json", ...storageArgs)).stdout)
          .status,
        "stopped",
      );
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}/api/session`, {
          signal: AbortSignal.timeout(1000),
        }),
      );
      assert.deepEqual(await readFile(join(data, "encryption.key")), key);
      const newNode = join(
        install,
        "versions",
        candidateVersion,
        "runtime/bin/node",
      );
      // Installing code does not migrate or create user workspaces.
      assert.equal((await sqliteSnapshot(newNode)).schema, before.schema);
      await assert.rejects(
        readFile(join(project, ".miracle", "miracle.sqlite")),
        { code: "ENOENT" },
      );
      await run("start", "--port", String(port), ...storageArgs);
      const state = JSON.parse(
        (await run("status", "--json", ...storageArgs)).stdout,
      );
      assert.equal(state.port, port);
      assert.equal(state.projectRoot, project);
      assert.equal((await session()).workspaceId, workspaceId);
      async function verifyStored() {
        const connections = await api("/api/connections");
        assert.equal(connections.length, 1);
        assert.equal(connections[0].id, connection.id);
        assert.equal(connections[0].hasPassword, true);
        if (index === 1) assert.equal(connections[0].trino.tls.hasCaCert, true);
        assert(!JSON.stringify(connections).includes(password));
        assert(!JSON.stringify(connections).includes("BEGIN CERTIFICATE"));
        assert.deepEqual(await api("/api/queries"), [query]);
        assert.deepEqual(await api(`/api/boards/${board.id}`), board);
        assert.equal(
          (await api(`/api/query-runs/${completed.id}`)).resultSetId,
          completed.resultSetId,
        );
        assert.deepEqual(
          (await api(`/api/result-sets/${completed.resultSetId}/rows`)).rows,
          [row],
        );
        await execute(); // Proves the encrypted password/CA remain usable.
      }
      await verifyStored();
      const draft = {
        id: randomUUID(),
        name: "Browser draft.sql",
        ...source,
        sql: "SELECT 43",
        queryId: query.id,
        revision: query.revision,
      };
      const importBody = {
        migrationId: `legacy:${workspaceId}`,
        documents: [draft],
      };
      await api("/api/editor-documents/import", importBody);
      await api("/api/editor-documents/import", importBody);
      const editors = await api("/api/editor-documents");
      assert.equal(editors.length, 1);
      assert.equal(editors[0].sql, draft.sql);
      assert.equal(editors[0].queryRevision, query.revision);
      const profile = await api("/api/agent-profiles", {
        name: "Configured locally",
        provider: "codex",
        command: "not-installed-upgrade-fixture",
      });
      const chat = await api("/api/chats", {
        profileId: profile.id,
        title: "Restored chat",
      });
      await run("stop", ...storageArgs);
      const after = await sqliteSnapshot(newNode);
      assert.equal(after.schema, 4);
      assert.equal(
        after.connection.password_encrypted,
        before.connection.password_encrypted,
      );
      if (index === 1)
        assert.equal(
          after.connection.trino_options_encrypted,
          before.connection.trino_options_encrypted,
        );
      for (const table of [
        "editor_documents",
        "agent_profiles",
        "agent_chats",
        "agent_turns",
        "agent_messages",
        "project_events",
      ])
        assert(after.tables.includes(table), `Missing migrated table ${table}`);
      const newBackup = join(project, "backup after upgrade");
      await run("backup", newBackup, ...storageArgs);

      for (const [label, backup] of [
        ["old backup", oldBackup],
        ["new backup", newBackup],
      ]) {
        const restored = join(project, `restored ${label}`);
        await mkdir(restored);
        cleanup.push(() => run("stop", "--project-dir", restored));
        await run("restore", backup, "--project-dir", restored);
        await run("start", "--project-dir", restored);
        const restoredState = JSON.parse(
          (await run("status", "--json", "--project-dir", restored)).stdout,
        );
        assert.equal(restoredState.dataDir, join(restored, ".miracle"));
        assert.equal(
          (await session(restoredState.port)).workspaceId,
          workspaceId,
        );
        await verifyStored();
        const restoredEditors = await api("/api/editor-documents");
        assert.equal(restoredEditors.length, label === "new backup" ? 1 : 0);
        if (label === "new backup") {
          assert.equal(restoredEditors[0].sql, draft.sql);
          const profiles = await api("/api/agent-profiles");
          assert.equal(profiles[0].id, profile.id);
          assert.equal(profiles[0].trusted, false);
          assert.equal((await api("/api/chats"))[0].id, chat.id);
        }
        await run("stop", "--project-dir", restored);
      }
      console.log(
        `PASS ${oldVersion} -> ${candidateVersion} (${storage}): live upgrade, checksum rejection, unchanged key/secrets, query/board/result, same origin, draft import, old/new backup restore`,
      );
    }
  }
  console.log(
    `PASS upgrade matrix: ${target}, 0.2.0/0.2.1 × global/custom storage, bundled Node only`,
  );
} finally {
  for (const stop of cleanup.reverse()) await stop().catch(() => {});
  for (const server of fixtures) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await rm(root, { recursive: true, force: true });
}
