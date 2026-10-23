import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Database } from "./db.js";
export class SecretBox {
  constructor(private key: Buffer) {
    if (key.length !== 32)
      throw new Error(
        "ENCRYPTION_KEY must contain exactly 32 bytes (base64 or hex)",
      );
  }
  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  decrypt(value: string): string {
    const b = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([
      cipher.update(b.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }
}
export function loadKey(): Buffer {
  const value = process.env.ENCRYPTION_KEY_FILE
    ? readFileSync(process.env.ENCRYPTION_KEY_FILE, "utf8").trim()
    : process.env.ENCRYPTION_KEY;
  if (!value)
    throw new Error("ENCRYPTION_KEY or ENCRYPTION_KEY_FILE is required");
  return Buffer.from(value, /^[a-f\d]{64}$/i.test(value) ? "hex" : "base64");
}

/** Authenticate the key before exposing the workspace or accepting new secrets. */
export async function verifyEncryptionKey(db: Database, box: SecretBox) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(67432917)");
    const saved = (
      await c.query(
        "SELECT value FROM app_settings WHERE key='encryption_key_check'",
      )
    ).rows[0];
    try {
      if (saved) {
        if (box.decrypt(saved.value) !== "miracle-encryption-key-v1")
          throw new Error("Unexpected sentinel");
      } else {
        // An upgraded database may contain credentials before sentinel support.
        const legacy = await c.query(
          "SELECT password_encrypted,clickhouse_options_encrypted FROM connections",
        );
        for (const row of legacy.rows)
          for (const value of [
            row.password_encrypted,
            row.clickhouse_options_encrypted,
          ])
            if (value) box.decrypt(value);
        await c.query(
          "INSERT INTO app_settings(key,value) VALUES('encryption_key_check',$1)",
          [box.encrypt("miracle-encryption-key-v1")],
        );
      }
    } catch {
      throw new Error(
        "Encryption key does not match the saved workspace. Restore the original ENCRYPTION_KEY or ENCRYPTION_KEY_FILE together with its database backup; do not generate a replacement key.",
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
