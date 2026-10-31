import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database, migrate } from "../src/server/db.js";
import {
  backupWorkspace,
  restoreWorkspace,
} from "../src/server/maintenance.js";
import {
  loadKey,
  SecretBox,
  verifyEncryptionKey,
} from "../src/server/secrets.js";

const roots: string[] = [];
const databases: Database[] = [];
const makeRoot = () => {
  const path = mkdtempSync(join(tmpdir(), "miracle-batch-migration-"));
  roots.push(path);
  return path;
};
function open(path: string) {
  const db = new Database(path);
  databases.push(db);
  return db;
}
function version(db: Database) {
  return Number(db.sqlite.prepare("PRAGMA user_version").get()!.user_version);
}
function fresh(path: string) {
  const db = open(path);
  const box = new SecretBox(loadKey(path, true));
  migrate(db, () => verifyEncryptionKey(db, box, true));
  return db;
}
// Fixed version-one fixture: independent of the current migration output.
function legacy(path: string) {
  const db = open(path);
  db.sqlite.exec(`
    CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE connections(id TEXT PRIMARY KEY,name TEXT NOT NULL,engine TEXT NOT NULL,url TEXT NOT NULL,username TEXT NOT NULL,password_encrypted TEXT NOT NULL,database_name TEXT,catalog TEXT,schema_name TEXT,clickhouse_options_encrypted TEXT,created_at TEXT NOT NULL DEFAULT '2026-10-30T00:00:00.000Z');
    CREATE TABLE queries(id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL CHECK(json_valid(source)),revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL DEFAULT '2026-10-30T00:00:00.000Z');
    CREATE TABLE query_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,source TEXT NOT NULL CHECK(json_valid(source)),result_set_id TEXT,error TEXT,started_at TEXT NOT NULL DEFAULT '2026-10-30T00:00:00.000Z',finished_at TEXT,row_count INTEGER,elapsed_ms INTEGER);
    CREATE TABLE result_sets(id TEXT PRIMARY KEY,columns TEXT NOT NULL CHECK(json_valid(columns)),row_count INTEGER NOT NULL,byte_count INTEGER NOT NULL,source TEXT NOT NULL CHECK(json_valid(source)),created_at TEXT NOT NULL DEFAULT '2026-10-30T00:00:00.000Z');
    CREATE TABLE result_chunks(result_set_id TEXT NOT NULL REFERENCES result_sets(id) ON DELETE CASCADE,chunk_index INTEGER NOT NULL,rows TEXT NOT NULL CHECK(json_valid(rows)),PRIMARY KEY(result_set_id,chunk_index));
    CREATE TABLE boards(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,document TEXT NOT NULL CHECK(json_valid(document)),updated_at TEXT NOT NULL DEFAULT '2026-10-30T00:00:00.000Z');
    CREATE TABLE board_result_refs(board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,result_set_id TEXT NOT NULL REFERENCES result_sets(id) ON DELETE RESTRICT,PRIMARY KEY(board_id,result_set_id));
    CREATE INDEX runs_status ON query_runs(status); CREATE INDEX runs_started ON query_runs(started_at); CREATE INDEX refs_result ON board_result_refs(result_set_id);
    INSERT INTO app_settings(key,value) VALUES('workspace_id','existing-workspace');
    INSERT INTO query_runs(id,status,source,result_set_id,row_count) VALUES('old-run','completed','{"connectionId":"old-connection","sql":"select 1"}','old-result',1);
    INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES('old-result','[{"id":"c0","name":"value","type":"String"}]',1,7,'{"connectionId":"old-connection","sql":"select 1"}');
    INSERT INTO result_chunks(result_set_id,chunk_index,rows) VALUES('old-result',0,'[["keep"]]');
    PRAGMA user_version=1;
  `);
  const box = new SecretBox(loadKey(path, true));
  verifyEncryptionKey(db, box, true);
  db.query(
    "INSERT INTO connections(id,name,engine,url,username,password_encrypted) VALUES('old-connection','Keep','clickhouse','http://127.0.0.1','reader',?1)",
    [box.encrypt("saved-secret")],
  );
  return db;
}
function legacyTwo(path: string) {
  const db = legacy(path);
  db.sqlite.exec(
    "ALTER TABLE query_runs ADD COLUMN batch TEXT CHECK(batch IS NULL OR json_valid(batch)); PRAGMA user_version=2;",
  );
  return db;
}
function legacyThree(path: string) {
  const db = legacyTwo(path);
  db.sqlite.exec(
    "ALTER TABLE connections ADD COLUMN trino_options_encrypted TEXT; PRAGMA user_version=3;",
  );
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const progress = {
  total: 2,
  completed: 1,
  succeeded: 1,
  failed: 0,
  attempt: 1,
  items: [
    { date: "2026-10-01", status: "completed", attempts: 1, rowCount: 1 },
  ],
};

describe("date batch storage migration", () => {
  it.each([1, 2, 3])(
    "upgrades version %i without changing rows, identity or key",
    (schemaVersion) => {
      const path = makeRoot();
      const db =
        schemaVersion === 1
          ? legacy(path)
          : schemaVersion === 2
            ? legacyTwo(path)
            : legacyThree(path);
      const key = readFileSync(join(path, "encryption.key"));
      const credential = db.query("SELECT password_encrypted FROM connections")
        .rows[0].password_encrypted;
      migrate(db);
      expect(version(db)).toBe(4);
      expect(
        db.query("SELECT trino_options_encrypted FROM connections").rows[0]
          .trino_options_encrypted,
      ).toBeNull();
      expect(
        db.query("SELECT value FROM app_settings WHERE key='workspace_id'")
          .rows[0].value,
      ).toBe("existing-workspace");
      expect(db.query("SELECT rows FROM result_chunks").rows[0].rows).toEqual([
        ["keep"],
      ]);
      expect(
        db.query("SELECT batch FROM query_runs WHERE id='old-run'").rows[0]
          .batch,
      ).toBeNull();
      expect(
        db.query("SELECT password_encrypted FROM connections").rows[0]
          .password_encrypted,
      ).toBe(credential);
      expect(readFileSync(join(path, "encryption.key"))).toEqual(key);
      db.query("UPDATE query_runs SET batch=?1 WHERE id='old-run'", [progress]);
      migrate(db);
      expect(
        db.query("SELECT batch FROM query_runs WHERE id='old-run'").rows[0]
          .batch,
      ).toEqual(progress);
      expect(() =>
        db.query("UPDATE query_runs SET batch='broken' WHERE id='old-run'"),
      ).toThrow();
    },
  );
  it("initializes the new schema and encryption sentinel atomically", () => {
    const path = makeRoot();
    const db = fresh(path);
    expect(version(db)).toBe(4);
    expect(
      db.query("SELECT value FROM app_settings WHERE key='workspace_id'")
        .rows[0].value,
    ).toMatch(/^[0-9a-f-]{36}$/);
    expect(() =>
      verifyEncryptionKey(db, new SecretBox(loadKey(path, false))),
    ).not.toThrow();
    db.query(
      "INSERT INTO query_runs(id,status,source,batch) VALUES('new','running','{}',?1)",
      [progress],
    );
    expect(
      db.query("SELECT batch FROM query_runs WHERE id='new'").rows[0].batch,
    ).toEqual(progress);
    const failed = open(join(path, "failed"));
    expect(() =>
      migrate(failed, () => {
        throw new Error("sentinel failed");
      }),
    ).toThrow("sentinel failed");
    expect(version(failed)).toBe(0);
    expect(
      failed.query(
        "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
      ).rows,
    ).toEqual([]);
  });
  it("rolls back the whole version-one upgrade if adding connection TLS storage fails", () => {
    const db = legacy(makeRoot());
    db.sqlite.exec(
      "ALTER TABLE connections ADD COLUMN trino_options_encrypted TEXT;",
    );
    expect(() => migrate(db)).toThrow(/duplicate column/);
    expect(version(db)).toBe(1);
    expect(
      db.query(
        "SELECT name FROM pragma_table_info('query_runs') WHERE name='batch'",
      ).rows,
    ).toEqual([]);
    expect(db.query("SELECT rows FROM result_chunks").rows[0].rows).toEqual([
      ["keep"],
    ]);
  });
  it("refuses a future workspace without lowering its schema version", () => {
    const db = fresh(makeRoot());
    db.sqlite.exec("PRAGMA user_version=5");
    expect(() => migrate(db)).toThrow(/newer/);
    expect(version(db)).toBe(5);
  });
});

describe("versioned workspace backups", () => {
  it.each([1, 2, 3, 4])(
    "preserves version %i on backup/restore, then permits upgrading old backups",
    async (schemaVersion) => {
      const root = makeRoot();
      const path = join(root, "data");
      const db =
        schemaVersion === 1
          ? legacy(path)
          : schemaVersion === 2
            ? legacyTwo(path)
            : schemaVersion === 3
              ? legacyThree(path)
              : fresh(path);
      if (schemaVersion >= 2)
        db.query(
          "INSERT INTO query_runs(id,status,source,batch) VALUES('batch','interrupted','{}',?1)",
          [progress],
        );
      const identity = db.query(
        "SELECT value FROM app_settings WHERE key='workspace_id'",
      ).rows[0].value;
      const key = readFileSync(join(path, "encryption.key"));
      db.close();
      const backup = join(root, "backup");
      await backupWorkspace(path, backup);
      expect(
        JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"))
          .schemaVersion,
      ).toBe(schemaVersion);
      const restored = join(root, "restored");
      await restoreWorkspace(backup, restored);
      const copy = open(restored);
      expect(version(copy)).toBe(schemaVersion);
      expect(
        copy.query("SELECT value FROM app_settings WHERE key='workspace_id'")
          .rows[0].value,
      ).toBe(identity);
      expect(readFileSync(join(restored, "encryption.key"))).toEqual(key);
      migrate(copy);
      expect(version(copy)).toBe(4);
      expect(
        copy.query(
          "SELECT name FROM pragma_table_info('connections') WHERE name='trino_options_encrypted'",
        ).rows,
      ).toHaveLength(1);
      if (schemaVersion === 1)
        expect(
          copy.query("SELECT rows FROM result_chunks").rows[0].rows,
        ).toEqual([["keep"]]);
      else
        expect(
          copy.query("SELECT batch FROM query_runs WHERE id='batch'").rows[0]
            .batch,
        ).toEqual(progress);
    },
  );
  it("rejects a supported manifest version that differs from the actual database", async () => {
    const root = makeRoot();
    const path = join(root, "data");
    const db = legacy(path);
    db.close();
    const backup = join(root, "backup");
    await backupWorkspace(path, backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaVersion = 2;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const restored = join(root, "restored");
    await expect(restoreWorkspace(backup, restored)).rejects.toThrow(
      /schema version.*match/i,
    );
    expect(existsSync(restored)).toBe(false);
  });
  it("rejects future schema manifests and cannot produce a future-version backup", async () => {
    const root = makeRoot();
    const path = join(root, "data");
    const db = legacy(path);
    db.close();
    const backup = join(root, "backup");
    await backupWorkspace(path, backup);
    const manifestPath = join(backup, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaVersion = 5;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(
      restoreWorkspace(backup, join(root, "restored")),
    ).rejects.toThrow(/Unsupported backup/);
    const future = open(path);
    future.sqlite.exec("PRAGMA user_version=5");
    future.close();
    await expect(backupWorkspace(path, join(root, "future"))).rejects.toThrow(
      /Unsupported workspace/,
    );
    expect(existsSync(join(root, "future"))).toBe(false);
  });
});

it("preserves revisioned editor documents, encrypted profiles and agent conversation through backup/restore", async () => {
  const root = makeRoot(),
    path = join(root, "project/.miracle");
  const db = fresh(path);
  const box = new SecretBox(loadKey(path, false));
  const document = {
    name: "investigation.sql",
    sql: "select 42",
    connectionId: "source",
  };
  db.query(
    "INSERT INTO editor_documents(id,document,revision,updated_at) VALUES('editor',?1,7,'2026-10-31T00:00:00.000Z')",
    [document],
  );
  db.query(
    "INSERT INTO agent_profiles VALUES('profile','Local Codex','codex',?1,'2026-10-31T00:00:00.000Z')",
    [box.encrypt("codex --model local-model")],
  );
  db.query(
    "INSERT INTO agent_chats VALUES('chat','Investigation','profile','codex','native-session','2026-10-31T00:00:00.000Z','2026-10-31T00:00:00.000Z')",
  );
  db.query(
    "INSERT INTO agent_turns VALUES('turn','chat','request','completed',?1,NULL,'2026-10-31T00:00:00.000Z','2026-10-31T00:00:01.000Z')",
    [JSON.stringify({ editorDocumentId: "editor" })],
  );
  db.query(
    "INSERT INTO agent_messages VALUES('message','chat','turn','assistant','Result retained',NULL,'2026-10-31T00:00:01.000Z')",
  );
  db.close();
  await backupWorkspace(path, join(root, "backup"));
  await restoreWorkspace(join(root, "backup"), join(root, "moved/.miracle"));
  const copy = open(join(root, "moved/.miracle"));
  migrate(copy);
  expect(
    copy.query(
      "SELECT document,revision FROM editor_documents WHERE id='editor'",
    ).rows[0],
  ).toEqual({ document, revision: 7 });
  const command = copy.query(
    "SELECT command_encrypted FROM agent_profiles WHERE id='profile'",
  ).rows[0].command_encrypted;
  expect(command).not.toContain("local-model");
  expect(
    new SecretBox(loadKey(join(root, "moved/.miracle"), false)).decrypt(
      command,
    ),
  ).toBe("codex --model local-model");
  expect(
    copy.query(
      "SELECT provider,native_session_id FROM agent_chats WHERE id='chat'",
    ).rows[0],
  ).toEqual({ provider: "codex", native_session_id: "native-session" });
  expect(
    copy.query("SELECT status,context_json FROM agent_turns WHERE id='turn'")
      .rows[0],
  ).toEqual({
    status: "completed",
    context_json: '{"editorDocumentId":"editor"}',
  });
  expect(
    copy.query("SELECT role,content FROM agent_messages WHERE chat_id='chat'")
      .rows,
  ).toEqual([{ role: "assistant", content: "Result retained" }]);
});
