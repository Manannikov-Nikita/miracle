import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetadataStore } from "../src/client/metadata-store";

const scope = { schema: "demo" };
const table = { schema: "demo", name: "sales" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
function fixture() {
  const paths: string[] = [];
  const request = async <T>(path: string): Promise<T> => {
    paths.push(path);
    const u = new URL(path, "http://local");
    if (u.pathname.endsWith("/schemas"))
      return { items: [scope, { schema: "closed" }, { schema: "empty" }] } as T;
    const schema = u.searchParams.get("schema")!;
    if (u.pathname.endsWith("/tables"))
      return {
        items:
          schema === "empty"
            ? []
            : [{ schema, name: schema === "demo" ? "sales" : "hidden" }],
      } as T;
    if (u.pathname.endsWith("/columns"))
      return {
        items:
          schema === "empty"
            ? []
            : [
                {
                  table: schema === "demo" ? "sales" : "hidden",
                  name: "searchable_column",
                  type: "String",
                  position: 1,
                },
              ],
      } as T;
    throw new Error(`Unexpected ${path}`);
  };
  return { paths, request };
}

describe("shared metadata store", () => {
  it("reuses schema/table/column requests across source switches and consumers", async () => {
    vi.useFakeTimers();
    const { request, paths } = fixture();
    const store = createMetadataStore(request);
    store.activate("a", { database: "demo" });
    await Promise.all([
      store.loadTables("a", scope),
      store.loadTables("a", scope),
    ]);
    await Promise.all([
      store.loadColumns("a", table),
      store.loadColumns("a", table),
    ]);
    store.activate("b");
    store.activate("a");
    await store.loadTables("a", scope);
    await store.loadColumns("a", table);
    expect(paths.filter((p) => p.includes("/a/metadata/tables"))).toHaveLength(
      1,
    );
    expect(paths.filter((p) => p.includes("/a/metadata/columns"))).toHaveLength(
      1,
    );
    expect(store.getTables("a")[0].columns).toEqual([
      { name: "searchable_column", type: "String" },
    ]);
    store.dispose();
  });
  it("indexes unopened schemas and columns in background and finishes empty schemas", async () => {
    vi.useFakeTimers();
    const { request } = fixture();
    const store = createMetadataStore(request);
    store.activate("a");
    await vi.runAllTimersAsync();
    expect(store.getSnapshot("a").complete).toBe(true);
    expect(store.getSnapshot("a").background).toBe(false);
    expect(
      store.getTables("a").find((t) => t.schema === "closed")?.columns,
    ).toEqual([{ name: "searchable_column", type: "String" }]);
    expect(
      store.getSnapshot("a").schemas.find((s) => s.schema === "empty")
        ?.columnsComplete,
    ).toBe(true);
    store.dispose();
  });
  it("collects all pages, including a table whose columns span pages", async () => {
    vi.useFakeTimers();
    const store = createMetadataStore(async <T>(path: string): Promise<T> => {
      const u = new URL(path, "http://local");
      if (u.pathname.endsWith("/schemas")) return { items: [scope] } as T;
      const more = u.searchParams.has("cursor");
      if (u.pathname.endsWith("/tables"))
        return (
          more
            ? { items: [{ ...table, name: "z" }] }
            : { items: [table], nextCursor: "next-table" }
        ) as T;
      return (
        more
          ? {
              items: [
                { table: "sales", name: "second", type: "String", position: 2 },
              ],
            }
          : {
              items: [
                { table: "sales", name: "first", type: "Int64", position: 1 },
              ],
              nextCursor: "next-column",
            }
      ) as T;
    });
    store.activate("a");
    await vi.runAllTimersAsync();
    expect(store.getTables("a").map((t) => t.name)).toEqual(["sales", "z"]);
    expect(store.getTables("a")[0].columns?.map((c) => c.name)).toEqual([
      "first",
      "second",
    ]);
    expect(store.getTables("a")[1].columns).toEqual([]);
    expect(store.getSnapshot("a").complete).toBe(true);
    store.dispose();
  });
  it("ignores late responses after refresh even if transport ignores abort", async () => {
    vi.useFakeTimers();
    const old = deferred<unknown>();
    let reads = 0;
    const store = createMetadataStore(async <T>(path: string): Promise<T> => {
      if (path.includes("/schemas")) return { items: [scope] } as T;
      if (path.includes("/tables"))
        return (
          ++reads === 1
            ? await old.promise
            : { items: [{ ...table, name: "fresh" }] }
        ) as T;
      return { items: [] } as T;
    });
    const stale = store.loadTables("a", scope).catch(() => {});
    await Promise.resolve();
    store.refresh("a");
    await store.loadTables("a", scope);
    old.resolve({ items: [{ ...table, name: "stale" }] });
    await stale;
    expect(store.getTables("a").map((t) => t.name)).toEqual(["fresh"]);
    store.dispose();
  });
  it("foreground work overtakes queued background pages with one background request active", async () => {
    vi.useFakeTimers();
    const hold = deferred<unknown>();
    const calls: string[] = [];
    const store = createMetadataStore(async <T>(path: string): Promise<T> => {
      const u = new URL(path, "http://local");
      calls.push(
        u.pathname.split("/").at(-1) + ":" + u.searchParams.get("schema"),
      );
      if (u.pathname.endsWith("/schemas"))
        return {
          items: [
            { schema: "slow" },
            { schema: "queued" },
            { schema: "urgent" },
          ],
        } as T;
      if (u.searchParams.get("schema") === "slow")
        return (await hold.promise) as T;
      return { items: [] } as T;
    });
    store.activate("a");
    await vi.advanceTimersByTimeAsync(150);
    await store.loadTables("a", { schema: "urgent" });
    expect(calls).toContain("tables:urgent");
    expect(calls).not.toContain("tables:queued");
    hold.resolve({ items: [] });
    await vi.runAllTimersAsync();
    expect(store.getSnapshot("a").complete).toBe(true);
    store.dispose();
  });
  it("continues after one scope fails and allows retry without clearing good scopes", async () => {
    vi.useFakeTimers();
    const { request } = fixture();
    let fail = true;
    const store = createMetadataStore(async <T>(path: string): Promise<T> => {
      if (path.includes("tables") && path.includes("schema=closed") && fail)
        throw new Error("permission denied");
      return request<T>(path);
    });
    store.activate("a");
    await vi.runAllTimersAsync();
    expect(store.getSnapshot("a").complete).toBe(false);
    expect(
      store.getSnapshot("a").schemas.find((s) => s.schema === "closed")?.error,
    ).toBe("permission denied");
    expect(
      store.getTables("a").find((t) => t.schema === "demo")?.columns,
    ).toHaveLength(1);
    fail = false;
    await store.loadTables("a", { schema: "closed" });
    await vi.runAllTimersAsync();
    expect(store.getSnapshot("a").complete).toBe(true);
    store.dispose();
  });
  it("isolates identical object names between connections and invalidates secret-only edits", async () => {
    vi.useFakeTimers();
    let value = "one";
    const store = createMetadataStore(async <T>(path: string): Promise<T> => {
      if (path.includes("/schemas")) return { items: [scope] } as T;
      if (path.includes("/tables")) return { items: [table] } as T;
      return {
        items: [
          {
            table: "sales",
            name: path.includes("/b/") ? "two" : value,
            type: "String",
            position: 1,
          },
        ],
      } as T;
    });
    await store.loadColumns("a", table);
    await store.loadColumns("b", table);
    expect(store.getTables("a")[0].columns?.[0].name).toBe("one");
    expect(store.getTables("b")[0].columns?.[0].name).toBe("two");
    value = "updated";
    store.invalidate("a");
    await store.loadColumns("a", table);
    expect(store.getTables("a")[0].columns?.[0].name).toBe("updated");
    expect(store.getTables("b")[0].columns?.[0].name).toBe("two");
    store.dispose();
  });
});

describe("metadata queue and recovery", () => {
  it("caps concurrent metadata requests while allowing waiting foreground work to finish", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximum = 0;
    const pending: Array<() => void> = [];
    const store = createMetadataStore(async <T>(): Promise<T> => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active--;
      return { items: [] } as T;
    });
    const work = Array.from({ length: 8 }, (_, i) =>
      store.loadTables("a", { schema: `schema${i}` }),
    );
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(0);
      pending.splice(0).forEach((resolve) => resolve());
    }
    await Promise.all(work);
    expect(maximum).toBe(3);
    expect(active).toBe(0);
    store.dispose();
  });
  it("retries incomplete background columns without rereading successful tables", async () => {
    vi.useFakeTimers();
    const { request, paths } = fixture();
    let fail = true;
    const store = createMetadataStore(async <T>(path: string): Promise<T> => {
      if (path.includes("columns") && path.includes("schema=closed") && fail)
        throw new Error("temporary");
      return request<T>(path);
    });
    store.activate("a");
    await vi.runAllTimersAsync();
    expect(
      store.getSnapshot("a").schemas.find((s) => s.schema === "closed")
        ?.columnsError,
    ).toBe("temporary");
    const tableReads = paths.filter((p) => p.includes("/tables")).length;
    fail = false;
    await store.retrySchema("a", { schema: "closed" });
    await vi.runAllTimersAsync();
    expect(store.getSnapshot("a").complete).toBe(true);
    expect(paths.filter((p) => p.includes("/tables"))).toHaveLength(tableReads);
    store.dispose();
  });
  it("can be disposed with active subscribers and restarted after React effect cleanup", async () => {
    vi.useFakeTimers();
    const { request } = fixture();
    const store = createMetadataStore(request);
    const unsubscribe = store.subscribe("a", () => store.getSnapshot("a"));
    store.activate("a");
    store.dispose();
    expect(store.getSnapshot("a").status).toBe("idle");
    store.activate("a");
    await vi.runAllTimersAsync();
    expect(store.getSnapshot("a").complete).toBe(true);
    unsubscribe();
    store.dispose();
  });
});

describe("authoritative schema discovery", () => {
  it("does not add a SQL typo to the Explorer or background scanner", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const store = createMetadataStore(async <T>(path: string): Promise<T> => {
      requests.push(path);
      if (path.includes("/schemas"))
        return { items: [scope, { schema: "empty" }] } as T;
      return { items: [] } as T;
    });
    await store.loadTable("a", { schema: "typo", name: "events" });
    await store.loadTables("a", { schema: "typo" });
    store.activate("a");
    await vi.runAllTimersAsync();
    expect(store.getSnapshot("a").schemas.map((s) => s.schema)).toEqual([
      "demo",
      "empty",
    ]);
    expect(store.getSnapshot("a").complete).toBe(true);
    expect(
      requests.filter(
        (path) => path.includes("/columns") && path.includes("schema=typo"),
      ),
    ).toEqual([]);
    store.dispose();
  });
});

describe("large source introspection", () => {
  it("finishes 8192 tables and 131072 columns across unopened paged schemas", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const store = createMetadataStore(async <T>(path: string): Promise<T> => {
      calls++;
      const url = new URL(path, "http://local");
      const cursor = Number(url.searchParams.get("cursor") || "0");
      if (url.pathname.endsWith("/schemas"))
        return {
          items: Array.from({ length: 32 }, (_, i) => ({
            schema: `schema_${cursor + i}`,
          })),
          ...(cursor === 0 ? { nextCursor: "32" } : {}),
        } as T;
      const schema = url.searchParams.get("schema")!;
      if (url.pathname.endsWith("/tables"))
        return {
          items: Array.from({ length: 128 }, (_, i) => ({
            schema,
            name: `table_${i}`,
          })),
        } as T;
      const end = Math.min(cursor + 1000, 2048);
      return {
        items: Array.from({ length: end - cursor }, (_, i) => ({
          table: `table_${Math.floor((cursor + i) / 16)}`,
          name: `column_${(cursor + i) % 16}`,
          type: "String",
          position: ((cursor + i) % 16) + 1,
        })),
        ...(end < 2048 ? { nextCursor: String(end) } : {}),
      } as T;
    });
    store.activate("large");
    await vi.runAllTimersAsync();
    expect(store.getSnapshot("large").complete).toBe(true);
    expect(store.getSnapshot("large").schemas).toHaveLength(64);
    const tables = store.getTables("large");
    expect(tables).toHaveLength(8192);
    expect(tables.reduce((sum, t) => sum + t.columns!.length, 0)).toBe(131072);
    expect(
      tables
        .find((t) => t.schema === "schema_63" && t.name === "table_127")
        ?.columns?.at(-1)?.name,
    ).toBe("column_15");
    const before = calls;
    store.activate("large");
    await store.loadTables("large", { schema: "schema_63" });
    await store.loadColumns("large", {
      schema: "schema_63",
      name: "table_127",
    });
    expect(calls).toBe(before);
    store.dispose();
  });
});
