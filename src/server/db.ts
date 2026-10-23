import pg from "pg";
import { hash } from "@node-rs/argon2";
import { randomUUID, randomBytes, createHash } from "node:crypto";
export const { Pool } = pg;
export type Database = pg.Pool;
export async function migrate(db: Database) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(67432912)");
    await c.query(`
CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','editor','viewer')), password_hash text, disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sessions (id text PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE CASCADE, csrf text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS app_settings (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE IF NOT EXISTS setup_tokens (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), token_hash text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS account_tokens (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS connections (id uuid PRIMARY KEY, name text NOT NULL, engine text NOT NULL, url text NOT NULL, username text NOT NULL, password_encrypted text NOT NULL, database_name text, catalog text, schema_name text, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE connections ADD COLUMN IF NOT EXISTS clickhouse_options_encrypted text;
CREATE TABLE IF NOT EXISTS queries (id uuid PRIMARY KEY, name text NOT NULL, source jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS query_runs (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), status text NOT NULL, source jsonb NOT NULL, result_set_id uuid, error text, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, row_count integer, elapsed_ms integer);
CREATE TABLE IF NOT EXISTS result_sets (id uuid PRIMARY KEY, columns jsonb NOT NULL, row_count integer NOT NULL, byte_count bigint NOT NULL, source jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS result_chunks (result_set_id uuid NOT NULL REFERENCES result_sets(id) ON DELETE CASCADE, chunk_index integer NOT NULL, rows jsonb NOT NULL, PRIMARY KEY(result_set_id,chunk_index));
CREATE TABLE IF NOT EXISTS boards (id uuid PRIMARY KEY, name text NOT NULL, revision integer NOT NULL DEFAULT 1, document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS board_result_refs (board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE, result_set_id uuid NOT NULL REFERENCES result_sets(id) ON DELETE RESTRICT, PRIMARY KEY(board_id,result_set_id));
CREATE INDEX IF NOT EXISTS runs_user_status ON query_runs(user_id,status);
CREATE INDEX IF NOT EXISTS runs_started ON query_runs(started_at);
CREATE INDEX IF NOT EXISTS refs_result ON board_result_refs(result_set_id);
`);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export function validatePassword(password: string) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 256
  )
    throw new Error("Пароль должен содержать от 12 до 256 символов");
}
export async function bootstrapAdmin(
  db: Database,
  email: string,
  name: string,
  password: string,
) {
  validatePassword(password);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Invalid email");
  const passwordHash = await hash(password);
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(67432913)");
    const n = await c.query("SELECT id FROM users LIMIT 1");
    if (n.rowCount)
      throw new Error("Bootstrap refused: workspace already has users");
    const id = randomUUID();
    await c.query(
      "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,'admin',$4)",
      [id, email.trim().toLowerCase(), name, passwordHash],
    );
    await c.query("DELETE FROM setup_tokens");
    await c.query("COMMIT");
    return id;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
const setupError = (statusCode: number, message: string, code?: string) =>
  Object.assign(new Error(message), { statusCode, code });
const setupDigest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export async function setupRequired(db: Database): Promise<boolean> {
  return !(await db.query("SELECT id FROM users LIMIT 1")).rowCount;
}
/** Only the hash persists; a fresh invocation rotates the previous capability. */
export async function issueSetupToken(db: Database): Promise<string | null> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(67432913)");
    if ((await c.query("SELECT id FROM users LIMIT 1")).rowCount) {
      await c.query("DELETE FROM setup_tokens");
      await c.query("COMMIT");
      return null;
    }
    const token = randomBytes(32).toString("base64url");
    await c.query(
      "INSERT INTO setup_tokens(singleton,token_hash,expires_at) VALUES(true,$1,now()+interval '30 minutes') ON CONFLICT(singleton) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at",
      [setupDigest(token)],
    );
    await c.query("COMMIT");
    return token;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function completeSetup(
  db: Database,
  input: { token: string; email: string; name: string; password: string },
) {
  validatePassword(input.password);
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    // Shared with bootstrap-admin and admin-role changes: exactly one first user wins.
    await c.query("SELECT pg_advisory_xact_lock(67432913)");
    if ((await c.query("SELECT id FROM users LIMIT 1")).rowCount)
      throw setupError(409, "Настройка уже завершена. Войдите в аккаунт");
    const token = await c.query(
      "SELECT token_hash FROM setup_tokens WHERE token_hash=$1 AND expires_at>clock_timestamp() FOR UPDATE",
      [setupDigest(input.token)],
    );
    if (!token.rowCount)
      throw setupError(
        400,
        "Ссылка настройки недействительна или истекла. Получите новую ссылку",
        "SETUP_TOKEN_INVALID",
      );
    // Untrusted/expired tokens never reach the costly password hash.
    const passwordHash = await hash(input.password);
    const user = (
      await c.query(
        "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,'admin',$4) RETURNING *",
        [
          randomUUID(),
          input.email.trim().toLowerCase(),
          input.name,
          passwordHash,
        ],
      )
    ).rows[0];
    await c.query("DELETE FROM setup_tokens");
    await c.query("COMMIT");
    return user;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function retention(db: Database) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(67432914)");
    await c.query(
      "DELETE FROM result_sets r WHERE created_at < now()-interval '24 hours' AND NOT EXISTS (SELECT 1 FROM board_result_refs b WHERE b.result_set_id=r.id) AND NOT EXISTS (SELECT 1 FROM query_runs q WHERE q.result_set_id=r.id AND q.status IN ('running','cancelling'))",
    );
    await c.query(
      "DELETE FROM query_runs WHERE started_at < now()-interval '30 days' AND status NOT IN ('running','cancelling')",
    );
    await c.query("DELETE FROM sessions WHERE expires_at<now()");
    await c.query("DELETE FROM account_tokens WHERE expires_at<now()");
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
