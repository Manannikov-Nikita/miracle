import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "./db.js";
import { DatabaseSync } from "node:sqlite";
import { loadKey, SecretBox, verifyEncryptionKey } from "./secrets.js";
const names = ["miracle.sqlite", "encryption.key"] as const;
const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function emptyTarget(path: string) {
  if (
    existsSync(path) &&
    (!lstatSync(path).isDirectory() || readdirSync(path).length)
  )
    throw new Error(
      "Destination must be absent or an empty directory; refusing a nonempty destination",
    );
}
function assertWorkspace(dataDir: string) {
  for (const name of names) {
    const path = join(dataDir, name);
    if (!existsSync(path) || !lstatSync(path).isFile())
      throw new Error(`Workspace is missing ${name}`);
  }
}
function validate(db: Database, dataDir: string) {
  const version = Number(
    db.sqlite.prepare("PRAGMA user_version").get()!.user_version,
  );
  if (version !== 1) throw new Error("Unsupported workspace schema");
  const checks = db.sqlite.prepare("PRAGMA integrity_check").all();
  if (
    checks.length !== 1 ||
    checks[0].integrity_check !== "ok" ||
    db.sqlite.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Workspace database is corrupt");
  if (
    !db.query("SELECT value FROM app_settings WHERE key='encryption_key_check'")
      .rowCount
  )
    throw new Error("Workspace encryption key check is missing");
  verifyEncryptionKey(db, new SecretBox(loadKey(dataDir, false)));
}
function staging(target: string) {
  mkdirSync(dirname(target), { recursive: true });
  return mkdtempSync(join(dirname(target), ".miracle-stage-"));
}
function activate(stage: string, target: string) {
  emptyTarget(target);
  if (existsSync(target)) rmdirSync(target);
  renameSync(stage, target);
}
/** SQLite itself refuses active-workspace backup before any maintenance write. */
function openStoppedWorkspace(dataDir: string): DatabaseSync {
  // WAL locking needs access to its coordination files even when no pages change.
  // No data/schema or journal-mode statement is executed.
  const db = new DatabaseSync(join(dataDir, "miracle.sqlite"));
  try {
    db.exec(
      "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;",
    );
    return db;
  } catch (error) {
    db.close();
    if ((error as Error).message.includes("locked"))
      throw new Error(
        "A Miracle server is already running for this workspace; stop it first",
        { cause: error },
      );
    throw error;
  }
}
/** Probe SQLite ownership without migrations, key creation or recovery writes. */
export function assertWorkspaceStopped(dataDir: string): void {
  if (!existsSync(join(dataDir, "miracle.sqlite"))) return;
  openStoppedWorkspace(dataDir).close();
}
export async function backupWorkspace(
  dataDir: string,
  destination: string,
): Promise<void> {
  dataDir = resolve(dataDir);
  destination = resolve(destination);
  emptyTarget(destination);
  assertWorkspace(dataDir);
  const db = new Database(dataDir);
  let stage: string | undefined;
  try {
    validate(db, dataDir);
    stage = staging(destination);
    db.sqlite.prepare("VACUUM INTO ?").run(join(stage, "miracle.sqlite"));
    chmodSync(join(stage, "miracle.sqlite"), 0o600);
    copyFileSync(
      join(dataDir, "encryption.key"),
      join(stage, "encryption.key"),
    );
    chmodSync(join(stage, "encryption.key"), 0o600);
    writeFileSync(
      join(stage, "manifest.json"),
      JSON.stringify(
        {
          format: "miracle-workspace",
          version: 1,
          schemaVersion: 1,
          files: Object.fromEntries(
            names.map((name) => [name, digest(join(stage!, name))]),
          ),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    activate(stage, destination);
    stage = undefined;
  } finally {
    db.close();
    if (stage) rmSync(stage, { recursive: true, force: true });
  }
}
export async function restoreWorkspace(
  source: string,
  dataDir: string,
): Promise<void> {
  source = resolve(source);
  dataDir = resolve(dataDir);
  emptyTarget(dataDir);
  assertWorkspace(source);
  const manifest = JSON.parse(
    readFileSync(join(source, "manifest.json"), "utf8"),
  );
  if (
    manifest.format !== "miracle-workspace" ||
    manifest.version !== 1 ||
    manifest.schemaVersion !== 1
  )
    throw new Error("Unsupported backup manifest");
  const sourceDb = openStoppedWorkspace(source);
  let stage: string;
  try {
    stage = staging(dataDir);
  } catch (error) {
    sourceDb.close();
    throw error;
  }

  let db: Database | undefined;
  let activated = false;
  try {
    for (const name of names) {
      copyFileSync(join(source, name), join(stage, name));
      chmodSync(join(stage, name), 0o600);
    }
    for (const name of names)
      if (digest(join(stage, name)) !== manifest.files?.[name])
        throw new Error(`Backup checksum mismatch: ${name}`);
    db = new Database(stage);
    validate(db, stage);
    db.close();
    db = undefined;
    // Closing SQLite checkpoints and removes its WAL; only the paired files persist.
    activate(stage, dataDir);
    activated = true;
  } finally {
    db?.close();
    sourceDb.close();
    if (!activated) rmSync(stage, { recursive: true, force: true });
  }
}
