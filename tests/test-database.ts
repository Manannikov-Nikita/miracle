import { setTimeout } from "node:timers/promises";
import type pg from "pg";

export async function dropTestDatabase(admin: pg.Pool, databaseName: string) {
  if (!/^miracle_(?:test|tls_test|setup)_\d+(?:_\d+)?$/.test(databaseName)) {
    throw new Error(`Refusing to drop non-test database: ${databaseName}`);
  }

  // pg-pool can resolve end() before its clients physically disconnect. Wait
  // for PostgreSQL to observe their exit instead of terminating closing clients.
  const deadline = Date.now() + 5000;
  while (true) {
    const result = await admin.query<{ connections: number }>(
      "SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname = $1",
      [databaseName],
    );
    if (result.rows[0]!.connections === 0) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for test database connections: ${databaseName}`,
      );
    }
    await setTimeout(20);
  }

  const identifier = `"${databaseName.replaceAll('"', '""')}"`;
  await admin.query(`DROP DATABASE IF EXISTS ${identifier}`);
}
