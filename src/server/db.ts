import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const timestamp = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const jsonFields = new Set(["source", "document", "columns", "rows"]);
/** One prepared-statement connection owns the workspace until close. */
export class Database {
  readonly sqlite: DatabaseSync;
  readonly path: string;
  private closed = false;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, "miracle.sqlite");
    this.sqlite = new DatabaseSync(this.path);
    try {
      this.sqlite.exec(
        "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;",
      );
      this.sqlite.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
      );
      // In WAL mode, retaining this exclusive connection also retains the WAL lock.
      this.sqlite.exec("BEGIN EXCLUSIVE; COMMIT;");
      chmodSync(this.path, 0o600);
    } catch (error) {
      this.sqlite.close();
      if ((error as Error).message.includes("locked"))
        throw new Error(
          "A Miracle server is already running for this workspace; stop it first",
          { cause: error },
        );
      throw error;
    }
  }
  query(
    sql: string,
    parameters: unknown[] = [],
  ): { rows: any[]; rowCount: number } {
    const statement = this.sqlite.prepare(sql);
    const values = parameters.map((value): SQLInputValue =>
      value === undefined || value === null
        ? null
        : typeof value === "object" && !(value instanceof Uint8Array)
          ? JSON.stringify(value)
          : typeof value === "boolean"
            ? Number(value)
            : (value as SQLInputValue),
    );
    // SQLite numbered parameters are named bindings, with explicit ?1… numbering.
    const bindings = Object.fromEntries(
      values.map((value, index) => [String(index + 1), value]),
    );
    if (statement.columns().length) {
      const rows = statement.all(bindings).map((row) => {
        const decoded: Record<string, unknown> = { ...row };
        for (const field of jsonFields)
          if (typeof decoded[field] === "string")
            decoded[field] = JSON.parse(decoded[field] as string);
        return decoded;
      });
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: Number(statement.run(bindings).changes) };
  }
  transaction<T>(fn: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.sqlite.close();
    }
  }
}
export function migrate(db: Database, initialize?: () => void) {
  const version = Number(
    db.sqlite.prepare("PRAGMA user_version").get()!.user_version,
  );
  if (version > 1)
    throw new Error("Workspace schema is newer than this version of Miracle");
  if (version === 1) return;
  if (!initialize)
    throw new Error("Incomplete workspace schema; restore a complete backup");
  db.transaction(() => {
    db.sqlite.exec(`
 CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE connections(id TEXT PRIMARY KEY,name TEXT NOT NULL,engine TEXT NOT NULL,url TEXT NOT NULL,username TEXT NOT NULL,password_encrypted TEXT NOT NULL,database_name TEXT,catalog TEXT,schema_name TEXT,clickhouse_options_encrypted TEXT,created_at TEXT NOT NULL DEFAULT ${timestamp});
 CREATE TABLE queries(id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL CHECK(json_valid(source)),revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL DEFAULT ${timestamp});
 CREATE TABLE query_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,source TEXT NOT NULL CHECK(json_valid(source)),result_set_id TEXT,error TEXT,started_at TEXT NOT NULL DEFAULT ${timestamp},finished_at TEXT,row_count INTEGER,elapsed_ms INTEGER);
 CREATE TABLE result_sets(id TEXT PRIMARY KEY,columns TEXT NOT NULL CHECK(json_valid(columns)),row_count INTEGER NOT NULL,byte_count INTEGER NOT NULL,source TEXT NOT NULL CHECK(json_valid(source)),created_at TEXT NOT NULL DEFAULT ${timestamp});
 CREATE TABLE result_chunks(result_set_id TEXT NOT NULL REFERENCES result_sets(id) ON DELETE CASCADE,chunk_index INTEGER NOT NULL,rows TEXT NOT NULL CHECK(json_valid(rows)),PRIMARY KEY(result_set_id,chunk_index));
 CREATE TABLE boards(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,document TEXT NOT NULL CHECK(json_valid(document)),updated_at TEXT NOT NULL DEFAULT ${timestamp});
 CREATE TABLE board_result_refs(board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,result_set_id TEXT NOT NULL REFERENCES result_sets(id) ON DELETE RESTRICT,PRIMARY KEY(board_id,result_set_id));
 CREATE INDEX runs_status ON query_runs(status); CREATE INDEX runs_started ON query_runs(started_at); CREATE INDEX refs_result ON board_result_refs(result_set_id);
 PRAGMA user_version=1;
 `);
    db.query("INSERT INTO app_settings(key,value) VALUES('workspace_id',?1)", [
      randomUUID(),
    ]);
    initialize();
  });
}
export function retention(db: Database) {
  db.transaction(() => {
    db.query(
      "DELETE FROM result_sets WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours') AND NOT EXISTS (SELECT 1 FROM board_result_refs b WHERE b.result_set_id=result_sets.id) AND NOT EXISTS (SELECT 1 FROM query_runs q WHERE q.result_set_id=result_sets.id AND q.status IN ('running','cancelling'))",
    );
    db.query(
      "DELETE FROM query_runs WHERE started_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') AND status NOT IN ('running','cancelling')",
    );
  });
}
