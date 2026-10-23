import { expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseConfig } from "../src/server/config.js";
it("keeps DATABASE_URL compatibility and reads mounted database passwords without URL interpolation", () => {
  expect(
    databaseConfig({
      DATABASE_URL: "postgres://existing/db",
      DATABASE_PASSWORD_FILE: "/does/not/exist",
    }),
  ).toEqual({ connectionString: "postgres://existing/db" });
  const dir = mkdtempSync(join(tmpdir(), "miracle-db-config-"));
  try {
    const file = join(dir, "password");
    writeFileSync(file, "reserved:@/?#password\n");
    expect(databaseConfig({ DATABASE_PASSWORD_FILE: file })).toEqual({
      host: "postgres",
      port: 5432,
      database: "miracle",
      user: "miracle",
      password: "reserved:@/?#password",
    });
    expect(
      databaseConfig({
        DATABASE_PASSWORD_FILE: file,
        DATABASE_HOST: "custom",
        DATABASE_PORT: "5433",
        DATABASE_NAME: "data",
        DATABASE_USER: "app",
      }),
    ).toMatchObject({
      host: "custom",
      port: 5433,
      database: "data",
      user: "app",
    });
    expect(() =>
      databaseConfig({ DATABASE_PASSWORD_FILE: file, DATABASE_PORT: "abc" }),
    ).toThrow("Invalid DATABASE_PORT");
    writeFileSync(file, "");
    expect(() => databaseConfig({ DATABASE_PASSWORD_FILE: file })).toThrow(
      /empty/,
    );
    expect(() =>
      databaseConfig({ DATABASE_PASSWORD_FILE: join(dir, "missing") }),
    ).toThrow(/restore the original password file/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
