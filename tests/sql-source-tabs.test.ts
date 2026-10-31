// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate as yieldIO } from "node:timers/promises";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import SqlWorkspace, {
  type SqlSourceRequest,
} from "../src/client/components/SqlWorkspace";
import { editorApi } from "./helpers/editor-api";
import type { Connection, QuerySource } from "../src/shared/types";
import { createMetadataStore } from "../src/client/metadata-store";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";

// Monaco requires a browser worker/layout engine. Keep the actual workspace and
// its tab/context controls, replacing only the editor with an editable textarea.
vi.mock("@monaco-editor/react", () => ({
  loader: { config() {} },
  default: (p: {
    value?: string;
    defaultValue?: string;
    onChange: (value: string) => void;
  }) =>
    createElement("textarea", {
      "aria-label": "Test SQL editor",
      value: p.value ?? p.defaultValue ?? "",
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
        editorApi(
          async () => new Response("[]", { status: 200 }),
          () => props.workspaceId,
        ),
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
      workspaceId: "source-tab-test",
      connections,
      activeConnectionId: "trino",
      metadata: createMetadataStore(async <T>() => ({ items: [] }) as T),
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
    props.metadata.dispose();
    container.remove();
    localStorage.clear();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });
  async function render(request?: SqlSourceRequest) {
    props = { ...props, sourceToOpen: request ?? null };
    await act(async () => root.render(createElement(SqlWorkspace, props)));
    await readyEditor();
  }
  async function readyEditor() {
    // Legacy migration hashes batches with native WebCrypto before loading the
    // editor. Wait for the real rendered state, including in fake-timer tests.
    // On loaded CI, async act can exceed waitFor's default 1 s real-time budget.
    await vi.waitFor(
      async () => {
        await act(async () => {
          await yieldIO();
        });
        expect(
          editor(),
          container.textContent || "SQL editor not ready",
        ).not.toBeNull();
      },
      { timeout: 5000 },
    );
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
  it("persists the editor draft before publishing its saved query", async () => {
    let editorSqlAtQuerySave: string | undefined;
    const backend = editorApi(
      async (path, options) => {
        if (path === "/api/queries" && options.method === "POST") {
          const docs = await (await backend("/api/editor-documents")).json();
          editorSqlAtQuerySave = docs.find(
            (d: { id: string }) => d.id === "existing",
          )?.sql;
          return new Response(
            JSON.stringify({
              ...JSON.parse(options.body as string),
              id: "saved",
              revision: 1,
            }),
          );
        }
        return new Response("[]");
      },
      () => props.workspaceId,
    );
    vi.stubGlobal("fetch", vi.fn(backend));
    seed("draft.sql");
    await render();
    await clickTab("draft.sql");
    await editSql("select freshly_typed_sql");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить SQL-файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    await act(async () =>
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(editorSqlAtQuerySave).toBe("select freshly_typed_sql");
    expect(props.onQueriesChanged).toHaveBeenCalledOnce();
  });
  it("saves the latest synchronized revision of the original tab after a pending flush", async () => {
    const sync = new ProjectSync();
    let releaseFlush!: () => void;
    const pendingFlush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let savedQuery: { path: string; body: Record<string, unknown> } | undefined;
    const backend = editorApi(
      async (path, options) => {
        if (path.startsWith("/api/queries/") && options.method === "PATCH") {
          const body = JSON.parse(options.body as string);
          savedQuery = { path, body };
          return new Response(
            JSON.stringify({ ...body, id: "saved-query", revision: 3 }),
          );
        }
        return new Response("[]");
      },
      () => props.workspaceId,
    );
    let holdFlush = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        const response = await backend(path, options);
        if (
          holdFlush &&
          path === "/api/editor-documents/existing" &&
          options.method === "PATCH"
        ) {
          holdFlush = false;
          const saved = await response.clone().json();
          sync.emit({ id: 1, type: "editor.updated", data: saved });
          const changed = await backend(path, {
            method: "PATCH",
            body: JSON.stringify({
              baseRevision: saved.revision,
              sql: "select agent_update",
              queryRevision: 2,
            }),
          });
          sync.emit({
            id: 2,
            type: "editor.updated",
            data: await changed.json(),
          });
          await pendingFlush;
        }
        return response;
      }),
    );
    seed("draft.sql", { queryId: "saved-query", revision: 1 });
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: sync },
          createElement(SqlWorkspace, props),
        ),
      ),
    );
    await clickTab("draft.sql");
    await editSql("select local_edit");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить SQL-файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    holdFlush = true;
    await act(async () =>
      document
        .querySelector('[role="dialog"] form')!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    expect(editor().value).toBe("select agent_update");
    expect(savedQuery).toBeUndefined();
    await clickTab("other.sql");
    await act(async () => releaseFlush());
    expect(savedQuery).toMatchObject({
      path: "/api/queries/saved-query",
      body: { sql: "select agent_update", baseRevision: 2 },
    });
    expect(activeTab()).toBe("other.sql");
    expect(editor().value).toBe("select 2");
    expect(props.onQueriesChanged).toHaveBeenCalledOnce();
  });
  function context(label: string) {
    return container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
      ?.value;
  }
  async function clickTab(name: string) {
    await readyEditor();
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
  function seed(name: string, saved?: { queryId: string; revision: number }) {
    localStorage.setItem(
      storage,
      JSON.stringify([
        {
          id: "existing",
          name,
          sql: "select unsaved_draft",
          connectionId: "clickhouse",
          database: "private_draft",
          ...saved,
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
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([path]) =>
          String(path).startsWith("/api/editor-documents"),
        ),
    ).toBe(true);
    const add = container.querySelector<HTMLButtonElement>(
      '[aria-label="Новый SQL-файл"]',
    );
    expect(add).not.toBeNull();
    await act(async () => add!.click());
    expect(editor().value).toBe("");
    expect(tabs()).toHaveLength(2);
  });

  it("recovers SQL edits after reopening and does not import another workspace's drafts", async () => {
    seed("draft.sql");
    await render();
    await clickTab("draft.sql");
    await editSql("select preserved_local_edit");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(editor().value).toBe("select preserved_local_edit");
    await act(async () => root.unmount());
    root = createRoot(container);
    props.workspaceId = "different-workspace";
    await render();
    expect(editor().value).toBe("");
    expect(tabs()).toHaveLength(1);
    expect(
      localStorage.getItem("miracle:sql-recovery:source-tab-test"),
    ).toContain("select preserved_local_edit");
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
  it("preserves recovered connection and context edits when a newer server document has identical SQL", async () => {
    const document = {
      id: "context-recovery",
      name: "server.sql",
      sql: "select 1",
      connectionId: "trino",
      catalog: "server",
      schema: "public",
      revision: 7,
      updatedAt: "now",
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify([document])),
    );
    localStorage.setItem(`${storage}:imported`, "1");
    localStorage.setItem(
      "miracle:sql-recovery:source-tab-test",
      JSON.stringify([
        {
          id: document.id,
          name: "my-name.sql",
          sql: "select 1",
          connectionId: "clickhouse",
          database: "my-draft-database",
          documentRevision: 5,
        },
      ]),
    );
    await render();
    expect(activeTab()).toBe("my-name.sql");
    expect(context("База запроса")).toBe("my-draft-database");
    expect(container.textContent).toContain("Ваш черновик сохранён");
  });
});
