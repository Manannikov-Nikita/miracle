// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate as yieldIO } from "node:timers/promises";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
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

vi.mock("../src/client/file-highlighting", () => ({
  ensureFileLanguage: async () => {},
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
    return container.querySelector<HTMLElement>(
      '[aria-label="Test SQL editor"], .cm-content',
    )!;
  }
  function markdownView() {
    const host = container.querySelector<HTMLElement>(".cm-editor");
    return host ? EditorView.findFromDOM(host) : undefined;
  }
  function editorValue() {
    return (
      markdownView()?.state.doc.toString() ??
      (editor() as HTMLTextAreaElement).value
    );
  }
  it.each([
    {},
    { editor: 0, results: 0 },
    { editor: 40 },
    { editor: -5, results: 105 },
  ])(
    "recovers a visible SQL editor from an invalid saved panel layout %j",
    async (invalid) => {
      localStorage.setItem(
        "miracle:editor-layout:source-tab-test",
        JSON.stringify(invalid),
      );
      await render();
      expect(
        container.querySelector<HTMLElement>("#editor[data-panel]")?.style
          .flexGrow,
      ).toBe("55");
      expect(
        container.querySelector<HTMLElement>("#results[data-panel]")?.style
          .flexGrow,
      ).toBe("45");
    },
  );
  const projectFile = (path: string, content = "# Notes") => ({
    path,
    name: path.split("/").pop()!,
    content,
    revision: "disk-v1",
    size: content.length,
    updatedAt: "2026-11-04T00:00:00Z",
  });
  async function openProjectFile(
    path: string,
    content?: string,
    sync?: ProjectSync,
  ) {
    props = {
      ...props,
      fileToOpen: projectFile(path, content),
      onFileConsumed: vi.fn(),
    };
    await act(async () =>
      root.render(
        sync
          ? createElement(
              ProjectSyncContext.Provider,
              { value: sync },
              createElement(SqlWorkspace, props),
            )
          : createElement(SqlWorkspace, props),
      ),
    );
    await readyEditor();
  }
  it("opens text files without SQL actions or stale SQL agent targets and preserves dirty drafts on reopen", async () => {
    const sync = new ProjectSync();
    await openProjectFile("docs/notes.md", "# Notes", sync);
    expect(activeTab()).toBe("notes.md");
    expect(editorValue()).toBe("# Notes");
    expect(container.querySelector(".md-preview-h1")?.textContent).toBe(
      "Notes",
    );
    expect(
      container.querySelector('[aria-label="Test SQL editor"]'),
    ).toBeNull();
    expect(container.querySelector(".run-button")).toBeNull();
    expect(sync.context().editorDocumentId).toBeUndefined();
    await editSql("# My unsaved notes");
    await openProjectFile("docs/notes.md", "# External edit", sync);
    expect(editorValue()).toBe("# My unsaved notes");
    expect(tabs().filter((t) => t.textContent === "notes.md")).toHaveLength(1);
    const docs = await (await fetch("/api/editor-documents")).json();
    expect(
      docs.some(
        (d: { sql: string }) =>
          d.sql.includes("Notes") || d.sql.includes("notes"),
      ),
    ).toBe(false);
  });
  it("writes SQL project files to disk without creating a saved query", async () => {
    let saved: Record<string, unknown> | undefined;
    let queryWrites = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        editorApi(
          async (path, options) => {
            if (
              path === "/api/project/file?path=sql%2Freport.sql" &&
              options.method === "PUT"
            ) {
              saved = JSON.parse(options.body as string);
              return new Response(
                JSON.stringify({
                  ...projectFile("sql/report.sql", saved!.content as string),
                  revision: "disk-v2",
                }),
              );
            }
            if (path.startsWith("/api/queries") && options.method)
              queryWrites++;
            return new Response("[]");
          },
          () => props.workspaceId,
        ),
      ),
    );
    await openProjectFile("sql/report.sql", "select 1");
    expect(container.querySelector(".run-button")).not.toBeNull();
    await editSql("select 2");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить SQL-файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    expect(saved).toEqual({ content: "select 2", baseRevision: "disk-v1" });
    expect(queryWrites).toBe(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("retains text edits after a disk revision conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        editorApi(
          async (path, options) => {
            if (
              path.startsWith("/api/project/file?") &&
              options.method === "PUT"
            ) {
              return new Response(
                JSON.stringify({
                  error: {
                    code: "FILE_REVISION_CONFLICT",
                    message: "Файл изменён на диске",
                  },
                }),
                { status: 409 },
              );
            }
            return new Response("[]");
          },
          () => props.workspaceId,
        ),
      ),
    );
    await openProjectFile("notes.md", "before");
    await editSql("my edits");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    expect(editorValue()).toBe("my edits");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "диске",
    );
    expect(
      localStorage.getItem("miracle:project-files:source-tab-test"),
    ).toContain("my edits");
  });
  it("refreshes a clean SQL file on reopen while keeping one tab bound to the new revision", async () => {
    let saved: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        editorApi(
          async (path, options) => {
            if (
              path.startsWith("/api/project/file?") &&
              options.method === "PUT"
            ) {
              saved = JSON.parse(options.body as string);
              return new Response(
                JSON.stringify({
                  ...projectFile("query.sql", saved!.content as string),
                  revision: "disk-v3",
                }),
              );
            }
            return new Response("[]");
          },
          () => props.workspaceId,
        ),
      ),
    );
    await openProjectFile("query.sql", "select 1");
    props = {
      ...props,
      fileToOpen: {
        ...projectFile("query.sql", "select 2"),
        revision: "disk-v2",
      },
    };
    await act(async () => root.render(createElement(SqlWorkspace, props)));
    expect(editorValue()).toBe("select 2");
    expect(tabs().filter((t) => t.textContent === "query.sql")).toHaveLength(1);
    await editSql("select 3");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить SQL-файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    expect(saved).toEqual({ content: "select 3", baseRevision: "disk-v2" });
  });
  it("keeps edits made during a file save and advances only the disk revision", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writes: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        editorApi(
          async (path, options) => {
            if (
              path.startsWith("/api/project/file?") &&
              options.method === "PUT"
            ) {
              const body = JSON.parse(options.body as string);
              writes.push(body);
              if (writes.length === 1) await pending;
              return new Response(
                JSON.stringify({
                  ...projectFile("notes.md", body.content),
                  revision: `disk-v${writes.length + 1}`,
                }),
              );
            }
            return new Response("[]");
          },
          () => props.workspaceId,
        ),
      ),
    );
    await openProjectFile("notes.md", "old");
    await editSql("first save");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    await editSql("newer draft");
    await act(async () => release());
    expect(editorValue()).toBe("newer draft");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    expect(writes).toEqual([
      { content: "first save", baseRevision: "disk-v1" },
      { content: "newer draft", baseRevision: "disk-v2" },
    ]);
  });
  it("restores a SQL disk binding and dirty draft across a workspace remount", async () => {
    let saved: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        editorApi(
          async (path, options) => {
            if (
              path.startsWith("/api/project/file?") &&
              options.method === "PUT"
            ) {
              saved = JSON.parse(options.body as string);
              return new Response(
                JSON.stringify({
                  ...projectFile("query.sql", saved!.content as string),
                  revision: "disk-v2",
                }),
              );
            }
            return new Response("[]");
          },
          () => props.workspaceId,
        ),
      ),
    );
    await openProjectFile("query.sql", "select 1");
    await editSql("select my_draft");
    await act(async () => root.unmount());
    root = createRoot(container);
    props = { ...props, fileToOpen: null };
    await act(async () => root.render(createElement(SqlWorkspace, props)));
    await readyEditor();
    expect(activeTab()).toBe("query.sql");
    expect(editorValue()).toBe("select my_draft");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить SQL-файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    expect(saved).toEqual({
      content: "select my_draft",
      baseRevision: "disk-v1",
    });
  });
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
    expect(editorValue()).toBe("select agent_update");
    expect(savedQuery).toBeUndefined();
    await clickTab("other.sql");
    await act(async () => releaseFlush());
    expect(savedQuery).toMatchObject({
      path: "/api/queries/saved-query",
      body: { sql: "select agent_update", baseRevision: 2 },
    });
    expect(activeTab()).toBe("other.sql");
    expect(editorValue()).toBe("select 2");
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
      const markdown = markdownView();
      if (markdown) {
        markdown.dispatch({
          changes: { from: 0, to: markdown.state.doc.length, insert: value },
        });
      } else {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!.call(editor(), value);
        editor().dispatchEvent(new Event("input", { bubbles: true }));
      }
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
    expect(editorValue()).toBe("");
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
    expect(editorValue()).toBe("");
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
    expect(editorValue()).toBe("select preserved_local_edit");
    await act(async () => root.unmount());
    root = createRoot(container);
    props.workspaceId = "different-workspace";
    await render();
    expect(editorValue()).toBe("");
    expect(tabs()).toHaveLength(1);
    expect(
      localStorage.getItem("miracle:sql-recovery:source-tab-test"),
    ).toContain("select preserved_local_edit");
  });

  it("opens the literal chart title and its pinned SQL and query context", async () => {
    await render({ source, name: "Выручка / месяц" });
    expect(activeTab()).toBe("Выручка / месяц");
    expect(editorValue()).toBe(source.sql);
    expect(context("Каталог запроса")).toBe("analytics");
    expect(context("Схема запроса")).toBe("finance");
    expect(props.onConnectionChange).toHaveBeenCalledWith("trino");
    expect(props.onSourceConsumed).toHaveBeenCalledOnce();
  });

  it("reactivates a chart tab after switching away and preserves edited SQL", async () => {
    await render({ source, name: "Выручка" });
    await editSql("select my_unsaved_edit");
    expect(editorValue()).toBe("select my_unsaved_edit");
    await clickTab("query_1.sql");
    await render({
      source: { ...source, sql: "select changed_pinned_source" },
      name: "Выручка",
    });
    expect(activeTab()).toBe("Выручка");
    expect(editorValue()).toBe("select my_unsaved_edit");
    expect(tabs()).toHaveLength(2);
  });

  it("reuses an exact existing name across sources without replacing its draft or connection", async () => {
    seed("Выручка");
    await render({ source, name: "Выручка" });
    expect(activeTab()).toBe("Выручка");
    expect(tabs()).toHaveLength(2);
    expect(editorValue()).toBe("select unsaved_draft");
    expect(context("База запроса")).toBe("private_draft");
    expect(props.onConnectionChange).toHaveBeenLastCalledWith("clickhouse");
  });

  it("keeps a literal .sql title and does not treat the unsuffixed title as the same name", async () => {
    seed("Выручка");
    await render({ source, name: "Выручка.sql" });
    expect(activeTab()).toBe("Выручка.sql");
    expect(tabs()).toHaveLength(3);
    expect(tabs().map((tab) => tab.textContent)).toContain("Выручка");
    expect(editorValue()).toBe(source.sql);
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
    expect(editorValue()).toBe("select fallback_draft");
    expect(tabs()).toHaveLength(2);
  });

  it("retains source.sql for unnamed source requests", async () => {
    await render({ source });
    expect(activeTab()).toBe("source.sql");
    expect(editorValue()).toBe(source.sql);
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
    expect(editorValue()).toBe("select unsaved_draft");
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
