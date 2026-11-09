// Published supported installation -> candidate via the actual miracle update CLI.
// Usage: node tests/upgrade-smoke.mjs CANDIDATE.tar.gz PREVIOUS-0.9.0.tar.gz
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
import { pathToFileURL } from "node:url";
import { createNativeFetch } from "./helpers/native-fetch.mjs";

const [candidateArgument, previousArgument, ...extraArguments] =
  process.argv.slice(2);
if (!candidateArgument || !previousArgument || extraArguments.length)
  throw new Error(
    "Usage: node tests/upgrade-smoke.mjs candidate.tar.gz previous-0.9.0.tar.gz",
  );
const candidate = resolve(candidateArgument);
const previousArchive = resolve(previousArgument);
const oldVersion = "0.9.0";
const target = `${process.platform}-${process.arch}`;
const candidateVersion = new RegExp(
  `^miracle-(\\d+\\.\\d+\\.\\d+)-${target}\\.tar\\.gz$`,
).exec(basename(candidate))?.[1];
assert(
  candidateVersion,
  "Candidate must target this operating system and architecture",
);
assert.equal(
  basename(previousArchive),
  `miracle-${oldVersion}-${target}.tar.gz`,
);
assert.notEqual(
  candidateVersion,
  oldVersion,
  "Candidate must advance the previous release",
);
for (const archive of [candidate, previousArchive]) {
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
const transport = createNativeFetch();
const { fetch } = transport;
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

const preload = join(root, "release-http-fixture.mjs");
const fixtureTools = join(root, "fixture-tools");
const curlFixture = join(root, "release-curl-fixture.mjs");
await mkdir(fixtureTools);
await writeFile(
  preload,
  `
import { createRequire } from "node:module";
import { readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Restrict the preload to the CLI update process, not its installer children.
if (process.argv.includes("update")) {
  const undici = createRequire(process.env.MIRACLE_SMOKE_PACKAGE)("undici");
  const version = process.env.MIRACLE_SMOKE_VERSION;
  const metadata = "https://api.github.com/repos/Manannikov-Nikita/miracle/releases/";
  const installer = "https://github.com/Manannikov-Nikita/miracle/releases/download/v" + version + "/install.sh";
  undici.fetch = async (url) => {
    appendFileSync(process.env.MIRACLE_SMOKE_REQUESTS, JSON.stringify(url) + "\\n");
    let body;
    if (url === metadata + "latest" || url === metadata + "tags/v" + version)
      body = JSON.stringify({ tag_name: "v" + version, draft: false, prerelease: false });
    else if (url === installer)
      body = readFileSync(join(dirname(process.env.MIRACLE_SMOKE_ARCHIVE), "install.sh"));
    else throw new Error("Unexpected release request: " + url);
    const response = new undici.Response(body, { status: 200 });
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
}
`,
);
await writeFile(
  curlFixture,
  `
import { copyFileSync, writeFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
const url = args.find(value => value.startsWith("https://"));
const archive = process.env.MIRACLE_SMOKE_ARCHIVE;
const base = "https://github.com/Manannikov-Nikita/miracle/releases/download/v" + process.env.MIRACLE_SMOKE_VERSION + "/";
if (!output || ![base + basename(archive), base + basename(archive) + ".sha256"].includes(url))
  throw new Error("Unexpected curl arguments: " + JSON.stringify(args));
appendFileSync(process.env.MIRACLE_SMOKE_REQUESTS, JSON.stringify(url) + "\\n");
if (process.env.MIRACLE_SMOKE_DOWNLOAD_FAILURE === "1") {
  process.stderr.write("Synthetic release download failure\\n");
  process.exit(22);
}
if (url.endsWith(".sha256") && process.env.MIRACLE_SMOKE_BAD_CHECKSUM === "1")
  writeFileSync(output, "0".repeat(64) + "  " + basename(archive) + "\\n");
else copyFileSync(archive + (url.endsWith(".sha256") ? ".sha256" : ""), output);
`,
);
await writeFile(
  join(fixtureTools, "curl"),
  '#!/bin/sh\nexec "$MIRACLE_SMOKE_NODE" "$MIRACLE_SMOKE_CURL" "$@"\n',
  { mode: 0o755 },
);

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

  for (const [index, storage] of ["project", "custom"].entries()) {
    const project = join(root, `${oldVersion} ${storage} project`);
    const install = join(project, "installed code"),
      bin = join(project, "custom bin");
    const data =
      storage === "project"
        ? join(project, ".miracle")
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
      "NODE_OPTIONS",
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
    const storageArgs = storage === "project" ? [] : ["--data-dir", data];
    const installArchive = (archive, extraEnv) =>
      command("/bin/sh", [join(dirname(archive), "install.sh")], {
        extraEnv: { MIRACLE_ARCHIVE: archive, ...extraEnv },
      });
    await installArchive(previousArchive);
    assert.equal((await run("--version")).stdout.trim(), oldVersion);
    cleanup.push(() => run("stop", ...storageArgs));
    const oldNode = join(install, "versions", oldVersion, "runtime/bin/node");
    const port = await freePort();
    await run("start", "--port", String(port), ...storageArgs);
    const oldState = JSON.parse(
      (await run("status", "--json", ...storageArgs)).stdout,
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
    async function api(path, payload, method) {
      const response = await fetch(`http://127.0.0.1:${browser.port}${path}`, {
        method: method ?? (payload === undefined ? "GET" : "POST"),
        headers: {
          cookie: browser.cookie,
          "x-csrf-token": browser.body.csrfToken,
          "content-type": "application/json",
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
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
    const draft = await api("/api/editor-documents", {
      id: randomUUID(),
      name: "Browser draft.sql",
      ...source,
      sql: "SELECT 43",
    });
    const profile = await api("/api/agent-profiles", {
      name: "Configured locally before upgrade",
      provider: "codex",
      command: "not-installed-upgrade-fixture",
    });
    const chat = await api("/api/chats", {
      profileId: profile.id,
      title: "Chat before upgrade",
      autoApprove: true,
    });
    await run("stop", ...storageArgs);
    // Seed a completed historical turn in this isolated fixture without ever
    // starting an agent or submitting a model request.
    const history = {
      chatId: chat.id,
      turnId: randomUUID(),
      requestId: randomUUID(),
      messageId: randomUUID(),
      time: "2026-11-09T12:00:00.000Z",
      content: "Synthetic conversation retained across the release update",
    };
    await command(oldNode, [
      "--input-type=module",
      "-e",
      `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1]);
        const fixture = JSON.parse(process.argv[2]);
        db.prepare("INSERT INTO agent_turns(id,chat_id,request_id,status,context_json,created_at,finished_at) VALUES(?,?,?,'completed','{}',?,?)")
          .run(fixture.turnId,fixture.chatId,fixture.requestId,fixture.time,fixture.time);
        db.prepare("INSERT INTO agent_messages(id,chat_id,turn_id,role,content,created_at) VALUES(?,?,?,'user',?,?)")
          .run(fixture.messageId,fixture.chatId,fixture.turnId,fixture.content,fixture.time);
        db.prepare("UPDATE agent_chats SET native_session_id='synthetic-upgrade-session' WHERE id=?").run(fixture.chatId);
        db.close();`,
      join(data, "miracle.sqlite"),
      JSON.stringify(history),
    ]);
    const key = await readFile(join(data, "encryption.key"));
    async function sqliteSnapshot(node, directory = data) {
      const result = await command(node, [
        "--input-type=module",
        "-e",
        `
          import { DatabaseSync } from 'node:sqlite';
          import { createHash } from 'node:crypto';
          const db = new DatabaseSync(process.argv[1], { readOnly: true });
          const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>r.name);
          const contents = tables.map(name => [name, db.prepare('SELECT * FROM ' + JSON.stringify(name)).all().map(row => JSON.stringify(row)).sort()]);
          console.log(JSON.stringify({schema: db.prepare('PRAGMA user_version').get().user_version,
            connection: db.prepare('SELECT * FROM connections').get(),
            chatColumns: db.prepare('PRAGMA table_info(agent_chats)').all().map(row=>row.name),
            chats: db.prepare('SELECT * FROM agent_chats ORDER BY id').all(),
            tables, digest: createHash('sha256').update(JSON.stringify(contents)).digest('hex')}));
          db.close();`,
        join(directory, "miracle.sqlite"),
      ]);
      return JSON.parse(result.stdout);
    }
    async function protectedState() {
      const state = JSON.parse(
        (await run("status", "--json", ...storageArgs)).stdout,
      );
      assert.equal(state.status, "running");
      assert(
        Number.isInteger(state.pid) && state.pid > 0,
        "Live process has a PID",
      );
      return {
        pid: state.pid,
        instanceId: state.instanceId,
        version: (await run("--version")).stdout.trim(),
        // A running workspace owns an exclusive SQLite lock. Hash its persisted
        // database and journal bytes without opening a competing connection.
        database: await Promise.all(
          [
            "miracle.sqlite",
            "miracle.sqlite-wal",
            "miracle.sqlite-journal",
          ].map(async (name) => {
            const bytes = await readFile(join(data, name)).catch((error) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
            return bytes
              ? createHash("sha256").update(bytes).digest("hex")
              : null;
          }),
        ),
        key: (await readFile(join(data, "encryption.key"))).toString("hex"),
      };
    }
    const before = await sqliteSnapshot(oldNode);
    assert.equal(
      before.schema,
      6,
      "Published release has the supported project schema",
    );
    assert(!before.chatColumns.includes("model_settings_json"));
    assert(!before.chatColumns.includes("native_session_reset"));
    assert.notEqual(before.connection.password_encrypted, password);
    const oldBackup = join(project, "backup before upgrade");
    await run("backup", oldBackup, ...storageArgs);
    assert.equal(
      JSON.parse(await readFile(join(oldBackup, "manifest.json"), "utf8"))
        .schemaVersion,
      before.schema,
    );
    await run("start", "--port", String(port), ...storageArgs);
    await session();
    const savedConversation = await api(`/api/chats/${chat.id}`);
    assert.equal(savedConversation.messages[0].content, history.content);
    const protectedBefore = await protectedState();

    // Test-only HTTP/curl fixtures supply this unpublished candidate at the
    // official URLs. CLI validation, downloaded installer, checksum validation,
    // lifecycle and activation all run unchanged, using the bundled Node.
    const updateEnv = {
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      PATH: `${fixtureTools}:${safePath}`,
      MIRACLE_SMOKE_PACKAGE: join(
        install,
        "versions",
        oldVersion,
        "package.json",
      ),
      MIRACLE_SMOKE_NODE: oldNode,
      MIRACLE_SMOKE_CURL: curlFixture,
      MIRACLE_SMOKE_REQUESTS: join(project, "release-requests.jsonl"),
      MIRACLE_SMOKE_VERSION: candidateVersion,
      MIRACLE_SMOKE_ARCHIVE: candidate,
      // The updater must discard unrelated manual-install overrides.
      MIRACLE_ARCHIVE: join(project, "unrelated-manual-archive.tar.gz"),
      MIRACLE_CHECKSUM_FILE: join(project, "unrelated-manual-checksum"),
    };
    const checked = await command(launcher, ["update", "--check"], {
      extraEnv: updateEnv,
    });
    assert.match(checked.stdout, /is available/);
    assert.deepEqual(await protectedState(), protectedBefore);
    assert.deepEqual(
      (await readFile(updateEnv.MIRACLE_SMOKE_REQUESTS, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse),
      [
        "https://api.github.com/repos/Manannikov-Nikita/miracle/releases/latest",
      ],
    );
    // Failed downloads and rejected artifacts preserve the same process and data.
    const failedDownload = await command(
      launcher,
      ["update", "--to", candidateVersion],
      {
        allowFailure: true,
        extraEnv: { ...updateEnv, MIRACLE_SMOKE_DOWNLOAD_FAILURE: "1" },
      },
    );
    assert.notEqual(failedDownload.code, 0);
    assert.match(failedDownload.stderr, /release download failed/i);
    assert.deepEqual(await protectedState(), protectedBefore);
    const rejected = await command(
      launcher,
      ["update", "--to", candidateVersion],
      {
        allowFailure: true,
        extraEnv: { ...updateEnv, MIRACLE_SMOKE_BAD_CHECKSUM: "1" },
      },
    );
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /checksum mismatch/i);
    assert.deepEqual(await protectedState(), protectedBefore);

    const upgraded = await command(
      launcher,
      ["update", "--to", candidateVersion],
      { extraEnv: updateEnv },
    );
    assert.match(upgraded.stdout, /Updating Miracle/);
    const installation = JSON.parse(
      await readFile(join(install, "installation.json"), "utf8"),
    );
    assert.equal(installation.version, 1);
    assert.equal(installation.binDir, bin);
    assert.equal((await run("--version")).stdout.trim(), candidateVersion);
    assert.equal(
      JSON.parse((await run("status", "--json", ...storageArgs)).stdout).status,
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
    if (storage === "custom")
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
    const currentUpdateEnv = {
      ...updateEnv,
      MIRACLE_SMOKE_PACKAGE: join(
        install,
        "versions",
        candidateVersion,
        "package.json",
      ),
      MIRACLE_SMOKE_NODE: newNode,
      MIRACLE_SMOKE_REQUESTS: join(project, "current-release-requests.jsonl"),
    };
    const protectedCurrent = await protectedState();
    for (const args of [["update", "--check"], ["update"]]) {
      const unchanged = await command(launcher, args, {
        extraEnv: currentUpdateEnv,
      });
      assert.match(unchanged.stdout, /already up to date/);
      assert.deepEqual(await protectedState(), protectedCurrent);
    }
    assert.deepEqual(
      (await readFile(currentUpdateEnv.MIRACLE_SMOKE_REQUESTS, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse),
      Array(2).fill(
        "https://api.github.com/repos/Manannikov-Nikita/miracle/releases/latest",
      ),
    );
    assert.equal((await session()).workspaceId, workspaceId);
    async function verifyStored(trusted = true) {
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
      const editors = await api("/api/editor-documents");
      assert.deepEqual(editors, [draft]);
      const profiles = await api("/api/agent-profiles");
      assert.equal(profiles.length, 1);
      assert.equal(profiles[0].id, profile.id);
      assert.equal(profiles[0].command, profile.command);
      assert.equal(profiles[0].trusted, trusted);
      assert.deepEqual(await api(`/api/chats/${chat.id}`), savedConversation);
      const legacyChat = (await api("/api/chats")).find(
        (item) => item.id === chat.id,
      );
      assert.equal(legacyChat.autoApprove, true);
      assert.equal(legacyChat.modelSettings, undefined);
      await execute(); // Proves the encrypted password/CA remain usable.
    }
    await verifyStored();
    const modelSettings = { model: "synthetic-model", reasoningEffort: "high" };
    const configuredChat = await api("/api/chats", {
      profileId: profile.id,
      title: "Chat with per-dialog model settings",
      modelSettings,
    });
    assert.deepEqual(configuredChat.modelSettings, modelSettings);
    const updatedChat = await api(
      `/api/chats/${configuredChat.id}`,
      {
        modelSettings: { ...modelSettings, reasoningEffort: "ultra" },
      },
      "PATCH",
    );
    assert.equal(updatedChat.modelSettings.reasoningEffort, "ultra");
    await run("stop", ...storageArgs);
    const after = await sqliteSnapshot(newNode);
    assert.equal(
      after.schema,
      7,
      "Update must migrate the workspace to schema 7",
    );
    for (const column of ["model_settings_json", "native_session_reset"])
      assert(
        after.chatColumns.includes(column),
        `Missing migrated chat column ${column}`,
      );
    const retainedChat = after.chats.find((item) => item.id === chat.id);
    assert.equal(retainedChat.native_session_id, "synthetic-upgrade-session");
    assert.equal(retainedChat.model_settings_json, null);
    assert.equal(retainedChat.native_session_reset, 0);
    assert.deepEqual(
      JSON.parse(
        after.chats.find((item) => item.id === configuredChat.id)
          .model_settings_json,
      ),
      updatedChat.modelSettings,
    );
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
      "agent_query_runs",
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
      await verifyStored(false);
      const restoredChats = await api("/api/chats");
      assert.equal(restoredChats.length, label === "new backup" ? 2 : 1);
      if (label === "new backup") {
        assert.deepEqual(
          restoredChats.find((item) => item.id === configuredChat.id)
            .modelSettings,
          updatedChat.modelSettings,
        );
      }
      await run("stop", "--project-dir", restored);
    }
    console.log(
      `PASS ${oldVersion} -> ${candidateVersion} (${storage}): CLI update, schema 6 -> 7, check-only, failed download, checksum rejection, current-version no-op, same PID/data on no-op/failure, preserved secrets/query/board/result/editor/profile/chat/history, model settings, old/new backup restore`,
    );
  }
  console.log(
    `PASS upgrade matrix: ${target}, ${oldVersion} -> ${candidateVersion} × project/custom storage, bundled Node only`,
  );
} finally {
  await transport.destroy();
  for (const stop of cleanup.reverse()) await stop().catch(() => {});
  for (const server of fixtures) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await rm(root, { recursive: true, force: true });
}
