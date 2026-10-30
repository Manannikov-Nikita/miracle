import type { SchemaTable, SqlFunctionCatalog } from "../shared/types";
import type {
  MetadataColumn,
  MetadataPage,
  MetadataSchema,
} from "../shared/metadata";

type Status = "idle" | "loading" | "ready" | "error";
type Priority = "foreground" | "background";
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
type Context = { catalog?: string; schema?: string; database?: string };
export interface SchemaMetadata extends MetadataSchema {
  tables: SchemaTable[];
  status: Status;
  error?: string;
  complete: boolean;
  nextCursor?: string;
  columnsComplete: boolean;
  columnsError?: string;
}
export interface MetadataSnapshot {
  schemas: SchemaMetadata[];
  status: Status;
  error?: string;
  background: boolean;
  complete: boolean;
}
export const metadataSchemaKey = (scope: MetadataSchema) =>
  JSON.stringify([scope.catalog || "", scope.schema]);
export const metadataTableKey = (table: SchemaTable) =>
  JSON.stringify([table.catalog || "", table.schema, table.name]);
const emptySnapshot = (): MetadataSnapshot => ({
  schemas: [],
  status: "idle",
  background: false,
  complete: false,
});
const EMPTY = emptySnapshot();
interface Scope {
  discovered: boolean;
  scope: MetadataSchema;
  tables: Map<string, SchemaTable>;
  status: Status;
  started: boolean;
  complete: boolean;
  nextCursor?: string;
  error?: string;
  columnsComplete: boolean;
  columnCursor?: string;
  columnsError?: string;
  columns: Map<string, Map<string, MetadataColumn>>;
  loadedColumns: Set<string>;
  columnErrors: Map<string, string>;
  lookedUp: Set<string>;
}
interface Entry {
  id: string;
  controller: AbortController;
  scopes: Map<string, Scope>;
  status: Status;
  schemasStarted: boolean;
  schemasComplete: boolean;
  schemaCursor?: string;
  error?: string;
  warm: boolean;
  context: Context;
  jobs: Map<string, Job>;
  snapshot: MetadataSnapshot;
  functions?: SqlFunctionCatalog;
}
interface Job {
  entry: Entry;
  key: string;
  priority: Priority;
  started: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  run: () => Promise<void>;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** One store belongs to one workspace. It outlives both Explorer and editor mounts. */
export function createMetadataStore(request: Request) {
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  const queue: Job[] = [];
  let active = 0;
  let activeBackground = 0;
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined;

  function entryFor(id: string): Entry {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id,
        controller: new AbortController(),
        scopes: new Map(),
        status: "idle",
        schemasStarted: false,
        schemasComplete: false,
        warm: false,
        context: {},
        jobs: new Map(),
        snapshot: emptySnapshot(),
      };
      entries.set(id, entry);
    }
    return entry;
  }
  const current = (entry: Entry) =>
    entries.get(entry.id) === entry && !entry.controller.signal.aborted;
  function scopeFor(entry: Entry, scope: MetadataSchema): Scope {
    const key = metadataSchemaKey(scope);
    let value = entry.scopes.get(key);
    if (!value) {
      value = {
        discovered: false,
        scope: {
          schema: scope.schema,
          ...(scope.catalog ? { catalog: scope.catalog } : {}),
        },
        tables: new Map(),
        status: "idle",
        started: false,
        complete: false,
        columnsComplete: false,
        columns: new Map(),
        loadedColumns: new Set(),
        columnErrors: new Map(),
        lookedUp: new Set(),
      };
      entry.scopes.set(key, value);
    }
    return value;
  }
  function publish(entry: Entry) {
    if (!current(entry)) return;
    const schemas = [...entry.scopes.values()]
      .filter((s) => s.discovered)
      .map((s) => ({
        ...s.scope,
        tables: [...s.tables.values()],
        status: s.status,
        error: s.error,
        complete: s.complete,
        nextCursor: s.nextCursor,
        columnsComplete: s.columnsComplete,
        columnsError: s.columnsError,
      }));
    entry.snapshot = {
      schemas,
      status: entry.status,
      error: entry.error,
      background: entry.jobs.size > 0,
      complete:
        entry.schemasComplete &&
        schemas.every((s) => s.complete && s.columnsComplete),
    };
    for (const listener of listeners.get(entry.id) || []) listener();
  }
  function backgroundSoon() {
    if (
      backgroundTimer ||
      activeBackground ||
      !queue.some((j) => j.priority === "background")
    )
      return;
    backgroundTimer = setTimeout(() => {
      backgroundTimer = undefined;
      drain(true);
    }, 100);
  }
  function drain(allowBackground = false) {
    while (active < 3) {
      let index = queue.findIndex((j) => j.priority === "foreground");
      if (index < 0 && allowBackground && activeBackground === 0)
        index = queue.findIndex((j) => j.priority === "background");
      if (index < 0) break;
      const job = queue.splice(index, 1)[0];
      if (!current(job.entry)) {
        job.reject(new DOMException("Aborted", "AbortError"));
        continue;
      }
      job.started = true;
      active++;
      const background = job.priority === "background";
      if (background) activeBackground++;
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          if (background) activeBackground--;
          if (job.entry.jobs.get(job.key) === job)
            job.entry.jobs.delete(job.key);
          if (current(job.entry)) {
            scan(job.entry);
            publish(job.entry);
          }
          drain();
        });
    }
    backgroundSoon();
  }
  function schedule(
    entry: Entry,
    key: string,
    priority: Priority,
    run: () => Promise<void>,
  ) {
    const existing = entry.jobs.get(key);
    if (existing) {
      if (priority === "foreground" && !existing.started) {
        existing.priority = priority;
        drain();
      }
      return existing.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    // Background failures are reported in the snapshot; callers may still await/retry.
    promise.catch(() => {});
    const job: Job = {
      entry,
      key,
      priority,
      run,
      promise,
      resolve,
      reject,
      started: false,
    };
    entry.jobs.set(key, job);
    queue.push(job);
    publish(entry);
    drain();
    return promise;
  }
  function path(
    entry: Entry,
    kind: string,
    scope?: MetadataSchema,
    extra: Record<string, string | undefined> = {},
  ) {
    const query = new URLSearchParams();
    if (scope) {
      query.set("schema", scope.schema);
      if (scope.catalog) query.set("catalog", scope.catalog);
    }
    for (const [key, value] of Object.entries(extra))
      if (value !== undefined) query.set(key, value);
    return `/api/connections/${encodeURIComponent(entry.id)}/metadata/${kind}${query.size ? `?${query}` : ""}`;
  }
  async function page<T>(
    entry: Entry,
    url: string,
    previous?: string,
  ): Promise<MetadataPage<T>> {
    const value = await request<MetadataPage<T>>(url, {
      signal: entry.controller.signal,
    });
    entry.controller.signal.throwIfAborted();
    if (value.nextCursor !== undefined && value.nextCursor === previous)
      throw new Error("Сервер повторил страницу метаданных");
    return value;
  }
  function schemasPage(entry: Entry, priority: Priority) {
    if (entry.schemasComplete) return Promise.resolve();
    const cursor = entry.schemaCursor;
    entry.status = "loading";
    entry.error = undefined;
    return schedule(entry, `schemas:${cursor || ""}`, priority, async () => {
      try {
        const result = await page<MetadataSchema>(
          entry,
          path(entry, "schemas", undefined, { cursor }),
          cursor,
        );
        if (!current(entry)) return;
        for (const scope of result.items)
          scopeFor(entry, scope).discovered = true;
        entry.schemasStarted = true;
        entry.schemaCursor = result.nextCursor;
        entry.schemasComplete = result.nextCursor === undefined;
        entry.status = "ready";
      } catch (error) {
        if (current(entry)) {
          entry.status = "error";
          entry.error = message(error);
        }
        throw error;
      } finally {
        publish(entry);
      }
    });
  }
  function tablesPage(entry: Entry, scope: Scope, priority: Priority) {
    if (scope.complete) return Promise.resolve();
    const cursor = scope.nextCursor;
    scope.status = "loading";
    scope.error = undefined;
    return schedule(
      entry,
      `tables:${metadataSchemaKey(scope.scope)}:${cursor || ""}`,
      priority,
      async () => {
        try {
          const result = await page<SchemaTable>(
            entry,
            path(entry, "tables", scope.scope, { cursor }),
            cursor,
          );
          if (!current(entry)) return;
          if (result.items.length) scope.discovered = true;
          for (const table of result.items) {
            const existing = scope.tables.get(table.name);
            scope.tables.set(table.name, {
              ...table,
              ...(existing?.columns ? { columns: existing.columns } : {}),
            });
          }
          scope.started = true;
          scope.nextCursor = result.nextCursor;
          scope.complete = result.nextCursor === undefined;
          scope.status = "ready";
        } catch (error) {
          if (current(entry)) {
            scope.status = "error";
            scope.error = message(error);
          }
          throw error;
        } finally {
          publish(entry);
        }
      },
    );
  }
  function mergeColumns(scope: Scope, items: MetadataColumn[]) {
    if (items.length) scope.discovered = true;
    const touched = new Set<string>();
    for (const column of items) {
      let columns = scope.columns.get(column.table);
      if (!columns) {
        columns = new Map();
        scope.columns.set(column.table, columns);
      }
      columns.set(column.name, column);
      touched.add(column.table);
    }
    for (const name of touched) {
      const table = scope.tables.get(name) || { ...scope.scope, name };
      scope.tables.set(name, {
        ...table,
        columns: [...scope.columns.get(name)!.values()]
          .sort((a, b) => a.position - b.position)
          .map(({ name, type }) => ({ name, type })),
      });
    }
  }
  function columnsPage(
    entry: Entry,
    scope: Scope,
    priority: Priority = "background",
  ) {
    if (scope.columnsComplete) return Promise.resolve();
    const cursor = scope.columnCursor;
    return schedule(
      entry,
      `columns:${metadataSchemaKey(scope.scope)}:${cursor || ""}`,
      priority,
      async () => {
        try {
          const result = await page<MetadataColumn>(
            entry,
            path(entry, "columns", scope.scope, { cursor }),
            cursor,
          );
          if (!current(entry)) return;
          mergeColumns(scope, result.items);
          scope.columnCursor = result.nextCursor;
          scope.columnsComplete = result.nextCursor === undefined;
          scope.columnsError = undefined;
          if (scope.columnsComplete) {
            for (const [name, table] of scope.tables) {
              if (!table.columns)
                scope.tables.set(name, { ...table, columns: [] });
              scope.loadedColumns.add(name);
              scope.columnErrors.delete(name);
            }
          }
        } catch (error) {
          if (current(entry)) scope.columnsError = message(error);
          throw error;
        } finally {
          publish(entry);
        }
      },
    );
  }
  function scan(entry: Entry) {
    if (!entry.warm || !current(entry)) return;
    if (!entry.schemasComplete && entry.status !== "error")
      void schemasPage(entry, "background").catch(() => {});
    for (const scope of entry.scopes.values()) {
      if (!scope.discovered) continue;
      if (!scope.complete && scope.status !== "error")
        void tablesPage(entry, scope, "background").catch(() => {});
      else if (scope.complete && !scope.columnsComplete && !scope.columnsError)
        void columnsPage(entry, scope).catch(() => {});
    }
  }
  function ensureSchemas(id: string) {
    const entry = entryFor(id);
    if (entry.schemasStarted && entry.status !== "error")
      return Promise.resolve();
    return schemasPage(entry, "foreground");
  }
  function activate(id: string, context: Context = {}) {
    if (!id) return;
    const entry = entryFor(id);
    entry.context = context;
    if (entry.warm) return;
    entry.warm = true;
    void ensureSchemas(id)
      .then(() => {
        if (!current(entry)) return;
        const preferred = [...entry.scopes.values()].find(
          (s) =>
            s.scope.schema === (context.schema || context.database) &&
            (!context.catalog || s.scope.catalog === context.catalog),
        );
        if (preferred)
          void tablesPage(entry, preferred, "foreground").catch(() => {});
        scan(entry);
      })
      .catch(() => {});
  }
  function invalidate(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.controller.abort();
    for (let i = queue.length - 1; i >= 0; i--)
      if (queue[i].entry === entry) {
        queue.splice(i, 1)[0].reject(new DOMException("Aborted", "AbortError"));
      }
    for (const listener of listeners.get(id) || []) listener();
  }
  return {
    getSnapshot(id: string): MetadataSnapshot {
      return id ? entryFor(id).snapshot : EMPTY;
    },
    getTables(id: string) {
      return id ? entryFor(id).snapshot.schemas.flatMap((s) => s.tables) : [];
    },
    subscribe(id: string, listener: () => void) {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (!set!.size) listeners.delete(id);
      };
    },
    activate,
    ensureSchemas,
    loadTables(id: string, value: MetadataSchema) {
      const entry = entryFor(id);
      const scope = scopeFor(entry, value);
      if (scope.started && !scope.error) return Promise.resolve();
      return tablesPage(entry, scope, "foreground");
    },
    retrySchema(id: string, value: MetadataSchema) {
      const entry = entryFor(id);
      const scope = scopeFor(entry, value);
      scope.error = undefined;
      scope.columnsError = undefined;
      return scope.complete
        ? columnsPage(entry, scope, "foreground")
        : tablesPage(entry, scope, "foreground");
    },
    loadMoreTables(id: string, value: MetadataSchema) {
      const entry = entryFor(id);
      return tablesPage(entry, scopeFor(entry, value), "foreground");
    },
    loadTable(id: string, table: SchemaTable) {
      const entry = entryFor(id);
      const scope = scopeFor(entry, table);
      if (scope.tables.has(table.name) || scope.lookedUp.has(table.name))
        return Promise.resolve();
      return schedule(
        entry,
        `table:${metadataTableKey(table)}`,
        "foreground",
        async () => {
          const result = await page<SchemaTable>(
            entry,
            path(entry, "tables", table, { table: table.name }),
          );
          if (!current(entry)) return;
          if (result.items.length) scope.discovered = true;
          for (const item of result.items)
            scope.tables.set(item.name, {
              ...item,
              ...scope.tables.get(item.name),
            });
          scope.lookedUp.add(table.name);
          publish(entry);
        },
      );
    },
    loadColumns(id: string, table: SchemaTable) {
      const entry = entryFor(id);
      const scope = scopeFor(entry, table);
      if (scope.loadedColumns.has(table.name)) return Promise.resolve();
      scope.columnErrors.delete(table.name);
      return schedule(
        entry,
        `table-columns:${metadataTableKey(table)}`,
        "foreground",
        async () => {
          let cursor: string | undefined;
          try {
            do {
              const result = await page<MetadataColumn>(
                entry,
                path(entry, "columns", table, { table: table.name, cursor }),
                cursor,
              );
              if (!current(entry)) return;
              mergeColumns(scope, result.items);
              cursor = result.nextCursor;
              publish(entry);
            } while (cursor !== undefined);
            if (!scope.tables.has(table.name))
              scope.tables.set(table.name, { ...table, columns: [] });
            else if (!scope.tables.get(table.name)!.columns)
              scope.tables.set(table.name, {
                ...scope.tables.get(table.name)!,
                columns: [],
              });
            scope.loadedColumns.add(table.name);
          } catch (error) {
            if (current(entry))
              scope.columnErrors.set(table.name, message(error));
            throw error;
          } finally {
            publish(entry);
          }
        },
      );
    },
    getColumnError(id: string, table: SchemaTable) {
      return entryFor(id)
        .scopes.get(metadataSchemaKey(table))
        ?.columnErrors.get(table.name);
    },
    async functionCatalog(id: string) {
      const entry = entryFor(id);
      if (!entry.functions)
        await schedule(entry, "functions", "foreground", async () => {
          const value = await request<SqlFunctionCatalog>(
            `/api/connections/${encodeURIComponent(id)}/functions`,
            { signal: entry.controller.signal },
          );
          entry.controller.signal.throwIfAborted();
          if (current(entry)) entry.functions = value;
        });
      return entry.functions!;
    },
    invalidate,
    refresh(id: string) {
      const context = entries.get(id)?.context;
      invalidate(id);
      activate(id, context);
    },
    dispose() {
      for (const id of [...entries.keys()]) invalidate(id);
      clearTimeout(backgroundTimer);
      backgroundTimer = undefined;
    },
  };
}
export type MetadataStore = ReturnType<typeof createMetadataStore>;
