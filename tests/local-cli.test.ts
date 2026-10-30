import { afterEach, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { resolve, join } from "node:path";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
const loader = resolve("node_modules/tsx/dist/loader.mjs");
const source = resolve("src/server/cli.ts");
function cli(...args: string[]) {
  return execFileSync(process.execPath, ["--import", loader, source, ...args], {
    encoding: "utf8",
    cwd: tmpdir(),
  });
}
it("prints help without accessing or initializing a workspace", () => {
  expect(cli("--help")).toContain("backup DIRECTORY");
});
it("reports installed version without a service", () => {
  expect(cli("--version").trim()).toBe("0.2.0");
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
it("authenticates lifecycle, keeps private state, preserves data on restart, and refuses occupied ports", async () => {
  const root = mkdtempSync(join(tmpdir(), "miracle CLI Проверка "));
  const env = { ...process.env, MIRACLE_INSTALL_ROOT: root };
  async function run(args: string[], fail = false) {
    return await new Promise<string>((res, rej) => {
      const child = spawn(
        process.execPath,
        ["--import", loader, source, ...args],
        { env, cwd: tmpdir() },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (err += c));
      child.on("error", rej);
      child.on("close", (code) =>
        code && !fail ? rej(Error(err)) : res(out + err),
      );
    });
  }
  cleanup.push(async () => {
    await run(["stop"], true);
    rmSync(root, { recursive: true, force: true });
  });
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const occupied = (server.address() as { port: number }).port;
  expect(await run(["start", "--port", String(occupied)], true)).toMatch(
    /occupied|could not start/i,
  );
  await new Promise<void>((r) => server.close(() => r()));
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  await run(["start", "--port", String(port)]);
  const first = JSON.parse(await run(["status", "--json"]));
  expect(first.status).toBe("running");
  expect(JSON.parse(await run(["status", "--json"])).pid).toBe(first.pid);
  await run(["start"]);
  expect(JSON.parse(await run(["status", "--json"])).pid).toBe(first.pid);
  const files = readdirSync(join(root, "run"));
  expect(files).toHaveLength(1);
  const stateFile = join(root, "run", files[0]!);
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  if (process.platform !== "win32")
    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
  expect(await run(["status", "--json"])).not.toContain(state.token);
  const response = await fetch(`http://127.0.0.1:${port}/api/session`);
  const session = (await response.json()) as { workspaceId: string };
  expect(session.workspaceId).toBeTruthy();
  expect(await run(["backup", join(root, "backup")], true)).toMatch(/stop/i);
  await run(["stop"]);
  expect(JSON.parse(await run(["status", "--json"])).status).toBe("stopped");
  await run(["start", "--port", String(port)]);
  const again = await fetch(`http://127.0.0.1:${port}/api/session`);
  expect(((await again.json()) as { workspaceId: string }).workspaceId).toBe(
    session.workspaceId,
  );
  await run(["stop"]);
  // A forged PID never authorizes process signalling; the token must match the service.
  writeFileSync(
    stateFile,
    JSON.stringify({ ...state, pid: process.pid, token: "a".repeat(64) }),
  );
  await run(["stop"]);
  expect(process.pid).toBeGreaterThan(0);
}, 60000);
it("refuses startup while an installer holds the activation lock", async () => {
  const { mkdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "miracle install lock "));
  mkdirSync(join(root, ".install-lock"));
  const run = (args: string[]) =>
    new Promise<string>((res, rej) => {
      const child = spawn(
        process.execPath,
        ["--import", loader, source, ...args],
        { env: { ...process.env, MIRACLE_INSTALL_ROOT: root }, cwd: tmpdir() },
      );
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("error", rej);
      child.on("close", () => res(out));
    });
  try {
    expect(await run(["start"])).toMatch(/installation.*progress/i);
  } finally {
    await run(["stop"]);
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["delayed-stop", "unauthorized", "malformed"] as const)(
  "preserves runtime identity and fails visibly for %s control responses",
  async (mode) => {
    const { createServer: createHttpServer } = await import("node:http");
    const { createHash } = await import("node:crypto");
    const { mkdirSync } = await import("node:fs");
    const root = mkdtempSync(
      join(tmpdir(), "miracle uncertain control Проверка "),
    );
    const dataDir = join(root, "data");
    mkdirSync(join(root, "run"));
    let stopping = false;
    const server = createHttpServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (req.headers.authorization !== `Bearer ${"a".repeat(64)}`) {
        res.writeHead(401).end();
        return;
      }
      if (mode === "unauthorized") {
        res.writeHead(401).end();
        return;
      }
      if (mode === "malformed") {
        res.end("not JSON");
        return;
      }
      if (JSON.parse(body).action === "stop") stopping = true;
      else if (stopping) await new Promise((r) => setTimeout(r, 1200));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const stateFile = join(
      root,
      "run",
      createHash("sha256").update(dataDir).digest("hex") + ".json",
    );
    const original = JSON.stringify({
      token: "a".repeat(64),
      port,
      pid: process.pid,
      dataDir,
      version: "0.2.0",
    });
    writeFileSync(stateFile, original);
    async function run(args: string[]) {
      return await new Promise<{ code: number | null; out: string }>(
        (res, rej) => {
          const child = spawn(
            process.execPath,
            ["--import", loader, source, ...args],
            {
              env: { ...process.env, MIRACLE_INSTALL_ROOT: root },
              cwd: tmpdir(),
            },
          );
          let out = "";
          child.stdout.on("data", (c) => (out += c));
          child.stderr.on("data", (c) => (out += c));
          child.on("error", rej);
          child.on("close", (code) => res({ code, out }));
        },
      );
    }
    try {
      const result = await run(["stop"]);
      expect(result.code).not.toBe(0);
      expect(result.out).not.toMatch(/Miracle stopped\./);
      expect(readFileSync(stateFile, "utf8")).toBe(original);
      expect(server.listening).toBe(true);
      const status = await run(["status", "--json"]);
      expect(status.code).not.toBe(0);
      expect(JSON.parse(status.out).status).toBe("error");
      const start = await run(["start"]);
      expect(start.code).not.toBe(0);
      expect(readFileSync(stateFile, "utf8")).toBe(original);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
it("reports stopped only after the HTTP listener and SQLite lifetime lock both close", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { createServer: createHttpServer } = await import("node:http");
  const { createHash } = await import("node:crypto");
  const { mkdirSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "miracle draining lock Проверка "));
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  mkdirSync(join(root, "run"));
  const db = new DatabaseSync(join(dataDir, "miracle.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE marker(value); COMMIT",
  );
  let closed = false,
    release: ReturnType<typeof setTimeout> | undefined;
  const server = createHttpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    res.end(JSON.stringify({ ok: true }), () => {
      if (JSON.parse(body).action === "stop") {
        server.close();
        release = setTimeout(() => {
          db.close();
          closed = true;
        }, 900);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const stateFile = join(
    root,
    "run",
    createHash("sha256").update(dataDir).digest("hex") + ".json",
  );
  writeFileSync(
    stateFile,
    JSON.stringify({
      token: "a".repeat(64),
      port,
      pid: process.pid,
      dataDir,
      version: "0.2.0",
    }),
  );
  try {
    const result = await new Promise<{ code: number | null; out: string }>(
      (res, rej) => {
        const child = spawn(
          process.execPath,
          ["--import", loader, source, "stop"],
          {
            env: { ...process.env, MIRACLE_INSTALL_ROOT: root },
            cwd: tmpdir(),
          },
        );
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (out += c));
        child.on("error", rej);
        child.on("close", (code) => res({ code, out }));
      },
    );
    expect(result.code, result.out).toBe(0);
    expect(closed).toBe(true);
    expect(existsSync(stateFile)).toBe(false);
  } finally {
    if (release) clearTimeout(release);
    if (!closed) db.close();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
