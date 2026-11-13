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
  editor: { defineTheme() {}, setModelLanguage() {} },
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
const notify = vi.fn();
const workspaceId = "date-batch-ui";
const source = {
  connectionId: "c",
  sql: "SELECT {{date}} AS day",
  database: "demo",
};
beforeEach(() => {
  vi.useFakeTimers();
  notify.mockReset();
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
          if (path === "/api/query-runs/run/resume") {
            currentRun = { ...currentRun, status: "running", error: undefined };
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
async function render(
  sql = source.sql,
  history?: QueryRun,
  { seed = true } = {},
) {
  if (seed)
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
        sourceToOpen: history
          ? { source: history.source, run: history }
          : undefined,
        metadata,
        onConnectionChange() {},
        onSourceConsumed() {},
        onSavedConsumed() {},
        onQueriesChanged() {},
        onResult() {},
        onNotify: notify,
        onOpenConnections() {},
        onMaximize() {},
        onCollapse() {},
      }),
    ),
  );
  // Native WebCrypto used by migration is independent of Vitest's fake clock.
  // Yield real I/O and wait for the editor instead of assuming render() loaded it.
  // On loaded CI, async act can exceed waitFor's default 1 s real-time budget.
  await vi.waitFor(
    async () => {
      await act(async () => {
        await yieldIO();
      });
      expect(
        container.querySelector('[aria-label="Test SQL"]'),
        container.textContent || "SQL editor not ready",
      ).not.toBeNull();
    },
    { timeout: 5000 },
  );
}
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) =>
      b.textContent?.includes(label) || b.getAttribute("aria-label") === label,
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

describe("SQL run error notifications", () => {
  const memoryError =
    "Code: 241. DB::Exception: Memory limit exceeded. (MEMORY_LIMIT_EXCEEDED)";
  const memoryTitle = "Запрос превысил доступный объём памяти.";

  async function openSuccessfulSibling() {
    const successful: QueryRun = {
      id: "successful-sibling",
      source: { ...source, sql: "SELECT 42 AS answer" },
      status: "completed",
      startedAt: "2026-10-30",
      finishedAt: "2026-10-30",
    };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === "/api/query-runs/successful-sibling")
          return new Response(JSON.stringify(successful));
        return originalFetch(path, options);
      }),
    );
    await render(successful.source.sql, successful, { seed: false });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(harness.value).toBe(successful.source.sql);
    expect(container.querySelector(".query-error")).toBeNull();
  }

  it.each(["failed", "interrupted"] as const)(
    "keeps a historical %s error inline without notifying on open, sibling changes or restoration",
    async (status) => {
      currentRun = {
        ...currentRun,
        source: { ...source, sql: "SELECT 1" },
        batch: undefined,
        status,
        error: memoryError,
      };
      await render("SELECT 1", currentRun);
      expect(container.querySelector(".query-error")?.textContent).toContain(
        memoryTitle,
      );
      expect(notify).not.toHaveBeenCalled();
      await openSuccessfulSibling();
      expect(notify).not.toHaveBeenCalled();
      await render("SELECT 1", currentRun, { seed: false });
      expect(container.querySelector(".query-error")?.textContent).toContain(
        memoryTitle,
      );
      expect(notify).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      await act(async () => root.unmount());
      root = createRoot(container);
      await render("SELECT 1", undefined, { seed: false });
      expect(container.querySelector(".query-error")?.textContent).toContain(
        memoryTitle,
      );
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it.each(["failed", "interrupted"] as const)(
    "notifies once when a new running query becomes %s and does not repeat it for sibling activity",
    async (status) => {
      currentRun = {
        ...currentRun,
        source: { ...source, sql: "SELECT 1" },
        batch: undefined,
      };
      await render("SELECT 1");
      await act(async () => button("Выполнить").click());
      expect(notify).not.toHaveBeenCalled();
      currentRun = { ...currentRun, status, error: memoryError };
      await act(async () => vi.advanceTimersByTimeAsync(650));
      expect(notify).toHaveBeenCalledExactlyOnceWith(memoryError, "error");
      await openSuccessfulSibling();
      await render("SELECT 1", currentRun, { seed: false });
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(container.querySelector(".query-error")?.textContent).toContain(
        memoryTitle,
      );
      expect(notify).toHaveBeenCalledExactlyOnceWith(memoryError, "error");
    },
  );

  it("notifies once when the launch response already contains a failed query", async () => {
    currentRun = {
      ...currentRun,
      source: { ...source, sql: "SELECT 1" },
      batch: undefined,
      status: "failed",
      error: memoryError,
    };
    await render("SELECT 1");
    await act(async () => button("Выполнить").click());
    expect(notify).toHaveBeenCalledExactlyOnceWith(memoryError, "error");
    await openSuccessfulSibling();
    expect(notify).toHaveBeenCalledExactlyOnceWith(memoryError, "error");
  });

  it("notifies once when an explicitly resumed historical batch fails immediately", async () => {
    currentRun = {
      ...currentRun,
      status: "paused",
      error: "Engine unavailable",
    };
    await render(source.sql, currentRun);
    expect(notify).not.toHaveBeenCalled();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === "/api/query-runs/run/resume") {
          currentRun = { ...currentRun, status: "failed", error: memoryError };
          return new Response(JSON.stringify(currentRun));
        }
        return originalFetch(path, options);
      }),
    );
    await act(async () => button("Продолжить").click());
    expect(notify).toHaveBeenCalledExactlyOnceWith(memoryError, "error");
    await openSuccessfulSibling();
    expect(notify).toHaveBeenCalledExactlyOnceWith(memoryError, "error");
  });
});

describe("SQL query duration", () => {
  it("restores elapsed time from the run and freezes the final duration", async () => {
    vi.setSystemTime(new Date("2026-11-05T10:00:10Z"));
    // Editor recovery waits on real WebCrypto; vi.waitFor advances fake timers.
    // Keep the measured wall clock explicit instead of timing that setup work.
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-11-05T10:00:10Z"));
    currentRun = {
      ...currentRun,
      source: { ...source, sql: "SELECT 1" },
      batch: undefined,
      startedAt: "2026-11-05T10:00:00Z",
    };
    await render("SELECT 1", currentRun);
    expect(
      container.querySelector('[aria-label="Время выполнения"]')?.textContent,
    ).toBe("10.0 с");
    now.mockReturnValue(Date.parse("2026-11-05T10:00:11Z"));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(
      container.querySelector('[aria-label="Время выполнения"]')?.textContent,
    ).toBe("11.0 с");
    currentRun = {
      ...currentRun,
      status: "completed",
      elapsedMs: 12000,
      finishedAt: "2026-11-05T10:00:12Z",
    };
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(
      container.querySelector('[aria-label="Время выполнения"]')?.textContent,
    ).toBe("12.0 с");
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(
      container.querySelector('[aria-label="Время выполнения"]')?.textContent,
    ).toBe("12.0 с");
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "shows a stable timestamp duration for reopened %s runs",
    async (status) => {
      vi.setSystemTime(new Date("2026-11-05T10:30:00Z"));
      currentRun = {
        ...currentRun,
        source: { ...source, sql: "SELECT 1" },
        batch: undefined,
        status,
        startedAt: "2026-11-05T10:00:00Z",
        finishedAt: "2026-11-05T10:01:05Z",
      };
      await render("SELECT 1", currentRun);
      expect(
        container.querySelector('[aria-label="Время выполнения"]')?.textContent,
      ).toBe("1 мин 05 с");
      await act(async () => vi.advanceTimersByTimeAsync(60000));
      expect(
        container.querySelector('[aria-label="Время выполнения"]')?.textContent,
      ).toBe("1 мин 05 с");
    },
  );
});

describe("SQL batch execution", () => {
  async function pauseRun() {
    currentRun = {
      ...currentRun,
      status: "paused",
      resultSetId: "result",
      rowCount: 1,
      error: "Engine unavailable",
      batch: {
        ...currentRun.batch!,
        currentDate: "2026-10-02",
        attempt: 3,
        completed: 1,
        succeeded: 1,
        failed: 1,
        items: [
          { date: "2026-10-01", status: "completed", attempts: 1, rowCount: 1 },
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
  }
  it("waits for explicit continuation, resumes the same run once, and retains earlier rows", async () => {
    await render();
    await start();
    await pauseRun();
    expect(container.textContent).toContain("Серия приостановлена");
    expect(container.textContent).toContain("Ошибка · 2026-10-02");
    expect(container.textContent).toContain("Engine unavailable");
    expect(button("Добавить результат на доску").disabled).toBe(true);
    expect(button("Закрыть вкладку date.sql").disabled).toBe(true);
    await act(async () => {
      harness.enter?.();
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(
      requests.filter(
        (r) => r.path === "/api/query-runs" && r.options.method === "POST",
      ),
    ).toHaveLength(1);
    expect(requests.filter((r) => r.path.endsWith("/resume"))).toHaveLength(0);
    const originalFetch = globalThis.fetch;
    let resolve!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === "/api/query-runs/run/resume") {
          requests.push({ path, options });
          return new Promise<Response>((done) => {
            resolve = done;
          });
        }
        return originalFetch(path, options);
      }),
    );
    const resume = button("Продолжить");
    await act(async () => {
      resume.click();
      resume.click();
    });
    expect(requests.filter((r) => r.path.endsWith("/resume"))).toHaveLength(1);
    expect(resume.disabled).toBe(true);
    expect(container.querySelector(".result-table")?.textContent).toContain(
      "2026-10-01",
    );
    currentResult = { ...currentResult, rowCount: 2 };
    currentRun = {
      ...currentRun,
      status: "completed",
      error: undefined,
      rowCount: 2,
      batch: {
        ...currentRun.batch!,
        currentDate: undefined,
        completed: 2,
        succeeded: 2,
        failed: 0,
      },
    };
    await act(async () => resolve(new Response(JSON.stringify(currentRun))));
    expect(container.querySelector(".result-table")?.textContent).toContain(
      "2026-10-02",
    );
    expect(button("Добавить результат на доску").disabled).toBe(false);
    expect(
      requests.filter(
        (r) => r.path === "/api/query-runs" && r.options.method === "POST",
      ),
    ).toHaveLength(1);
  });
  it("restores a paused run after remount and keeps it available when resume is rejected", async () => {
    await render();
    await start();
    await pauseRun();
    await act(async () => root.render(null));
    await render();
    expect(container.textContent).toContain("Серия приостановлена");
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path.endsWith("/resume"))
          return new Response(
            JSON.stringify({ error: "Нет свободного слота" }),
            { status: 429 },
          );
        return originalFetch(path, options);
      }),
    );
    await act(async () => button("Продолжить").click());
    expect(container.textContent).toContain("Нет свободного слота");
    expect(button("Продолжить").disabled).toBe(false);
    expect(container.querySelector(".result-table")?.textContent).toContain(
      "2026-10-01",
    );
    await act(async () => button("Остановить").click());
    expect(container.textContent).toContain("Серия остановлена");
    expect(button("Продолжить")).toBeUndefined();
    expect(button("Добавить результат на доску").disabled).toBe(false);
  });
  it("opens a paused history entry as its existing run instead of starting a new one", async () => {
    await pauseRun();
    await render(source.sql, currentRun);
    expect(container.textContent).toContain("Серия приостановлена");
    expect(button("Продолжить")).toBeDefined();
    expect(
      requests.filter(
        (r) => r.path === "/api/query-runs" && r.options.method === "POST",
      ),
    ).toHaveLength(0);
    await act(async () => button("Продолжить").click());
    expect(
      requests.filter((r) => r.path === "/api/query-runs/run/resume"),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (r) => r.path === "/api/query-runs" && r.options.method === "POST",
      ),
    ).toHaveLength(0);
    await pauseRun();
    const tabsBefore = container.querySelectorAll('[role="tab"]').length;
    currentRun = { ...currentRun, status: "running", error: undefined };
    await render(source.sql, currentRun);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(tabsBefore);
    expect(container.querySelector(".run-status")?.textContent).toContain(
      "Выполняется",
    );
  });
  it("keeps tracking cancellation when another window resumed the paused run", async () => {
    await render();
    await start();
    await pauseRun();
    const originalFetch = globalThis.fetch;
    currentRun = { ...currentRun, status: "running" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === "/api/query-runs/run/cancel") {
          requests.push({ path, options });
          currentRun = { ...currentRun, status: "cancelling" };
          return new Response(JSON.stringify(currentRun));
        }
        return originalFetch(path, options);
      }),
    );
    await act(async () => button("Остановить").click());
    expect(container.textContent).toContain("Останавливаем серию");
    currentRun = { ...currentRun, status: "cancelled" };
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(container.textContent).toContain("Серия остановлена");
    expect(container.textContent).not.toContain("Останавливаем серию");
    expect(button("Добавить результат на доску").disabled).toBe(false);
  });
  it("reconciles a lost resume response without starting the query again", async () => {
    await render();
    await start();
    await pauseRun();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, options: RequestInit = {}) => {
        if (path === "/api/query-runs/run/resume") {
          requests.push({ path, options });
          currentRun = { ...currentRun, status: "running", error: undefined };
          throw new TypeError("Response connection lost");
        }
        return originalFetch(path, options);
      }),
    );
    await act(async () => button("Продолжить").click());
    expect(button("Продолжить")).toBeUndefined();
    expect(container.querySelector(".run-status")?.textContent).toContain(
      "Выполняется",
    );
    currentRun = {
      ...currentRun,
      status: "completed",
      batch: { ...currentRun.batch!, completed: 2, succeeded: 2, failed: 0 },
    };
    await act(async () => vi.advanceTimersByTimeAsync(650));
    expect(container.textContent).toContain("Серия завершена");
    expect(
      requests.filter((r) => r.path === "/api/query-runs/run/resume"),
    ).toHaveLength(1);
    expect(
      requests.filter(
        (r) => r.path === "/api/query-runs" && r.options.method === "POST",
      ),
    ).toHaveLength(1);
  });
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
    expect(button("Добавить результат на доску").disabled).toBe(false);
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
    expect(button("Добавить результат на доску").disabled).toBe(true);
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
    expect(button("Добавить результат на доску").disabled).toBe(false);
  });
});
