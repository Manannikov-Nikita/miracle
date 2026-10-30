import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import type { Database } from "./db.js";
export class SecretBox {
  constructor(private key: Buffer) {
    if (key.length !== 32)
      throw new Error("Workspace encryption key must contain exactly 32 bytes");
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
export function loadKey(
  dataDir: string,
  isNew: boolean,
  supplied?: Buffer,
): Buffer {
  const path = join(dataDir, "encryption.key");
  if (!existsSync(path)) {
    if (!isNew)
      throw new Error(
        "Workspace encryption key is missing; restore the original encryption.key together with its database",
      );
    const pending = join(dataDir, ".encryption.key.pending");
    if (
      existsSync(pending) &&
      Buffer.from(readFileSync(pending, "utf8").trim(), "base64").length !== 32
    )
      rmSync(pending);
    if (!existsSync(pending))
      writeFileSync(pending, (supplied || randomBytes(32)).toString("base64"), {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
    // Never expose a partially written final key. Only an empty schema may recover
    // this temporary file after process death, before its SQLite commit exists.
    renameSync(pending, path);
  }
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("Invalid workspace encryption key");
  if (supplied && !supplied.equals(key))
    throw new Error(
      "Encryption key does not match the saved workspace. Restore the original encryption.key with its database backup.",
    );
  return key;
}
/** Authenticate the saved key before recovery or accepting new credentials. */
export function verifyEncryptionKey(
  db: Database,
  box: SecretBox,
  initialize = false,
) {
  const saved = db.query(
    "SELECT value FROM app_settings WHERE key='encryption_key_check'",
  ).rows[0];
  if (saved) {
    try {
      if (box.decrypt(saved.value) !== "miracle-encryption-key-v1")
        throw new Error("sentinel");
    } catch {
      throw new Error(
        "Encryption key does not match the saved workspace. Restore the original encryption.key with its database backup.",
      );
    }
  } else {
    if (!initialize)
      throw new Error(
        "Workspace encryption key check is missing; restore a complete backup",
      );
    db.query(
      "INSERT INTO app_settings(key,value) VALUES('encryption_key_check',?1)",
      [box.encrypt("miracle-encryption-key-v1")],
    );
  }
}
