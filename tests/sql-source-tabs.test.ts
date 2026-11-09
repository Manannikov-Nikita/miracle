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
    options?: { readOnly?: boolean };
  }) =>
    createElement("textarea", {
      "aria-label": "Test SQL editor",
      value: p.value ?? p.defaultValue ?? "",
      readOnly: p.options?.readOnly,
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
    // jsdom has no layout API for ranges; CodeMirror measures them in its RAF.
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
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
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    vi.unstubAllGlobals();
  });
  async function render(request?: SqlSourceRequest) {
    props = { ...props, sourceToOpen: request ?? null };
    await act(async () => root.render(createElement(SqlWorkspace, props)));
    await readyEditor();
  }
  it("locks a linked saved query without blocking navigation to another SQL tab", async () => {
    seed("draft.sql", { queryId: "saved-query", revision: 1 });
    const sync = new ProjectSync();
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: sync },
          createElement(SqlWorkspace, props),
        ),
      ),
    );
    await readyEditor();
    await clickTab("draft.sql");
    await act(async () =>
      sync.receiveWorkSnapshot({
        revision: 1,
        locks: [
          {
            target: { kind: "query", id: "saved-query" },
            turnId: "turn",
            chatId: "chat",
            startedAt: "now",
          },
        ],
      }),
    );
    expect((editor() as HTMLTextAreaElement).readOnly).toBe(true);
    await openContextDialog();
    expect(
      document.querySelector<HTMLInputElement>('[aria-label="База запроса"]')
        ?.disabled,
    ).toBe(true);
    await closeContextDialog();
    expect(container.querySelector(".agent-work-indicator")?.textContent).toBe(
      "Агент работает",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Новый SQL-файл"]')!
        .click(),
    );
    expect((editor() as HTMLTextAreaElement).readOnly).toBe(false);
    await act(async () => tabs()[0].click());
    expect((editor() as HTMLTextAreaElement).readOnly).toBe(true);
    await act(async () => sync.receiveWorkSnapshot({ revision: 2, locks: [] }));
    expect((editor() as HTMLTextAreaElement).readOnly).toBe(false);
  });
  it("preserves SQL input queued in the same turn as an agent update", async () => {
    seed("draft.sql");
    const sync = new ProjectSync();
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: sync },
          createElement(SqlWorkspace, props),
        ),
      ),
    );
    await readyEditor();
    await clickTab("draft.sql");
    const documents = await (await fetch("/api/editor-documents")).json();
    const current = documents.find(
      (doc: { id: string }) => doc.id === "existing",
    );
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor(), "select queued_input");
      editor().dispatchEvent(new Event("input", { bubbles: true }));
      sync.emit({
        id: 1,
        type: "editor.updated",
        data: {
          ...current,
          revision: current.revision + 1,
          sql: "select agent_update",
        },
      });
    });
    expect(editorValue()).toBe("select queued_input");
    expect(container.textContent).toContain("Ваш черновик сохранён");
  });
  it("pauses a pending SQL autosave and an open save dialog until the claim is released", async () => {
    seed("draft.sql", { queryId: "saved-query", revision: 1 });
    const sync = new ProjectSync();
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: sync },
          createElement(SqlWorkspace, props),
        ),
      ),
    );
    await readyEditor();
    await clickTab("draft.sql");
    vi.useFakeTimers();
    try {
      await editSql("select paused_draft");
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Сохранить SQL-файл (⌘S / Ctrl+S)"]',
          )!
          .click(),
      );
      vi.mocked(fetch).mockClear();
      await act(async () =>
        sync.receiveWorkSnapshot({
          revision: 1,
          locks: [
            {
              target: { kind: "query", id: "saved-query" },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(600));
      await act(async () =>
        document
          .querySelector('[role="dialog"] form')!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([, options]) =>
              options?.method === "PATCH" || options?.method === "POST",
          ),
      ).toHaveLength(0);
      expect(editorValue()).toBe("select paused_draft");
      expect(
        localStorage.getItem("miracle:sql-recovery:source-tab-test"),
      ).toContain("select paused_draft");
      await act(async () =>
        sync.receiveWorkSnapshot({ revision: 2, locks: [] }),
      );
      const docs = await (await fetch("/api/editor-documents")).json();
      expect(
        docs.find((doc: { id: string }) => doc.id === "existing").sql,
      ).toBe("select paused_draft");
      expect(editorValue()).toBe("select paused_draft");
    } finally {
      vi.useRealTimers();
    }
  });
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
  function panelLayout() {
    return Object.fromEntries(
      ["editor", "results"].map((id) => [
        id,
        Number(
          container.querySelector<HTMLElement>(`#${id}[data-panel]`)?.style
            .flexGrow,
        ),
      ]),
    );
  }
  async function clickResultLayout(label: string) {
    const button = container.querySelector<HTMLButtonElement>(
      `.results-heading [aria-label="${label}"]`,
    );
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  }
  async function withMeasuredPanels(check: () => Promise<void>) {
    // jsdom has no layout. Give the real resizable panels a non-zero canvas so
    // their public resize actions are not deferred as if the group were hidden.
    const height = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-panel")
          ? Number(this.style.flexGrow || 50) * 8
          : 0;
      });
    try {
      await check();
    } finally {
      height.mockRestore();
    }
  }
  it("expands the result and restores the query and result on the second click", async () => {
    await withMeasuredPanels(async () => {
      await render();
      await clickResultLayout("Развернуть результат");
      expect(panelLayout()).toEqual({ editor: 0, results: 100 });
      await clickResultLayout("Восстановить запрос и результат");
      expect(panelLayout()).toEqual({ editor: 50, results: 50 });
      expect(
        container.querySelector('[aria-label="Развернуть результат"]'),
      ).not.toBeNull();
    });
  });
  it("restores a persisted maximized result and follows layout reset", async () => {
    await withMeasuredPanels(async () => {
      localStorage.setItem(
        "miracle:editor-layout:source-tab-test",
        JSON.stringify({ editor: 0, results: 100 }),
      );
      await render();
      expect(panelLayout()).toEqual({ editor: 0, results: 100 });
      await clickResultLayout("Восстановить запрос и результат");
      expect(panelLayout()).toEqual({ editor: 50, results: 50 });
      await clickResultLayout("Развернуть результат");
      expect(panelLayout()).toEqual({ editor: 0, results: 100 });
      await act(async () =>
        window.dispatchEvent(new Event("miracle:reset-layout")),
      );
      expect(panelLayout()).toEqual({ editor: 55, results: 45 });
      await clickResultLayout("Развернуть результат");
      expect(panelLayout()).toEqual({ editor: 0, results: 100 });
    });
  });
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
  it("opens a saved Markdown search hit in the existing dirty tab and reanchors its selection", async () => {
    const saved = "# Notes\n\nA needle in saved text.\n";
    const path = "docs/search.md";
    await openProjectFile(path, saved);
    const start = saved.indexOf("needle");
    await act(async () =>
      markdownView()!.dispatch({
        changes: { from: 0, insert: "Draft prefix\n" },
      }),
    );
    const dirty = editorValue();
    props.searchNavigation = {
      requestId: "markdown-hit",
      target: {
        kind: "file",
        path,
        revision: "disk-v1",
        match: {
          start,
          end: start + 6,
          text: "needle",
          before: saved.slice(0, start),
          after: saved.slice(start + 6),
        },
      },
    };
    props.onSearchNavigationConsumed = vi.fn();
    await openProjectFile(path, saved);
    // Let CodeMirror's scheduled DOM measurement run before unmounting.
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    expect(editorValue()).toBe(dirty);
    expect(tabs()).toHaveLength(2);
    expect(markdownView()!.state.selection.main.from).toBe(
      dirty.indexOf("needle"),
    );
    expect(markdownView()!.state.selection.main.to).toBe(
      dirty.indexOf("needle") + 6,
    );
    expect(props.onSearchNavigationConsumed).toHaveBeenCalledWith(
      "markdown-hit",
    );
    expect(props.onNotify).not.toHaveBeenCalled();
  });

  it("publishes exactly the open tab strip with file paths and live rename/close updates", async () => {
    seed("draft.sql");
    const sync = new ProjectSync();
    await openProjectFile("docs/notes.md", "# Notes", sync);
    await openProjectFile("sql/report.sql", "select report", sync);
    expect(sync.context()).toEqual({});
    expect(sync.editorTabs().map(({ name }) => name)).toEqual(
      tabs().map((tab) => tab.textContent),
    );
    expect(sync.editorTabs()).toEqual([
      { id: "existing", name: "draft.sql" },
      { id: "other", name: "other.sql" },
      { id: expect.any(String), name: "report.sql", path: "sql/report.sql" },
      { id: expect.any(String), name: "notes.md", path: "docs/notes.md" },
    ]);
    const documents = await (await fetch("/api/editor-documents")).json();
    const current = documents.find(
      (doc: { id: string }) => doc.id === "existing",
    );
    await act(async () =>
      sync.emit({
        id: 1,
        type: "editor.updated",
        data: {
          ...current,
          name: "renamed.sql",
          revision: current.revision + 1,
        },
      }),
    );
    expect(sync.editorTabs()[0].name).toBe("renamed.sql");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Закрыть вкладку notes.md"]',
        )!
        .click(),
    );
    expect(sync.editorTabs().map(({ name }) => name)).toEqual(
      tabs().map((tab) => tab.textContent),
    );
    expect(sync.editorTabs().some((tab) => tab.path === "docs/notes.md")).toBe(
      false,
    );
  });

  it.each([
    { fail: false, extension: "sql" },
    { fail: true, extension: "sql" },
    { fail: false, extension: "md" },
  ])(
    "flushes only explicitly referenced dirty native files before agent context ($extension / $fail)",
    async ({ fail, extension }) => {
      const writes: { path: string; content: string }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          editorApi(
            async (url, options) => {
              if (
                url.startsWith("/api/project/file?") &&
                options.method === "PUT"
              ) {
                const path = new URL(url, "http://localhost").searchParams.get(
                  "path",
                )!;
                const body = JSON.parse(String(options.body));
                writes.push({ path, content: body.content });
                return fail
                  ? new Response(
                      JSON.stringify({ error: "Revision conflict" }),
                      { status: 409 },
                    )
                  : new Response(
                      JSON.stringify({
                        ...projectFile(path, body.content),
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
      const sync = new ProjectSync();
      await openProjectFile("sql/unrelated.sql", "select original", sync);
      await editSql("select unrelated draft");
      const chosen = `sql/chosen.${extension}`;
      await openProjectFile(chosen, "select original", sync);
      await editSql("select latest chosen draft");
      await act(async () => {
        const pending = sync.prepare({ filePaths: [chosen] });
        if (fail) await expect(pending).rejects.toThrow(/сохранить/i);
        else
          await expect(pending).resolves.toMatchObject({ filePaths: [chosen] });
      });
      expect(writes).toEqual([
        { path: chosen, content: "select latest chosen draft" },
      ]);
      if (fail)
        expect(container.textContent).toContain("Файл изменён на диске");
    },
  );
  it.each([false, true])(
    "refreshes native agent file edits after release without losing a dirty draft (%s)",
    async (dirty) => {
      const sync = new ProjectSync();
      const path = "docs/notes.md";
      vi.stubGlobal(
        "fetch",
        vi.fn(
          editorApi(
            async (url) => {
              if (url.startsWith("/api/project/file?"))
                return new Response(
                  JSON.stringify({
                    ...projectFile(path, "# Agent version"),
                    revision: "disk-v2",
                  }),
                );
              return new Response("[]");
            },
            () => props.workspaceId,
          ),
        ),
      );
      await openProjectFile(path, "# Original", sync);
      if (dirty) await editSql("# My draft");
      await act(async () =>
        sync.receiveWorkSnapshot({
          revision: 1,
          locks: [
            {
              target: { kind: "file", id: path },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        }),
      );
      expect(markdownView()?.contentDOM.getAttribute("contenteditable")).toBe(
        "false",
      );
      await act(async () =>
        sync.receiveWorkSnapshot({ revision: 2, locks: [] }),
      );
      expect(editorValue()).toBe(dirty ? "# My draft" : "# Agent version");
      if (dirty)
        expect(container.textContent).toContain("Ваш черновик сохранён");
    },
  );
  it.each(["clean", "dirty", "removed"])(
    "refreshes native files after a Git branch switch and preserves %s drafts",
    async (state) => {
      const sync = new ProjectSync();
      const path = "sql/branch.sql";
      const gitStateChanged =
        vi.fn<NonNullable<typeof props.onGitEditorStateChange>>();
      props.onGitEditorStateChange = gitStateChanged;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          editorApi(
            async (url) => {
              if (url.startsWith("/api/project/file?"))
                return state === "removed"
                  ? new Response(JSON.stringify({ error: "Файл не найден" }), {
                      status: 404,
                    })
                  : new Response(
                      JSON.stringify({
                        ...projectFile(path, "select new_branch"),
                        revision: "disk-v2",
                      }),
                    );
              return new Response("[]");
            },
            () => props.workspaceId,
          ),
        ),
      );
      await openProjectFile(path, "select original", sync);
      const cleanGitState = gitStateChanged.mock.lastCall![0]!;
      expect(cleanGitState.hasUnsavedFiles).toBe(false);
      if (state === "dirty") await editSql("select my_draft");
      expect(gitStateChanged.mock.lastCall![0]!.hasUnsavedFiles).toBe(
        state === "dirty",
      );
      // The project-level button retains this callback across editor renders.
      // Its final guard must still see edits made after the callback was captured.
      if (state === "dirty")
        await expect(cleanGitState.onBeforeMutation()).rejects.toThrow(
          "Сначала сохраните",
        );
      else
        await expect(cleanGitState.onBeforeMutation()).resolves.toBeUndefined();
      if (state === "clean") await act(() => cleanGitState.onBranchChanged());
      else
        await act(async () =>
          sync.emit({
            id: 10,
            type: "git.changed",
            data: { action: "switch" },
          }),
        );
      expect(editorValue()).toBe(
        state === "clean"
          ? "select new_branch"
          : state === "dirty"
            ? "select my_draft"
            : "select original",
      );
      if (state === "dirty")
        expect(container.textContent).toContain("Ваш черновик сохранён");
      if (state === "removed")
        expect(container.textContent).toContain("Файл не найден");
    },
  );
  it("refreshes an agent native edit after a pre-lock file save reply arrives late", async () => {
    const sync = new ProjectSync();
    const path = "docs/notes.md";
    let finishSave!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        editorApi(
          async (url, options) => {
            if (url.startsWith("/api/project/file?")) {
              if (options.method === "PUT")
                return new Promise<Response>((done) => {
                  finishSave = done;
                });
              return new Response(
                JSON.stringify({
                  ...projectFile(path, "# Agent final"),
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
    await openProjectFile(path, "# Original", sync);
    await editSql("# User save");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Сохранить файл (⌘S / Ctrl+S)"]',
        )!
        .click(),
    );
    await act(async () =>
      sync.receiveWorkSnapshot({
        revision: 1,
        locks: [
          {
            target: { kind: "file", id: path },
            turnId: "turn",
            chatId: "chat",
            startedAt: "now",
          },
        ],
      }),
    );
    await act(async () => sync.receiveWorkSnapshot({ revision: 2, locks: [] }));
    await act(async () =>
      finishSave(
        new Response(
          JSON.stringify({
            ...projectFile(path, "# User save"),
            revision: "disk-v2",
          }),
        ),
      ),
    );
    expect(editorValue()).toBe("# Agent final");
  });
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
  it("keeps a successful query association when its response arrives under an agent claim", async () => {
    const sync = new ProjectSync();
    let complete!: () => void;
    const backend = editorApi(
      async (path, options) => {
        if (path === "/api/queries" && options.method === "POST") {
          const saved = {
            ...JSON.parse(options.body as string),
            id: "saved-query",
            revision: 1,
          };
          return new Promise<Response>((resolve) => {
            complete = () => resolve(new Response(JSON.stringify(saved)));
          });
        }
        return new Response("[]");
      },
      () => props.workspaceId,
    );
    vi.stubGlobal("fetch", vi.fn(backend));
    seed("draft.sql");
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: sync },
          createElement(SqlWorkspace, props),
        ),
      ),
    );
    await readyEditor();
    await clickTab("draft.sql");
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
    await act(async () =>
      sync.receiveWorkSnapshot({
        revision: 1,
        locks: [
          {
            target: { kind: "editor", id: "existing" },
            turnId: "turn",
            chatId: "chat",
            startedAt: "now",
          },
        ],
      }),
    );
    const docs = await (await backend("/api/editor-documents")).json();
    const current = docs.find((doc: { id: string }) => doc.id === "existing");
    const changed = await backend("/api/editor-documents/existing", {
      method: "PATCH",
      body: JSON.stringify({
        baseRevision: current.revision,
        name: "agent.sql",
        sql: "select agent_sql",
      }),
    });
    await act(async () =>
      sync.emit({ id: 2, type: "editor.updated", data: await changed.json() }),
    );
    await act(async () => complete());
    const recovery = JSON.parse(
      localStorage.getItem("miracle:sql-recovery:source-tab-test") || "[]",
    );
    expect(
      recovery.find((doc: { id: string }) => doc.id === "existing"),
    ).toMatchObject({
      queryId: "saved-query",
      revision: 1,
      name: "agent.sql",
      sql: "select agent_sql",
    });
    await act(async () => sync.receiveWorkSnapshot({ revision: 3, locks: [] }));
    const saved = await (await backend("/api/editor-documents")).json();
    expect(
      saved.find((doc: { id: string }) => doc.id === "existing"),
    ).toMatchObject({
      queryId: "saved-query",
      queryRevision: 1,
      name: "agent.sql",
      sql: "select agent_sql",
    });
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
  async function openContextDialog() {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="Действия SQL"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () =>
      trigger!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((entry) => entry.textContent?.trim() === "Контекст запроса");
    expect(item).toBeDefined();
    await act(async () => item!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Контекст запроса",
    );
  }
  async function closeContextDialog() {
    const done = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.trim() === "Готово");
    expect(done).toBeDefined();
    await act(async () => done!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  }
  function context(label: string) {
    return document.querySelector<HTMLInputElement>(
      `[role="dialog"] [aria-label="${label}"]`,
    )?.value;
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
        .mock.calls.every(
          ([path, options]) =>
            String(path).startsWith("/api/editor-documents") ||
            (String(path) === "/api/project/git" &&
              (options?.method ?? "GET") === "GET"),
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
    expect(container.querySelector(".query-context")).toBeNull();
    await openContextDialog();
    expect(context("Каталог запроса")).toBe("analytics");
    expect(context("Схема запроса")).toBe("finance");
    await closeContextDialog();
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
    await openContextDialog();
    expect(context("База запроса")).toBe("private_draft");
    await closeContextDialog();
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
    await openContextDialog();
    expect(context("База запроса")).toBe("my-draft-database");
    await closeContextDialog();
    expect(container.textContent).toContain("Ваш черновик сохранён");
  });
});
