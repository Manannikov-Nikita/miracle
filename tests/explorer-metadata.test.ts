// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import Explorer from "../src/client/components/Explorer";
import type { Connection } from "../src/shared/types";
import {
  createMetadataStore,
  type MetadataStore,
} from "../src/client/metadata-store";

vi.mock("../src/client/api", () => ({ api: vi.fn(async () => []) }));

const connections: Connection[] = ["a", "b"].map((id) => ({
  id,
  name: `Source ${id}`,
  engine: "clickhouse",
  url: `http://${id}`,
  username: "reader",
  hasPassword: false,
}));

function readySchema(schema: string, count = 1) {
  return {
    schema,
    status: "ready" as const,
    complete: true,
    columnsComplete: true,
    tables: Array.from({ length: count }, (_, index) => ({
      schema,
      name: `${schema}_table_${index}`,
      columns: [{ name: `hidden_column_${index}`, type: "String" }],
    })),
  };
}

// The external store supplies immutable snapshots; this fixture keeps the UI
// tests independent of request scheduling, which has separate store tests.
function fixtureStore() {
  const snapshots = new Map(
    connections.map(({ id }) => [
      id,
      {
        status: "ready" as const,
        schemas: [readySchema(`${id}_schema`)],
        background: false,
        complete: true,
      },
    ]),
  );
  const listeners = new Map<string, Set<() => void>>();
  return {
    snapshots,
    getSnapshot: (id: string) => snapshots.get(id)!,
    subscribe(id: string, callback: () => void) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id)!.add(callback);
      return () => listeners.get(id)!.delete(callback);
    },
    activate() {},
    async loadTables() {},
    async loadMoreTables() {},
    async loadColumns() {},
    getColumnError() {
      return undefined;
    },
    refresh() {},
    invalidate() {},
    dispose() {},
    getTables: (id: string) =>
      snapshots.get(id)!.schemas.flatMap((s) => s.tables),
    publish(id: string) {
      listeners.get(id)?.forEach((callback) => callback());
    },
  };
}

describe("schema explorer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof fixtureStore>;
  let realStore: MetadataStore | undefined;
  let activeConnectionId: string;
  let views: Map<string, unknown>;
  async function render() {
    await act(async () => {
      root.render(
        createElement(Explorer, {
          kind: "sources",
          connections,
          activeConnectionId,
          onConnectionChange: (id: string) => {
            activeConnectionId = id;
          },
          metadata: realStore || store,
          sourceViews: views,
          onOpenConnections() {},
          onOpenQuery() {},
          onOpenSource() {},
          queryRevision: 0,
          onNotify() {},
        } as unknown as ComponentProps<typeof Explorer>),
      );
    });
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (node) =>
        node.getAttribute("aria-label") === label ||
        node.textContent?.trim() === label,
    );
    expect(button, `Missing button ${label}`).toBeTruthy();
    await act(async () => {
      button!.click();
    });
  }
  async function search(value: string) {
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    store = fixtureStore();
    activeConnectionId = "a";
    views = new Map();
    realStore = undefined;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    realStore?.dispose();
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps tables hidden until their schema is expanded", async () => {
    await render();
    expect(container.textContent).toContain("a_schema");
    expect(container.textContent).not.toContain("a_schema_table_0");
    await click("Схема a_schema");
    expect(container.textContent).toContain("a_schema_table_0");
    expect(container.textContent).not.toContain("hidden_column_0");
    await click("Таблица a_schema.a_schema_table_0");
    expect(container.textContent).toContain("hidden_column_0");
  });

  it("restores expanded schemas after switching sources and remounting", async () => {
    await render();
    await click("Схема a_schema");
    activeConnectionId = "b";
    await render();
    expect(container.textContent).not.toContain("a_schema_table_0");
    expect(container.textContent).not.toContain("b_schema_table_0");
    activeConnectionId = "a";
    await render();
    expect(container.textContent).toContain("a_schema_table_0");
    await act(async () => root.render(null));
    await render();
    expect(container.textContent).toContain("a_schema_table_0");
  });

  it("finds columns in an unopened schema loaded in the background", async () => {
    await render();
    await search("hidden_column_0");
    expect(container.textContent).toContain("a_schema_table_0");
    expect(container.textContent).toContain("hidden_column_0");
    await search("");
    expect(container.textContent).not.toContain("a_schema_table_0");
  });

  it("limits a large schema until the user asks for more", async () => {
    store.snapshots.set("a", {
      status: "ready",
      schemas: [readySchema("a_schema", 1200)],
      background: false,
      complete: true,
    });
    await render();
    await click("Схема a_schema");
    expect(
      container.querySelectorAll(".table-tree-item").length,
    ).toBeLessThanOrEqual(100);
    expect(container.textContent).not.toContain("a_schema_table_150");
    await click("Показать ещё таблицы в a_schema");
    expect(container.textContent).toContain("a_schema_table_150");
    expect(
      container.querySelectorAll(".table-tree-item").length,
    ).toBeLessThanOrEqual(200);
  });

  it("keeps cached metadata across source switches and an Explorer remount", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    realStore = createMetadataStore(async <T>(path: string): Promise<T> => {
      requests.push(path);
      const url = new URL(path, "http://miracle.test");
      const id = path.includes("/a/") ? "a" : "b";
      const schema = `${id}_schema`;
      return {
        items: url.pathname.endsWith("/schemas")
          ? [{ schema }]
          : url.pathname.endsWith("/tables")
            ? [{ schema, name: `${schema}_table_0` }]
            : [
                {
                  table: `${schema}_table_0`,
                  name: "secret_column",
                  type: "String",
                  position: 1,
                },
              ],
      } as T;
    });
    await render();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await click("Схема a_schema");
    expect(container.textContent).toContain("a_schema_table_0");
    activeConnectionId = "b";
    await render();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    activeConnectionId = "a";
    await render();
    await act(async () => root.render(null));
    await render();
    expect(container.textContent).toContain("a_schema_table_0");
    expect(
      requests.filter((path) => path === "/api/connections/a/metadata/schemas"),
    ).toHaveLength(1);
    expect(
      requests.filter((path) =>
        path.startsWith("/api/connections/a/metadata/tables"),
      ),
    ).toHaveLength(1);
  });

  it("adds unopened background columns to the current search results", async () => {
    vi.useFakeTimers();
    realStore = createMetadataStore(async <T>(path: string): Promise<T> => {
      const url = new URL(path, "http://miracle.test");
      return {
        items: url.pathname.endsWith("/schemas")
          ? [{ schema: "warehouse" }]
          : url.pathname.endsWith("/tables")
            ? [{ schema: "warehouse", name: "orders" }]
            : [
                {
                  table: "orders",
                  name: "customer_email",
                  type: "String",
                  position: 1,
                },
              ],
      } as T;
    });
    await render();
    await search("customer_email");
    expect(container.textContent).not.toContain("orders");
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(container.textContent).toContain("orders");
    expect(container.textContent).toContain("customer_email");
    await search("");
    expect(container.textContent).not.toContain("orders");
  });

  it("reports background failures for a collapsed schema and retries without clearing other metadata", async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    let columnCalls = 0;
    realStore = createMetadataStore(async <T>(path: string): Promise<T> => {
      requests.push(path);
      const url = new URL(path, "http://miracle.test");
      if (url.pathname.endsWith("/columns") && ++columnCalls === 1)
        throw new Error("Metadata unavailable");
      return {
        items: url.pathname.endsWith("/schemas")
          ? [{ schema: "warehouse" }]
          : url.pathname.endsWith("/tables")
            ? [{ schema: "warehouse", name: "orders" }]
            : [
                {
                  table: "orders",
                  name: "customer_email",
                  type: "String",
                  position: 1,
                },
              ],
      } as T;
    });
    await render();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(container.textContent).toContain("Не удалось полностью загрузить");
    expect(container.textContent).not.toContain("orders");
    await click("Повторить загрузку");
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(container.textContent).not.toContain(
      "Не удалось полностью загрузить",
    );
    await search("customer_email");
    expect(container.textContent).toContain("orders");
    expect(requests.filter((path) => path.endsWith("/schemas"))).toHaveLength(
      1,
    );
    expect(
      requests.filter((path) =>
        new URL(path, "http://miracle.test").pathname.endsWith("/tables"),
      ),
    ).toHaveLength(1);
  });

  it("keeps a broad column search bounded instead of rendering every matching column", async () => {
    const scope = readySchema("warehouse", 500);
    for (const table of scope.tables)
      table.columns = Array.from({ length: 50 }, (_, index) => ({
        name: `customer_${index}`,
        type: "String",
      }));
    store.snapshots.set("a", {
      status: "ready",
      schemas: [scope],
      background: false,
      complete: true,
    });
    await render();
    await search("customer");
    expect(
      container.querySelectorAll(".table-tree-item").length,
    ).toBeLessThanOrEqual(100);
    expect(
      container.querySelectorAll(".columns-tree > div").length,
    ).toBeLessThanOrEqual(100);
    expect(container.textContent).toContain("Показать ещё результаты");
  });

  it("shows a later column-page failure beside partial columns and retries the missing page", async () => {
    vi.useFakeTimers();
    let tailCalls = 0;
    realStore = createMetadataStore(async <T>(path: string): Promise<T> => {
      const url = new URL(path, "http://miracle.test");
      if (url.pathname.endsWith("/schemas"))
        return { items: [{ schema: "warehouse" }] } as T;
      if (url.pathname.endsWith("/tables"))
        return { items: [{ schema: "warehouse", name: "orders" }] } as T;
      if (url.searchParams.get("cursor") === "tail") {
        if (++tailCalls === 1) throw new Error("Column page unavailable");
        return {
          items: [
            {
              table: "orders",
              name: "customer_email",
              type: "String",
              position: 2,
            },
          ],
        } as T;
      }
      return {
        items: [
          { table: "orders", name: "order_id", type: "Int64", position: 1 },
        ],
        nextCursor: "tail",
      } as T;
    });
    await render();
    await click("Схема warehouse");
    await click("Таблица warehouse.orders");
    expect(container.textContent).toContain("order_id");
    expect(container.textContent).toContain("Column page unavailable");
    expect(container.textContent).not.toContain("customer_email");
    await click("Повторить");
    expect(container.textContent).toContain("order_id");
    expect(container.textContent).toContain("customer_email");
    expect(container.textContent).not.toContain("Column page unavailable");
  });
});
