import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;
const source = resolve("src/server/cli.ts");
const roots: string[] = [];
const shutdowns: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of shutdowns.splice(0)) await stop();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "miracle projects Проверка ")),
  );
  roots.push(root);
  const projectA = join(root, "project a"),
    projectB = join(root, "project b"),
    install = join(root, "installation");
  mkdirSync(projectA);
  mkdirSync(projectB);
  async function run(
    cwd: string,
    args: string[],
    overrides: NodeJS.ProcessEnv = {},
  ) {
    return new Promise<{ code: number | null; out: string }>((done, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", loader, source, ...args],
        {
          cwd,
          env: {
            ...process.env,
            PORT: "",
            MIRACLE_DATA_DIR: "",
            APP_ORIGIN: "",
            MIRACLE_INSTALL_ROOT: install,
            ...overrides,
          },
        },
      );
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.stderr.on("data", (c) => (out += c));
      child.on("error", reject);
      child.on("close", (code) => done({ code, out }));
    });
  }
  shutdowns.push(
    () => run(projectA, ["stop"]),
    () => run(projectB, ["stop"]),
  );
  return { root, projectA, projectB, install, run };
}
it("runs two canonical cwd projects independently and reuses symlink aliases with isolated ports", async () => {
  const f = fixture();
  const alias = join(f.root, "alias");
  symlinkSync(f.projectA, alias, "dir");
  const first = await f.run(f.projectA, ["start"]);
  expect(first.code, first.out).toBe(0);
  const a = JSON.parse((await f.run(alias, ["status", "--json"])).out);
  expect(a.projectRoot).toBe(realpathSync(f.projectA));
  expect(a.dataDir).toBe(join(realpathSync(f.projectA), ".miracle"));
  expect(a.port).toBeGreaterThan(0);
  expect(existsSync(join(f.projectA, ".miracle/miracle.sqlite"))).toBe(true);
  expect(existsSync(join(f.install, "data"))).toBe(false);
  expect((await f.run(alias, ["start"])).code).toBe(0);
  expect(
    JSON.parse((await f.run(f.projectA, ["status", "--json"])).out).pid,
  ).toBe(a.pid);
  const second = await f.run(f.root, ["start", "--project-dir", f.projectB]);
  expect(second.code, second.out).toBe(0);
  const b = JSON.parse((await f.run(f.projectB, ["status", "--json"])).out);
  expect(b.port).not.toBe(a.port);
  expect((await fetch(a.url + "/api/session")).status).toBe(200);
  expect((await fetch(b.url + "/api/session")).status).toBe(200);
  const states = readdirSync(join(f.install, "run"));
  expect(states).toHaveLength(2);
  for (const state of states)
    expect(statSync(join(f.install, "run", state)).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(f.install, "logs"))).toHaveLength(2);
  await f.run(f.projectA, ["stop"]);
  expect(
    JSON.parse((await f.run(f.projectB, ["status", "--json"])).out).pid,
  ).toBe(b.pid);
}, 30000);
it("treats data-dir only as storage and rejects another project claiming the same active storage", async () => {
  const f = fixture();
  const data = join(f.root, "external storage");
  shutdowns.push(() => f.run(f.projectA, ["stop", "--data-dir", data]));
  const started = await f.run(f.projectA, ["start", "--data-dir", data]);
  expect(started.code, started.out).toBe(0);
  const status = JSON.parse(
    (await f.run(f.projectA, ["status", "--json"], { MIRACLE_DATA_DIR: data }))
      .out,
  );
  expect(status.projectRoot).toBe(realpathSync(f.projectA));
  expect(status.dataDir).toBe(data);
  const foreignStatus = JSON.parse(
    (await f.run(f.projectB, ["status", "--json", "--data-dir", data])).out,
  );
  expect(foreignStatus.projectRoot).toBe(realpathSync(f.projectA));
  const conflict = await f.run(f.projectB, ["start", "--data-dir", data]);
  expect(conflict.code).not.toBe(0);
  expect(conflict.out).toMatch(/another project|different project/i);
  const alias = join(f.root, "storage alias");
  symlinkSync(data, alias, "dir");
  expect((await f.run(f.projectA, ["start", "--data-dir", alias])).code).toBe(
    0,
  );
}, 30000);
it("backs up and restores only the selected stopped project", async () => {
  const f = fixture();
  const backup = join(f.root, "backup");
  expect((await f.run(f.projectA, ["start"])).code).toBe(0);
  const a = JSON.parse((await f.run(f.projectA, ["status", "--json"])).out);
  const original = (await (await fetch(a.url + "/api/session")).json()) as {
    workspaceId: string;
  };
  await f.run(f.projectA, ["stop"]);
  const copied = await f.run(f.root, [
    "backup",
    backup,
    "--project-dir",
    f.projectA,
  ]);
  expect(copied.code, copied.out).toBe(0);
  const restored = await f.run(f.projectB, ["restore", backup]);
  expect(restored.code, restored.out).toBe(0);
  expect((await f.run(f.projectB, ["start"])).code).toBe(0);
  const b = JSON.parse((await f.run(f.projectB, ["status", "--json"])).out);
  expect(
    (
      (await (await fetch(b.url + "/api/session")).json()) as {
        workspaceId: string;
      }
    ).workspaceId,
  ).toBe(original.workspaceId);
}, 30000);
it("rejects explicit environment port changes while reusing the running project", async () => {
  const f = fixture();
  expect((await f.run(f.projectA, ["start"])).code).toBe(0);
  const a = JSON.parse((await f.run(f.projectA, ["status", "--json"])).out);
  const different = a.port === 65535 ? 65534 : a.port + 1;
  const changed = await f.run(f.projectA, ["start"], {
    PORT: String(different),
  });
  expect(changed.code).not.toBe(0);
  expect(changed.out).toMatch(/already running on port/);
  const invalid = await f.run(f.projectA, ["start", "--port", "0"]);
  expect(invalid.code).not.toBe(0);
  expect(invalid.out).toMatch(/Invalid PORT/);
  expect(
    JSON.parse((await f.run(f.projectA, ["status", "--json"])).out).pid,
  ).toBe(a.pid);
}, 30000);
it("preserves APP_ORIGIN for the direct development server behind Vite", async () => {
  const { createServer } = await import("node:net");
  const f = fixture();
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const child = spawn(
    process.execPath,
    ["--import", loader, resolve("src/server/index.ts")],
    {
      cwd: f.projectA,
      env: {
        ...process.env,
        PORT: String(port),
        APP_ORIGIN: "http://127.0.0.1:5178",
        MIRACLE_RUNTIME_PORT: "",
        MIRACLE_DATA_DIR: join(f.projectA, ".miracle"),
        MIRACLE_INSTALL_ROOT: f.install,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(
        () => reject(Error("Direct server did not start")),
        5000,
      );
      child.once("message", () => {
        clearTimeout(timer);
        done();
      });
      child.once("error", reject);
    });
    const { request } = await import("node:http");
    const status = await new Promise<number | undefined>((done, reject) => {
      const req = request(
        `http://127.0.0.1:${port}/api/session`,
        {
          headers: { host: "127.0.0.1:5178", origin: "http://127.0.0.1:5178" },
        },
        (response) => {
          response.resume();
          response.once("end", () => done(response.statusCode));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/session`)).status).toBe(
      403,
    );
  } finally {
    child.kill("SIGTERM");
    child.disconnect();
    await exited;
  }
}, 10000);
it("allows one server per canonical project even when storage overrides differ", async () => {
  const f = fixture();
  const custom = join(f.root, "custom state"),
    other = join(f.root, "other state");
  shutdowns.push(
    () => f.run(f.projectA, ["stop", "--data-dir", custom]),
    () => f.run(f.projectA, ["stop", "--data-dir", other]),
  );
  const started = await f.run(f.projectA, ["start", "--data-dir", custom]);
  expect(started.code, started.out).toBe(0);
  const initial = JSON.parse(
    (await f.run(f.projectA, ["status", "--json", "--data-dir", custom])).out,
  );
  const alias = join(f.root, "same project alias");
  symlinkSync(f.projectA, alias, "dir");
  for (const args of [
    ["start"],
    ["start", "--data-dir", other],
    ["status", "--json"],
    ["stop"],
  ]) {
    const result = await f.run(alias, args);
    expect(result.code, result.out).not.toBe(0);
    expect(result.out).toMatch(
      /already running.*different.*data|already running.*storage/i,
    );
    expect(result.out).toContain(custom);
  }
  expect(existsSync(join(f.projectA, ".miracle"))).toBe(false);
  expect(existsSync(other)).toBe(false);
  expect((await f.run(f.projectA, ["start", "--data-dir", custom])).code).toBe(
    0,
  );
  expect(
    JSON.parse(
      (await f.run(f.projectA, ["status", "--json", "--data-dir", custom])).out,
    ).pid,
  ).toBe(initial.pid);
  await f.run(f.projectA, ["stop", "--data-dir", custom]);
  const switched = await f.run(f.projectA, ["start"]);
  expect(switched.code, switched.out).toBe(0);
}, 30000);
it("serializes concurrent default/custom storage launches to one project server", async () => {
  const f = fixture();
  const custom = join(f.root, "concurrent state");
  shutdowns.push(() => f.run(f.projectA, ["stop", "--data-dir", custom]));
  const candidates = [["start"], ["start", "--data-dir", custom]];
  const launched = await Promise.all(
    candidates.map((args) => f.run(f.projectA, args)),
  );
  expect(launched.filter((r) => r.code === 0)).toHaveLength(1);
  const loser = launched.findIndex((r) => r.code !== 0);
  const retried = await f.run(f.projectA, candidates[loser]!);
  expect(retried.code, retried.out).not.toBe(0);
  expect(retried.out).toMatch(
    /already running.*different.*data|already running.*storage/i,
  );
  expect(
    readdirSync(join(f.install, "run")).filter((name) =>
      name.endsWith(".json"),
    ),
  ).toHaveLength(1);
}, 30000);
