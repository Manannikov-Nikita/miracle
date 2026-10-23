// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import SqlWorkspace, {
  type SqlSourceRequest,
} from "../src/client/components/SqlWorkspace";
import type { Connection, QuerySource } from "../src/shared/types";

// Monaco requires a browser worker/layout engine. Keep the actual workspace and
// its tab/context controls, replacing only the editor with an editable textarea.
vi.mock("@monaco-editor/react", () => ({
  loader: { config() {} },
  default: (p: { value: string; onChange: (value: string) => void }) =>
    createElement("textarea", {
      "aria-label": "Test SQL editor",
      value: p.value,
      onChange: (event: { target: { value: string } }) =>
        p.onChange(event.target.value),
    }),
}));
vi.mock("monaco-editor/editor/editor.api.js", () => ({
  editor: { defineTheme() {} },
  languages: {
    register() {},
    setMonarchTokensProvider() {},
    setLanguageConfiguration() {},
    registerCompletionItemProvider: () => ({ dispose() {} }),
  },
}));
vi.mock("monaco-editor/languages/definitions/sql/register.js", () => ({}));
vi.mock(
  "monaco-editor/editor/contrib/suggest/browser/suggestController.js",
  () => ({}),
);
vi.mock(
  "monaco-editor/editor/contrib/snippet/browser/snippetController2.js",
  () => ({}),
);
vi.mock("monaco-editor/features/wordOperations/register.js", () => ({}));
vi.mock("monaco-editor/editor/editor.worker.js?worker", () => ({
  default: class {},
}));

const storage = "miracle:sql-tabs:source-tab-test";
const source: QuerySource = {
  connectionId: "trino",
  sql: "select revenue from monthly_sales",
  catalog: "analytics",
  schema: "finance",
};
const connections: Connection[] = [
  {
    id: "trino",
    name: "Trino",
    engine: "trino",
    url: "http://trino",
    username: "reader",
    hasPassword: false,
  },
  {
    id: "clickhouse",
    name: "ClickHouse",
    engine: "clickhouse",
    url: "http://clickhouse",
    username: "reader",
    hasPassword: false,
  },
];

describe("chart source SQL tabs", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof SqlWorkspace>;
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        stored.delete(key);
      },
      clear: () => stored.clear(),
    });
    localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      user: {
        id: "source-tab-test",
        name: "Reader",
        email: "reader@example.test",
        role: "editor",
      },
      connections,
      activeConnectionId: "trino",
      schema: [],
      onConnectionChange: vi.fn(),
      onSourceConsumed: vi.fn(),
      onSavedConsumed: vi.fn(),
      onQueriesChanged: vi.fn(),
      onResult: vi.fn(),
      onNotify: vi.fn(),
      onOpenConnections: vi.fn(),
      onMaximize: vi.fn(),
      onCollapse: vi.fn(),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });
  async function render(request?: SqlSourceRequest) {
    props = { ...props, sourceToOpen: request ?? null };
    await act(async () => root.render(createElement(SqlWorkspace, props)));
  }
  function tabs() {
    return [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  }
  function activeTab() {
    return container.querySelector('[role="tab"][aria-selected="true"]')
      ?.textContent;
  }
  function editor() {
    return container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Test SQL editor"]',
    )!;
  }
  function context(label: string) {
    return container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
      ?.value;
  }
  async function clickTab(name: string) {
    const tab = tabs().find((tab) => tab.textContent === name);
    expect(tab, `tab ${name}`).toBeDefined();
    await act(async () => tab!.click());
  }
  async function editSql(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor(), value);
      editor().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  function seed(name: string) {
    localStorage.setItem(
      storage,
      JSON.stringify([
        {
          id: "existing",
          name,
          sql: "select unsaved_draft",
          connectionId: "clickhouse",
          database: "private_draft",
        },
        {
          id: "other",
          name: "other.sql",
          sql: "select 2",
          connectionId: "trino",
        },
      ]),
    );
    localStorage.setItem(`${storage}:active`, "other");
  }

  it("starts with an empty editable SQL file and a source action when no connections exist", async () => {
    props.connections = [];
    props.activeConnectionId = "";
    props.user.role = "admin";
    await render();
    expect(editor().value).toBe("");
    expect(tabs()).toHaveLength(1);
    expect(container.textContent).toContain("Подключите первый источник");
    const connect = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Подключить источник"),
    );
    expect(connect).toBeDefined();
    await act(async () => connect!.click());
    expect(props.onOpenConnections).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Новый SQL-файл"]',
    );
    expect(add).not.toBeNull();
    await act(async () => add!.click());
    expect(editor().value).toBe("");
    expect(tabs()).toHaveLength(2);
  });

  it("opens the literal chart title and its pinned SQL and query context", async () => {
    await render({ source, name: "Выручка / месяц" });
    expect(activeTab()).toBe("Выручка / месяц");
    expect(editor().value).toBe(source.sql);
    expect(context("Каталог запроса")).toBe("analytics");
    expect(context("Схема запроса")).toBe("finance");
    expect(props.onConnectionChange).toHaveBeenCalledWith("trino");
    expect(props.onSourceConsumed).toHaveBeenCalledOnce();
  });

  it("reactivates a chart tab after switching away and preserves edited SQL", async () => {
    await render({ source, name: "Выручка" });
    await editSql("select my_unsaved_edit");
    expect(editor().value).toBe("select my_unsaved_edit");
    await clickTab("query_1.sql");
    await render({
      source: { ...source, sql: "select changed_pinned_source" },
      name: "Выручка",
    });
    expect(activeTab()).toBe("Выручка");
    expect(editor().value).toBe("select my_unsaved_edit");
    expect(tabs()).toHaveLength(2);
  });

  it("reuses an exact existing name across sources without replacing its draft or connection", async () => {
    seed("Выручка");
    await render({ source, name: "Выручка" });
    expect(activeTab()).toBe("Выручка");
    expect(tabs()).toHaveLength(2);
    expect(editor().value).toBe("select unsaved_draft");
    expect(context("База запроса")).toBe("private_draft");
    expect(props.onConnectionChange).toHaveBeenLastCalledWith("clickhouse");
  });

  it("keeps a literal .sql title and does not treat the unsuffixed title as the same name", async () => {
    seed("Выручка");
    await render({ source, name: "Выручка.sql" });
    expect(activeTab()).toBe("Выручка.sql");
    expect(tabs()).toHaveLength(3);
    expect(tabs().map((tab) => tab.textContent)).toContain("Выручка");
    expect(editor().value).toBe(source.sql);
  });

  it("reuses the fallback name for repeated empty chart titles", async () => {
    await render({ source, name: "" });
    expect(activeTab()).toBe("source.sql");
    await editSql("select fallback_draft");
    await clickTab("query_1.sql");
    await render({
      source: { ...source, sql: "select newer_source" },
      name: "",
    });
    expect(activeTab()).toBe("source.sql");
    expect(editor().value).toBe("select fallback_draft");
    expect(tabs()).toHaveLength(2);
  });

  it("retains source.sql for unnamed source requests", async () => {
    await render({ source });
    expect(activeTab()).toBe("source.sql");
    expect(editor().value).toBe(source.sql);
  });

  it("still reuses saved documents by queryId and preserves their drafts", async () => {
    seed("renamed.sql");
    const savedTabs = JSON.parse(localStorage.getItem(storage)!);
    savedTabs[0].queryId = "saved-query";
    localStorage.setItem(storage, JSON.stringify(savedTabs));
    props.savedToOpen = {
      ...source,
      id: "saved-query",
      name: "server-name.sql",
      revision: 3,
      updatedAt: "2026-10-23T00:00:00Z",
    };
    await render();
    expect(activeTab()).toBe("renamed.sql");
    expect(tabs()).toHaveLength(2);
    expect(editor().value).toBe("select unsaved_draft");
    expect(props.onSavedConsumed).toHaveBeenCalledOnce();
  });
});
