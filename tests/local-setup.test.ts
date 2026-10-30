import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildApp } from "../src/server/app.js";
const roots: string[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
it("refuses a second server before interrupting runs, then recovers after close", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "miracle-exclusive-"));
  roots.push(dataDir);
  const options = { dataDir, serveStatic: false };
  let app = await buildApp(options);
  apps.push(app);
  app.miracle.db.query(
    "INSERT INTO query_runs(id,status,source) VALUES('active','running','{}')",
  );
  await expect(buildApp(options)).rejects.toThrow(/already running/);
  expect(
    app.miracle.db.query("SELECT status FROM query_runs WHERE id='active'")
      .rows[0].status,
  ).toBe("running");
  await app.close();
  app = await buildApp(options);
  apps.push(app);
  expect(
    app.miracle.db.query("SELECT status FROM query_runs WHERE id='active'")
      .rows[0].status,
  ).toBe("interrupted");
  const tables = app.miracle.db
    .query("SELECT name FROM sqlite_schema WHERE type='table'")
    .rows.map((r) => r.name);
  expect(tables).not.toContain("users");
  expect(tables).not.toContain("sessions");
});
