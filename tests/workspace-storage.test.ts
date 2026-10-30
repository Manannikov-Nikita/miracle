import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { buildApp } from "../src/server/app.js";
import {
  backupWorkspace,
  restoreWorkspace,
} from "../src/server/maintenance.js";
const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const children: ChildProcess[] = [];
const root = () => {
  const r = mkdtempSync(join(tmpdir(), "miracle-store-"));
  roots.push(r);
  return r;
};
afterEach(async () => {
  for (const p of children.splice(0))
    if (p.exitCode === null && p.signalCode === null) {
      p.kill("SIGKILL");
      await once(p, "exit");
    }
  for (const a of apps.splice(0)) await a.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("holds exclusive process ownership before recovery and releases on abrupt exit", async () => {
  const dataDir = join(root(), "data");
  const source = `import {buildApp} from './src/server/app.ts'; const app=await buildApp({dataDir:process.argv[1],serveStatic:false});app.miracle.db.query("INSERT INTO query_runs(id,status,source) VALUES('active','running',?1)",[{connectionId:'x',sql:'select 1'}]);console.log('READY');setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source, dataDir],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (d) => {
      if (String(d).includes("READY")) resolve();
    });
    child.on("exit", () => reject(new Error(stderr)));
  });
  await expect(buildApp({ dataDir, serveStatic: false })).rejects.toThrow(
    /already running/,
  );
  // The owner can still read its original running row after a contender fails.
  child.kill("SIGKILL");
  await once(child, "exit");
  const app = await buildApp({ dataDir, serveStatic: false });
  apps.push(app);
  expect(
    app.miracle.db.query("SELECT status FROM query_runs WHERE id='active'")
      .rows[0].status,
  ).toBe("interrupted");
}, 10000);
it("backs up and restores paired SQLite data and key, refusing active, nonempty and corrupt workspaces", async () => {
  const r = root(),
    dataDir = join(r, "data"),
    backup = join(r, "backup"),
    restored = join(r, "restored");
  const app = await buildApp({ dataDir, serveStatic: false });
  apps.push(app);
  const id = app.miracle.db.query(
    "SELECT value FROM app_settings WHERE key='workspace_id'",
  ).rows[0].value;
  await expect(backupWorkspace(dataDir, backup)).rejects.toThrow(
    /already running/,
  );
  await app.close();
  await backupWorkspace(dataDir, backup);
  expect(readFileSync(join(backup, "encryption.key"), "utf8")).toBe(
    readFileSync(join(dataDir, "encryption.key"), "utf8"),
  );
  await restoreWorkspace(backup, restored);
  const reopened = await buildApp({ dataDir: restored, serveStatic: false });
  apps.push(reopened);
  expect(
    reopened.miracle.db.query(
      "SELECT value FROM app_settings WHERE key='workspace_id'",
    ).rows[0].value,
  ).toBe(id);
  await expect(restoreWorkspace(backup, restored)).rejects.toThrow(/nonempty/);
  const bad = join(r, "bad");
  mkdirSync(bad);
  writeFileSync(join(bad, "keep"), "safe");
  await expect(restoreWorkspace(backup, bad)).rejects.toThrow(/nonempty/);
  expect(readFileSync(join(bad, "keep"), "utf8")).toBe("safe");
  writeFileSync(
    join(backup, "encryption.key"),
    Buffer.alloc(32, 1).toString("base64"),
  );
  const manifest = JSON.parse(
    readFileSync(join(backup, "manifest.json"), "utf8"),
  );
  manifest.files["encryption.key"] = createHash("sha256")
    .update(readFileSync(join(backup, "encryption.key")))
    .digest("hex");
  writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest));
  const target = join(r, "corrupt");
  await expect(restoreWorkspace(backup, target)).rejects.toThrow(/key.*match/i);
  expect(existsSync(target)).toBe(false);
});
it("restores into an existing empty directory without removing unrelated files", async () => {
  const r = root(),
    dataDir = join(r, "data"),
    backup = join(r, "backup"),
    target = join(r, "empty");
  const app = await buildApp({ dataDir, serveStatic: false });
  apps.push(app);
  await app.close();
  await backupWorkspace(dataDir, backup);
  mkdirSync(target);
  await restoreWorkspace(backup, target);
  expect(existsSync(join(target, "miracle.sqlite"))).toBe(true);
});
it("refuses restoring from a backup directory currently opened by a server", async () => {
  const r = root(),
    dataDir = join(r, "data"),
    backup = join(r, "backup");
  const app = await buildApp({ dataDir, serveStatic: false });
  apps.push(app);
  await app.close();
  await backupWorkspace(dataDir, backup);
  const live = await buildApp({ dataDir: backup, serveStatic: false });
  apps.push(live);
  await expect(restoreWorkspace(backup, join(r, "target"))).rejects.toThrow(
    /already running/,
  );
});
it.each([
  "before-key",
  "after-key",
  "after-schema",
  "after-uuid",
  "after-sentinel",
])(
  "recovers a genuinely empty initializer killed %s without blessing partial established data",
  async (boundary) => {
    const dataDir = join(root(), "data");
    const source = `
 import {Database} from './src/server/db.ts';import {loadKey} from './src/server/secrets.ts';import {DatabaseSync} from 'node:sqlite';import {writeSync} from 'node:fs';import {buildApp} from './src/server/app.ts';
 const dataDir=process.argv[1],boundary=process.argv[2];const block=()=>{writeSync(1,'BOUNDARY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
 if(boundary==='before-key'){new Database(dataDir);block();}
 if(boundary==='after-key'){new Database(dataDir);loadKey(dataDir,true);block();}
 const originalExec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const result=originalExec.call(this,sql);if(boundary==='after-schema'&&sql.includes('CREATE TABLE app_settings'))block();return result;};
 const originalQuery=Database.prototype.query;Database.prototype.query=function(sql,params){const result=originalQuery.call(this,sql,params);if(boundary==='after-uuid'&&sql.includes('INSERT INTO app_settings')&&sql.includes('workspace_id'))block();if(boundary==='after-sentinel'&&sql.includes('INSERT INTO app_settings')&&sql.includes('encryption_key_check'))block();return result;};
 await buildApp({dataDir,serveStatic:false});throw new Error('Initialization boundary was not reached');`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        source,
        dataDir,
        boundary,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", (d) => {
        if (String(d).includes("BOUNDARY")) resolve();
      });
      child.on("exit", () => reject(new Error(stderr)));
    });
    child.kill("SIGKILL");
    await once(child, "exit");
    const keyPath = join(dataDir, "encryption.key");
    const key = existsSync(keyPath) ? readFileSync(keyPath, "utf8") : undefined;
    const recovered = await buildApp({ dataDir, serveStatic: false });
    apps.push(recovered);
    expect(
      recovered.miracle.db
        .query("SELECT key FROM app_settings ORDER BY key")
        .rows.map((row) => row.key),
    ).toEqual(["encryption_key_check", "workspace_id"]);
    if (key) expect(readFileSync(keyPath, "utf8")).toBe(key);
  },
  10000,
);
it("recovers an interrupted temporary key write only while SQLite has no tables", async () => {
  const dataDir = join(root(), "data");
  const { Database } = await import("../src/server/db.js");
  const db = new Database(dataDir);
  db.close();
  writeFileSync(join(dataDir, ".encryption.key.pending"), "partial");
  const app = await buildApp({ dataDir, serveStatic: false });
  apps.push(app);
  expect(
    readFileSync(join(dataDir, "encryption.key"), "utf8").trim(),
  ).toHaveLength(44);
  expect(existsSync(join(dataDir, ".encryption.key.pending"))).toBe(false);
});
it("refuses an existing nonempty version-zero database without initializing over its data", async () => {
  const dataDir = join(root(), "data");
  const { Database } = await import("../src/server/db.js");
  const db = new Database(dataDir);
  db.sqlite.exec(
    "CREATE TABLE valuable(value TEXT); INSERT INTO valuable VALUES('keep');",
  );
  writeFileSync(
    join(dataDir, "encryption.key"),
    Buffer.alloc(32, 3).toString("base64"),
  );
  db.close();
  await expect(buildApp({ dataDir, serveStatic: false })).rejects.toThrow(
    /Incomplete workspace/,
  );
  const untouched = new Database(dataDir);
  try {
    expect(untouched.query("SELECT value FROM valuable").rows).toEqual([
      { value: "keep" },
    ]);
    expect(
      untouched.sqlite.prepare("PRAGMA user_version").get()!.user_version,
    ).toBe(0);
  } finally {
    untouched.close();
  }
});
it("never promotes a pending key for an established workspace with a missing final key", async () => {
  const dataDir = join(root(), "data");
  const app = await buildApp({ dataDir, serveStatic: false });
  apps.push(app);
  await app.close();
  const key = readFileSync(join(dataDir, "encryption.key"));
  writeFileSync(join(dataDir, ".encryption.key.pending"), key);
  const { unlinkSync } = await import("node:fs");
  unlinkSync(join(dataDir, "encryption.key"));
  await expect(buildApp({ dataDir, serveStatic: false })).rejects.toThrow(
    /key is missing/,
  );
  expect(readFileSync(join(dataDir, ".encryption.key.pending"))).toEqual(key);
  expect(existsSync(join(dataDir, "encryption.key"))).toBe(false);
});
it("checks stopped ownership without recovery, key changes, database mutation or creating a missing workspace", async () => {
  const { assertWorkspaceStopped } =
    await import("../src/server/maintenance.js");
  const r = root(),
    dataDir = join(r, "data"),
    missing = join(r, "missing");
  expect(() => assertWorkspaceStopped(missing)).not.toThrow();
  expect(existsSync(missing)).toBe(false);
  const app = await buildApp({ dataDir, serveStatic: false });
  apps.push(app);
  app.miracle.db.query(
    "INSERT INTO query_runs(id,status,source) VALUES('probe','running','{}')",
  );
  expect(() => assertWorkspaceStopped(dataDir)).toThrow(/already running/);
  await app.close();
  const before = readFileSync(join(dataDir, "miracle.sqlite")),
    key = readFileSync(join(dataDir, "encryption.key"));
  expect(() => assertWorkspaceStopped(dataDir)).not.toThrow();
  expect(readFileSync(join(dataDir, "miracle.sqlite"))).toEqual(before);
  expect(readFileSync(join(dataDir, "encryption.key"))).toEqual(key);
  const { Database } = await import("../src/server/db.js");
  const db = new Database(dataDir);
  try {
    expect(
      db.query("SELECT status FROM query_runs WHERE id='probe'").rows[0].status,
    ).toBe("running");
  } finally {
    db.close();
  }
});
