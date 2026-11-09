// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import SqlWorkspace from "../src/client/components/SqlWorkspace";
import { createMetadataStore } from "../src/client/metadata-store";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import type { EditorDocument } from "../src/shared/agents";

const harness = vi.hoisted(() => ({
  value: "",
  readOnly: false,
  selection: {
    startLineNumber: 2,
    startColumn: 4,
    endLineNumber: 2,
    endColumn: 4,
  },
  scroll: 184,
  rejectedEdits: 0,
  reveals: 0,
  focuses: 0,
  modelAvailable: true,
  undo: () => {},
  type: (_value: string) => {},
}));

// Model lifetime and readOnly match Monaco: defaultValue is initial-only, editor
// edits are rejected while locked, but authoritative model edits still work.
vi.mock("@monaco-editor/react", async () => {
  const { useEffect, useRef, useState } = await import("react");
  return {
    loader: { config() {} },
    default: (props: {
      defaultValue: string;
      path: string;
      onMount: (editor: unknown) => void;
      onChange: (value: string) => void;
      options: { readOnly: boolean };
    }) => {
      const latest = useRef(props);
      latest.current = props;
      const [, redraw] = useState(0);
      const initial = useRef(false);
      if (!initial.current) {
        initial.current = true;
        harness.value = props.defaultValue;
      }
      useEffect(() => {
        harness.readOnly = props.options.readOnly;
      }, [props.options]);
      useEffect(() => {
        type Edit = { range: typeof harness.selection; text: string };
        const undo: string[] = [];
        const offset = (lineNumber: number, column: number) =>
          harness.value
            .split("\n")
            .slice(0, lineNumber - 1)
            .reduce((n, line) => n + line.length + 1, 0) +
          column -
          1;
        const changed = () => {
          latest.current.onChange(harness.value);
          redraw((n) => n + 1);
        };
        const apply = (edits: Edit[]) => {
          undo.push(harness.value);
          for (const { range, text } of [...edits].reverse()) {
            const start = offset(range.startLineNumber, range.startColumn);
            const end = offset(range.endLineNumber, range.endColumn);
            harness.value =
              harness.value.slice(0, start) + text + harness.value.slice(end);
          }
          changed();
        };
        const model = {
          uri: { toString: () => latest.current.path },
          getValue: () => harness.value,
          getValueInRange: () => "",
          getOffsetAt: (position: { lineNumber: number; column: number }) =>
            offset(position.lineNumber, position.column),
          getPositionAt: (index: number) => {
            const lines = harness.value.slice(0, index).split("\n");
            return {
              lineNumber: lines.length,
              column: lines.at(-1)!.length + 1,
            };
          },
          pushStackElement() {},
          pushEditOperations: (
            _before: unknown,
            edits: Edit[],
            compute: () => unknown,
          ) => {
            apply(edits);
            return compute();
          },
        };
        harness.undo = () => {
          if (harness.readOnly || !undo.length) return;
          harness.value = undo.pop()!;
          changed();
        };
        harness.type = (value) => {
          if (harness.readOnly) return;
          harness.value = value;
          changed();
        };
        props.onMount({
          getModel: () => (harness.modelAvailable ? model : null),
          getSelection: () => harness.selection,
          getSelections: () => [harness.selection],
          setSelection: (selection: typeof harness.selection) => {
            harness.selection = selection;
          },
          getScrollTop: () => harness.scroll,
          setScrollTop: (scroll: number) => {
            harness.scroll = scroll;
          },
          getPosition: () => ({ lineNumber: 2, column: 4 }),
          setPosition() {},
          revealRangeInCenter() {
            harness.reveals++;
          },
          focus() {
            harness.focuses++;
          },
          addCommand() {},
          addAction() {},
          onDidChangeCursorPosition() {},
          onDidChangeCursorSelection() {},
          onDidChangeModel() {},
          onDidScrollChange() {},
          pushUndoStop: () => !harness.readOnly,
          executeEdits: (_source: string, edits: Edit[]) => {
            if (harness.readOnly) {
              harness.rejectedEdits++;
              return false;
            }
            apply(edits);
            return true;
          },
        });
      }, []);
      return createElement("textarea", {
        "aria-label": "Monaco model",
        value: harness.value,
        readOnly: true,
      });
    },
  };
});
vi.mock("monaco-editor/editor/editor.api.js", () => ({
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  },
  editor: { defineTheme() {} },
  KeyMod: { CtrlCmd: 1, Alt: 2 },
  KeyCode: { Enter: 3, KeyL: 4, KeyS: 5 },
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

const workspaceId = "agent-monaco-refresh";
const original = "SELECT 1 AS value;\nSELECT 9 AS unchanged;";
let document: EditorDocument;
let project: ProjectSync;
let container: HTMLDivElement;
let root: Root;
let props: ComponentProps<typeof SqlWorkspace>;
let writes: unknown[];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value() {},
  });
  const storage = new Map([[`miracle:sql-tabs:${workspaceId}:imported`, "1"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  document = {
    id: "editor",
    name: "query.sql",
    connectionId: "c",
    sql: original,
    queryId: "saved-query",
    queryRevision: 1,
    revision: 1,
    updatedAt: "now",
  };
  writes = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit = {}) => {
      if (path === "/api/editor-documents" && !options.method)
        return new Response(JSON.stringify([document]));
      if (
        path === "/api/editor-documents/editor" &&
        options.method === "PATCH"
      ) {
        const body = JSON.parse(options.body as string);
        writes.push(body);
        document = { ...document, ...body, revision: document.revision + 1 };
        return new Response(JSON.stringify(document));
      }
      throw new Error(`Unexpected request ${path}`);
    }),
  );
  harness.value = "";
  harness.readOnly = false;
  harness.scroll = 184;
  harness.rejectedEdits = 0;
  harness.reveals = 0;
  harness.focuses = 0;
  harness.modelAvailable = true;
  harness.selection = {
    startLineNumber: 2,
    startColumn: 4,
    endLineNumber: 2,
    endColumn: 4,
  };
  project = new ProjectSync();
  props = {
    workspaceId,
    connections: [
      {
        id: "c",
        name: "ClickHouse",
        engine: "clickhouse",
        url: "http://db",
        username: "reader",
        hasPassword: false,
      },
    ],
    activeConnectionId: "c",
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
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        ProjectSyncContext.Provider,
        { value: project },
        createElement(SqlWorkspace, props),
      ),
    ),
  );
  expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
    original,
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  props.metadata.dispose();
  container.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function claim() {
  await act(async () =>
    project.receiveWorkSnapshot({
      revision: 1,
      locks: [
        {
          target: { kind: "editor", id: "editor" },
          turnId: "turn",
          chatId: "chat",
          startedAt: "now",
        },
      ],
    }),
  );
  expect(harness.readOnly).toBe(true);
}
async function receive(sql: string, revision: number) {
  document = { ...document, sql, revision };
  await act(async () =>
    project.emit({
      id: revision + 1,
      type: "editor.updated",
      entityId: document.id,
      data: document,
    }),
  );
}
async function release() {
  await act(async () =>
    project.receiveWorkSnapshot({ revision: 10, locks: [] }),
  );
  expect(harness.readOnly).toBe(false);
}
const visibleSql = () =>
  container.querySelector<HTMLTextAreaElement>("textarea")!.value;

it("updates the existing read-only Monaco model while the agent owns the editor, retaining view and undo", async () => {
  const selection = { ...harness.selection };
  await claim();
  const updated = original.replace("SELECT 1", "SELECT 42");
  await receive(updated, 2);
  expect(visibleSql()).toBe(updated);
  expect(harness.readOnly).toBe(true);
  expect(harness.selection).toEqual(selection);
  expect(harness.scroll).toBe(184);
  await release();
  expect(visibleSql()).toBe(updated);
  await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(writes).toEqual([]);
  await act(async () => harness.undo());
  expect(visibleSql()).toBe(original);
});

it("keeps the latest agent text after unlock and does not replay a stale revision over subsequent typing", async () => {
  await claim();
  await receive("SELECT 2;", 2);
  await receive("SELECT 3;", 3);
  await release();
  expect(visibleSql()).toBe("SELECT 3;");
  await act(async () => harness.type("SELECT 3; -- local draft"));
  await act(async () =>
    project.emit({
      id: 20,
      type: "editor.updated",
      entityId: document.id,
      data: { ...document, revision: 2, sql: "SELECT 2;" },
    }),
  );
  expect(visibleSql()).toBe("SELECT 3; -- local draft");
});

async function revealSavedQuery(requestId: string, text = "unchanged") {
  const start = original.indexOf(text);
  props = {
    ...props,
    searchNavigation: {
      requestId,
      target: {
        kind: "query",
        id: "saved-query",
        revision: 1,
        match: {
          start,
          end: start + text.length,
          text,
          before: original.slice(Math.max(0, start - 24), start),
          after: original.slice(start + text.length, start + text.length + 24),
        },
      },
    },
    onSearchNavigationConsumed: vi.fn(),
  };
  await act(async () =>
    root.render(
      createElement(
        ProjectSyncContext.Provider,
        { value: project },
        createElement(SqlWorkspace, props),
      ),
    ),
  );
}

it("reveals a saved-query match without editing and can repeat the same navigation", async () => {
  await revealSavedQuery("first");
  expect(harness.selection).toEqual({
    startLineNumber: 2,
    startColumn: 13,
    endLineNumber: 2,
    endColumn: 22,
  });
  expect(harness.reveals).toBe(1);
  expect(harness.focuses).toBe(1);
  expect(visibleSql()).toBe(original);
  expect(writes).toEqual([]);
  expect(props.onSearchNavigationConsumed).toHaveBeenCalledWith("first");
  await revealSavedQuery("second");
  expect(harness.reveals).toBe(2);
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
});

it("keeps an open SQL draft and does not jump to a stale saved match", async () => {
  await act(async () => harness.type("SELECT local_draft;"));
  const selection = { ...harness.selection };
  await revealSavedQuery("changed");
  expect(visibleSql()).toBe("SELECT local_draft;");
  expect(harness.selection).toEqual(selection);
  expect(harness.reveals).toBe(0);
  expect(props.onNotify).toHaveBeenCalledWith(
    expect.stringContaining("сохранённой версии"),
    "info",
  );
});

it("reveals SQL after restoring a maximized result to half the window", async () => {
  const height = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-panel")
        ? Number(this.style.flexGrow || 50) * 8
        : 0;
    });
  try {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Развернуть результат"]',
        )!
        .click(),
    );
    expect(
      container.querySelector<HTMLElement>("#editor[data-panel]")!.style
        .flexGrow,
    ).toBe("0");
    await revealSavedQuery("maximized");
    expect(
      container.querySelector<HTMLElement>("#editor[data-panel]")!.style
        .flexGrow,
    ).toBe("50");
    expect(
      container.querySelector<HTMLElement>("#results[data-panel]")!.style
        .flexGrow,
    ).toBe("50");
    expect(harness.reveals).toBe(1);
  } finally {
    height.mockRestore();
  }
});

it("cancels a pending reveal when the user switches to another SQL tab", async () => {
  harness.modelAvailable = false;
  await revealSavedQuery("pending");
  expect(harness.reveals).toBe(0);
  expect(props.onSearchNavigationConsumed).not.toHaveBeenCalled();
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Новый SQL-файл"]')!
      .click(),
  );
  expect(props.onSearchNavigationConsumed).toHaveBeenCalledWith("pending");
  harness.modelAvailable = true;
  await act(async () =>
    root.render(
      createElement(
        ProjectSyncContext.Provider,
        { value: project },
        createElement(SqlWorkspace, { ...props }),
      ),
    ),
  );
  expect(harness.reveals).toBe(0);
  expect(harness.focuses).toBe(0);
});
