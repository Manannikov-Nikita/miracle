import { readFileSync } from "node:fs";
import type { PoolConfig } from "pg";

/** Resolve either the existing URL or the local distribution's mounted password. */
export function databaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  if (env.DATABASE_PASSWORD_FILE) {
    let password: string;
    try {
      password = readFileSync(env.DATABASE_PASSWORD_FILE, "utf8").trim();
    } catch {
      throw new Error(
        "Cannot read DATABASE_PASSWORD_FILE; restore the original password file and permissions",
      );
    }
    if (!password) throw new Error("DATABASE_PASSWORD_FILE must not be empty");
    const port = Number(env.DATABASE_PORT || 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid DATABASE_PORT");
    return {
      host: env.DATABASE_HOST || "postgres",
      port,
      database: env.DATABASE_NAME || "miracle",
      user: env.DATABASE_USER || "miracle",
      password,
    };
  }
  return {
    connectionString: "postgres://miracle:miracle_local@127.0.0.1:5544/miracle",
  };
}
