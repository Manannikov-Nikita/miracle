import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Database, migrate } from "../src/server/db";
import { SecretBox } from "../src/server/secrets";
import { ProjectStore } from "../src/server/project-store";
import { WorkspaceOperations } from "../src/server/workspace-operations";

let directory: string;
let db: Database;
let store: ProjectStore;
let operations: WorkspaceOperations;
let connectionId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "miracle-query-editor-sync-"));
  db = new Database(directory);
  migrate(db, () => {});
  connectionId = randomUUID();
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    projectRoot: directory,
    dataDir: directory,
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
  operations = new WorkspaceOperations(store, async () => {});
});
afterEach(() => {
  store.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("propagates saved-query edits into clean linked editors and publishes their new revisions once", async () => {
  const source = {
    connectionId,
    sql: "select 1",
    database: "old_database",
    catalog: "old_catalog",
    schema: "old_schema",
    dateRange: {
      retries: 0,
      granularity: "day",
      endDate: "2026-10-02",
      startDate: "2026-10-01",
    },
  };
  const query = await operations.saveQuery({
    ...source,
    name: "Original query",
  });
  const editor = store.createEditor({
    ...source,
    name: query.name,
    queryId: query.id,
    queryRevision: query.revision,
  });
  const renamed = store.createEditor({
    ...source,
    name: "My independent title",
    queryId: query.id,
    queryRevision: query.revision,
  });
  const cursor = store.since(0).at(-1)!.id;
  const edit = {
    name: "Agent query",
    connectionId,
    sql: "select 42",
    baseRevision: query.revision,
    mutationId: randomUUID(),
  };
  const saved = await operations.saveQuery(edit, query.id);
  const updated = store.editor(editor.id);
  expect(updated).toMatchObject({
    name: "Agent query",
    sql: "select 42",
    queryRevision: saved.revision,
    revision: editor.revision + 1,
  });
  for (const field of ["database", "catalog", "schema", "dateRange"])
    expect(updated[field as keyof typeof updated]).toBeUndefined();
  expect(store.editor(renamed.id)).toMatchObject({
    name: "My independent title",
    sql: "select 42",
    queryRevision: saved.revision,
  });
  const events = store.since(cursor);
  expect(
    events
      .filter((event) => event.type === "editor.updated")
      .map((event) => event.entityId)
      .sort(),
  ).toEqual([editor.id, renamed.id].sort());
  expect(
    events.filter((event) => event.type === "queries.changed"),
  ).toHaveLength(1);
  await expect(operations.saveQuery(edit, query.id)).resolves.toEqual(saved);
  expect(store.since(cursor)).toEqual(events);
  expect(store.editor(editor.id).revision).toBe(updated.revision);
});

it("preserves divergent or stale linked drafts while updating another clean editor", async () => {
  const query = await operations.saveQuery({
    name: "Query",
    sql: "select 1",
    connectionId,
  });
  const linked = {
    name: query.name,
    sql: query.sql,
    connectionId,
    queryId: query.id,
    queryRevision: query.revision,
  };
  const clean = store.createEditor(linked);
  const changedSql = store.createEditor({ ...linked, sql: "select my_draft" });
  const changedSource = store.createEditor({
    ...linked,
    database: "my_database",
  });
  const stale = store.createEditor({ ...linked, queryRevision: 0 });
  const before = [changedSql, changedSource, stale];
  await operations.saveQuery(
    {
      name: "Updated",
      sql: "select 42",
      connectionId,
      baseRevision: query.revision,
      mutationId: randomUUID(),
    },
    query.id,
  );
  expect(store.editor(clean.id).sql).toBe("select 42");
  for (const editor of before) expect(store.editor(editor.id)).toEqual(editor);
});

it.each(
  (["database", "catalog", "schema"] as const).flatMap((field) =>
    [true, false].map((queryHasDefault) => ({ field, queryHasDefault })),
  ),
)(
  "compares effective $field context with queryHasDefault=$queryHasDefault while preserving explicit differences",
  async ({ field, queryHasDefault }) => {
    db.query(
      "INSERT INTO connections(id,name,engine,url,username,password_encrypted,database_name,catalog,schema_name) VALUES(?1,'Source','trino','http://localhost','reader','','default_database','default_catalog','default_schema')",
      [connectionId],
    );
    const defaults = {
      database: "default_database",
      catalog: "default_catalog",
      schema: "default_schema",
    };
    const query = await operations.saveQuery({
      name: "Query",
      sql: "select 1",
      connectionId,
      ...(queryHasDefault ? { [field]: defaults[field] } : {}),
    });
    const linked = {
      name: query.name,
      sql: query.sql,
      connectionId,
      queryId: query.id,
      queryRevision: query.revision,
    };
    const clean = store.createEditor({
      ...linked,
      ...(queryHasDefault ? {} : { [field]: defaults[field] }),
    });
    const empty = store.createEditor({ ...linked, [field]: "" });
    const different = store.createEditor({
      ...linked,
      [field]: "private_context",
    });
    const saved = await operations.saveQuery(
      {
        name: query.name,
        sql: "select 42",
        connectionId,
        [field]: "agent_context",
        baseRevision: query.revision,
      },
      query.id,
    );
    expect(store.editor(clean.id)).toMatchObject({
      sql: saved.sql,
      queryRevision: saved.revision,
      revision: clean.revision + 1,
      [field]: "agent_context",
    });
    expect(store.editor(empty.id)).toEqual(empty);
    expect(store.editor(different.id)).toEqual(different);
  },
);

it("does not rebase an inherited editor when connection defaults diverge from its saved query", async () => {
  db.query(
    "INSERT INTO connections(id,name,engine,url,username,password_encrypted,database_name) VALUES(?1,'Source','clickhouse','http://localhost','reader','','original_database')",
    [connectionId],
  );
  const query = await operations.saveQuery({
    name: "Query",
    sql: "select 1",
    connectionId,
    database: "original_database",
  });
  const editor = store.createEditor({
    name: query.name,
    sql: query.sql,
    connectionId,
    queryId: query.id,
    queryRevision: query.revision,
  });
  db.query("UPDATE connections SET database_name='changed_default' WHERE id=?1", [
    connectionId,
  ]);
  await operations.saveQuery(
    { ...query, sql: "select 42", baseRevision: query.revision },
    query.id,
  );
  expect(store.editor(editor.id)).toEqual(editor);
});

it("rolls back the query and events if linked-editor propagation fails and permits the same command to retry", async () => {
  const query = await operations.saveQuery({
    name: "Query",
    sql: "select 1",
    connectionId,
  });
  const editor = store.createEditor({
    name: query.name,
    sql: query.sql,
    connectionId,
    queryId: query.id,
    queryRevision: query.revision,
  });
  const cursor = store.since(0).at(-1)!.id;
  db.sqlite.exec(
    "CREATE TRIGGER fail_editor_update BEFORE UPDATE ON editor_documents BEGIN SELECT RAISE(ABORT, 'test write failure'); END;",
  );
  const edit = {
    name: "Updated",
    sql: "select 42",
    connectionId,
    baseRevision: query.revision,
    mutationId: randomUUID(),
  };
  await expect(operations.saveQuery(edit, query.id)).rejects.toThrow(
    "test write failure",
  );
  expect(operations.query(query.id)).toEqual(query);
  expect(store.editor(editor.id)).toEqual(editor);
  expect(store.since(cursor)).toEqual([]);
  db.sqlite.exec("DROP TRIGGER fail_editor_update");
  await operations.saveQuery(edit, query.id);
  expect(operations.query(query.id)).toMatchObject({
    revision: 2,
    sql: "select 42",
  });
  expect(store.editor(editor.id)).toMatchObject({
    revision: 2,
    queryRevision: 2,
    sql: "select 42",
  });
});
