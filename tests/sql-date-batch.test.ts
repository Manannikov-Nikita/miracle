// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImmediate as yieldIO } from "node:timers/promises";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { editorApi } from "./helpers/editor-api";
import SqlWorkspace from "../src/client/components/SqlWorkspace";
import { createMetadataStore } from "../src/client/metadata-store";
import type { QueryRun, ResultSet } from "../src/shared/types";

const harness = vi.hoisted(() => ({
  value: "",
  path: "",
  cursor: 0,
  selection: "",
  positionChanged: undefined as undefined | (() => void),
  selected: undefined as undefined | (() => void),
  enter: undefined as undefined | (() => void),
}));
vi.mock("@monaco-editor/react", async () => {
  const { useEffect } = await import("react");
  return {
    loader: { config() {} },
    default: (props: {
      value?: string;
      defaultValue?: string;
      path: string;
      onMount: (editor: unknown) => void;
    }) => {
      harness.value = props.value ?? props.defaultValue ?? "";
      harness.path = props.path;
      useEffect(() => {
        const model = {
          uri: { toString: () => harness.path },
          getValue: () => harness.value,
          getValueInRange: () => harness.selection,
          getOffsetAt: () => harness.cursor,
        };
        props.onMount({
          getModel: () => model,
          getSelection: () => ({}),
          getPosition: () => ({ lineNumber: 1, column: harness.cursor + 1 }),
          addCommand: (_: number, callback: () => void) => {
            harness.enter ||= callback;
          },
          addAction() {},
          onDidChangeCursorPosition: (callback: (value: unknown) => void) => {
            harness.positionChanged = () =>
              callback({
                position: { lineNumber: 1, column: harness.cursor + 1 },
              });
          },
          onDidChangeCursorSelection: (callback: () => void) => {
            harness.selected = callback;
          },
          onDidChangeModel() {},
          onDidScrollChange() {},
          setPosition() {},
          setScrollTop() {},
        });
      }, []);
      return createElement("textarea", {
        value: props.value,
        readOnly: true,
        "aria-label": "Test SQL",
      });
    },
  };
});
vi.mock("monaco-editor/editor/editor.api.js", () => ({
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
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 30,
        end: (index + 1) * 30,
      })),
    getTotalSize: () => count * 30,
  }),
}));
let root: Root;
let container: HTMLDivElement;
let metadata: ReturnType<typeof createMetadataStore>;
let requests: { path: string; options: RequestInit }[];
let currentRun: QueryRun;
let currentResult: ResultSet;
const workspaceId = "date-batch-ui";
const source = {
  connectionId: "c",
  sql: "SELECT {{date}} AS day",
  database: "demo",
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
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
  metadata = createMetadataStore(async <T>() => ({ items: [] }) as T);
  currentRun = {
    id: "run",
    source,
    status: "running",
    startedAt: "2026-10-30",
    batch: {
      total: 2,
      completed: 0,
      succeeded: 0,
      failed: 0,
      currentDate: "2026-10-01",
      attempt: 1,
      items: [],
    },
  };
  currentResult = {
    id: "result",
    source,
    rowCount: 1,
    byteCount: 10,
    createdAt: "2026-10-30",
    columns: [{ id: "day", name: "day", type: "String" }],
  };
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      editorApi(
        async (path: string, options: RequestInit = {}) => {
          requests.push({ path, options });
          if (path === "/api/query-runs" && options.method === "POST") {
            currentRun = {
              ...currentRun,
              source: JSON.parse(options.body as string),
            };
            return new Response(JSON.stringify(currentRun));
          }
          if (path === "/api/query-runs/run")
            return new Response(JSON.stringify(currentRun));
          if (path === "/api/result-sets/result")
            return new Response(JSON.stringify(currentResult));
          if (path.startsWith("/api/result-sets/result/rows"))
            return new Response(
              JSON.stringify({
                result: currentResult,
                rows: Array.from({ length: currentResult.rowCount }, (_, i) => [
                  `2026-10-0${i + 1}`,
                ]),
                offset: 0,
                total: currentResult.rowCount,
              }),
            );
          if (path === "/api/query-runs/run/cancel") {
            currentRun = { ...currentRun, status: "cancelled" };
            return new Response(JSON.stringify(currentRun));
          }
          throw new Error(`Unexpected request ${path}`);
        },
        () => workspaceId,
      ),
    ),
  );
  harness.value = "";
  harness.path = "";
  harness.selection = "";
  harness.cursor = 0;
  harness.enter = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  metadata.dispose();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
async function render(sql = source.sql) {
  localStorage.setItem(
    `miracle:sql-tabs:${workspaceId}`,
    JSON.stringify([{ ...source, sql, id: "tab", name: "date.sql" }]),
  );
  await act(async () =>
    root.render(
      createElement(SqlWorkspace, {
        workspaceId,
        connections: [
          {
            id: "c",
            name: "ClickHouse",
            engine: "clickhouse",
            url: "http://test",
            username: "reader",
            hasPassword: false,
            database: "demo",
          },
        ],
        activeConnectionId: "c",
        metadata,
        onConnectionChange() {},
        onSourceConsumed() {},
        onSavedConsumed() {},
        onQueriesChanged() {},
        onResult() {},
        onNotify() {},
        onOpenConnections() {},
        onMaximize() {},
        onCollapse() {},
      }),
    ),
  );
  // Native WebCrypto used by migration is independent of Vitest's fake clock.
  // Yield real I/O and wait for the editor instead of assuming render() loaded it.
  await vi.waitFor(async () => {
    await act(async () => {
      await yieldIO();
    });
    expect(
      container.querySelector('[aria-label="Test SQL"]'),
      container.textContent || "SQL editor not ready",
    ).not.toBeNull();
  });
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(label),
  )!;
}
async function input(label: string, value: string) {
  const node = document.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function start() {
  await act(async () => button("По датам").click());
  await input("Начало диапазона", "2026-10-01");
  await input("Конец диапазона", "2026-10-02");
  await act(async () => button("Запустить").click());
}

describe("SQL batch execution", () => {
  it.each(["new result", "failure"])(
    "labels retained previous rows during a new run ending in %s",
    async (outcome) => {
      await render();
      await start();
      currentRun = {
        ...currentRun,
        status: "completed",
        resultSetId: "result",
        rowCount: 1,
        batch: { ...currentRun.batch!, completed: 2, succeeded: 2 },
      };
      await act(async () => vi.advanceTimersByTimeAsync(650));
      expect(container.textContent).toContain("2026-10-01");
      const originalFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string, options: RequestInit = {}) => {
          if (path === "/api/query-runs/next")
            return new Response(JSON.stringify(currentRun));
          if (path === "/api/result-sets/next")
            return new Response(JSON.stringify(currentResult));
          if (path.startsWith("/api/result-sets/next/rows"))
            return new Response(
              JSON.stringify({
                result: currentResult,
                rows: [["2026-11-01"]],
                offset: 0,
                total: 1,
              }),
            );
          return originalFetch(path, options);
        }),
      );
      currentRun = {
        ...currentRun,
        id: "next",
        status: "running",
        resultSetId: undefined,
        rowCount: undefined,
        batch: { ...currentRun.batch!, completed: 0, succeeded: 0 },
      };
      await start();
      expect(container.textContent).toContain(
        "Показан результат предыдущего запуска",
      );
      expect(container.textContent).toContain("2026-10-01");
      if (outcome === "failure") {
        currentRun = {
          ...currentRun,
          status: "failed",
          error: "Source unavailable",
          batch: { ...currentRun.batch!, completed: 2, failed: 2 },
        };
        await act(async () => vi.advanceTimersByTimeAsync(650));
        expect(container.textContent).toContain(
          "Показан результат предыдущего запуска",
        );
        expect(container.querySelector(".result-table")?.textContent).toContain(
          "2026-10-01",
        );
        expect(container.textContent).toContain("Source unavailable");
        return;
      }
      currentResult = { ...currentResult, id: "next" };
      currentRun = {
        ...currentRun,
        resultSetId: "next",
        rowCount: 1,
        batch: { ...currentRun.batch!, completed: 1, succeeded: 1 },
      };
      await act(async () => vi.advanceTimersByTimeAsync(650));
      expect(container.textContent).not.toContain(
        "Показан результат предыдущего запуска",
      );
      expect(
        container.querySelector(".result-table")?.textContent,
      ).not.toContain("2026-10-01");
      expect(container.textContent).toContain("2026-11-01");
    },
  );
  it.each([
    [
      "failed",
      "Не удалось выполнить 1 из 2 дат. Успешные результаты сохранены.",
      false,
    ],
    ["cancelled", "Пакет остановлен. Успешные результаты сохранены.", false],
    [
      "failed",
      "Квота хранения результатов исчерпана. Пакет остановлен; предыдущие результаты сохранены.",
      true,
    ],
  ] as const)(
    "keeps one partial-result notice after %s and preserves a specific error: %s",
    async (status, error, visible) => {
      await render();
      await start();
      currentRun = {
        ...currentRun,
        status,
        error,
        resultSetId: "result",
        rowCount: 1,
        batch: {
          ...currentRun.batch!,
          completed: 2,
          succeeded: 1,
          failed: status === "failed" ? 1 : 0,
        },
      };
      await act(async () => vi.advanceTimersByTimeAsync(650));
      expect(container.textContent).toContain(
        "В таблице сохранены результаты успешных дат.",
      );
      expect(container.textContent).not.toContain(
        "Показаны результаты успешных дат.",
      );
      expect(container.textContent?.includes(error)).toBe(visible);
      expect(container.querySelector(".result-table")?.textContent).toContain(
        "2026-10-01",
      );
    },
  );
  it("does not restart polling when a launch response arrives after unmount", async () => {
    await render();
    const originalFetch = globalThis.fetch;
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === "/api/query-runs" && options.method === "POST") {
          requests.push({ path, options });
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        }
        return originalFetch(path, options);
      }),
    );
    await start();
    await act(async () => root.render(null));
    await act(async () => finish(new Response(JSON.stringify(currentRun))));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(
      requests.filter((request) => request.path === "/api/query-runs/run"),
    ).toHaveLength(0);
  });
  it("recovers from a transient aggregate fetch failure and clears the connection error", async () => {
    await render();
    await start();
    const originalFetch = globalThis.fetch;
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === "/api/result-sets/result" && fail) {
          fail = false;
          throw new Error("Connection interrupted");
        }
        return originalFetch(path, options);
      }),
    );
    currentRun = {
      ...currentRun,
      resultSetId: "result",
      rowCount: 1,
      batch: { ...currentRun.batch!, completed: 1, succeeded: 1 },
    };
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(container.textContent).toContain("Connection interrupted");
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(container.textContent).toContain("2026-10-01");
    expect(container.textContent).not.toContain("Connection interrupted");
    currentRun = {
      ...currentRun,
      status: "completed",
      batch: { ...currentRun.batch!, completed: 2, succeeded: 2 },
    };
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(button("На доску").disabled).toBe(false);
  });
  it("offers an explicit retry after a terminal result cannot be loaded", async () => {
    await render();
    await start();
    const originalFetch = globalThis.fetch;
    let fail = true;
    let failedReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === "/api/result-sets/result" && fail) {
          failedReads++;
          return new Response(JSON.stringify({ error: "Result unavailable" }), {
            status: 404,
          });
        }
        return originalFetch(path, options);
      }),
    );
    currentRun = {
      ...currentRun,
      status: "completed",
      resultSetId: "result",
      rowCount: 1,
      batch: { ...currentRun.batch!, completed: 2, succeeded: 2 },
    };
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(container.textContent).toContain("Result unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(20000));
    expect(failedReads).toBe(1);
    fail = false;
    await act(async () => button("Обновить результат").click());
    expect(container.textContent).toContain("2026-10-01");
    expect(container.textContent).not.toContain("Result unavailable");
  });
  it("uses the executable selection/current statement for button and keyboard launch", async () => {
    await render("SELECT 1; SELECT {{date}} AS day");
    expect(button("Выполнить")).toBeDefined();
    harness.cursor = 25;
    await act(async () => harness.positionChanged?.());
    expect(button("По датам")).toBeDefined();
    harness.selection = "SELECT 7";
    await act(async () => harness.selected?.());
    expect(button("Выполнить")).toBeDefined();
    harness.selection = "SELECT {{date}} AS picked";
    await act(async () => {
      harness.selected?.();
      harness.enter?.();
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Запуск по датам",
    );
    expect(requests.filter((r) => r.options.method === "POST")).toHaveLength(0);
    await input("Начало диапазона", "2026-10-01");
    await input("Конец диапазона", "2026-10-02");
    await act(async () => button("Запустить").click());
    const posted = JSON.parse(
      requests.find((r) => r.options.method === "POST")!.options.body as string,
    );
    expect(posted.sql).toBe("SELECT {{date}} AS picked");
    expect(posted.dateRange).toEqual({
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      granularity: "day",
      retries: 2,
    });
  });
  it("shows successful rows before completion and retains the aggregate after later failure", async () => {
    await render();
    await start();
    currentRun = {
      ...currentRun,
      resultSetId: "result",
      rowCount: 1,
      batch: {
        ...currentRun.batch!,
        completed: 1,
        succeeded: 1,
        currentDate: "2026-10-02",
      },
    };
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(container.textContent).toContain("2026-10-01");
    expect(
      container
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("1");
    expect(button("На доску").disabled).toBe(true);
    currentRun = {
      ...currentRun,
      status: "failed",
      error: "One date failed",
      batch: {
        ...currentRun.batch!,
        completed: 2,
        failed: 1,
        items: [
          {
            date: "2026-10-02",
            status: "failed",
            attempts: 3,
            error: "Engine unavailable",
          },
        ],
      },
    };
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(container.textContent).toContain("2026-10-01");
    expect(container.textContent).toContain("результаты успешных дат");
    expect(button("На доску").disabled).toBe(false);
  });
});
