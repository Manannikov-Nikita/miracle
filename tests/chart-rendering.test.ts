// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ResultView from "../src/client/board/ResultView";
import type { ChartSpec, ResultSet } from "../src/shared/types";
import { api, getResultRows } from "../src/client/api";

const renderer = vi.hoisted(() => ({
  fail: "" as "" | "init" | "initAfterRegistration" | "setOption" | "resize",
  instances: [] as {
    host: HTMLElement;
    disposed: boolean;
    dispose: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock("echarts", () => ({
  init(host: HTMLElement) {
    function checkFailure(stage: typeof renderer.fail) {
      if (renderer.fail === stage) {
        renderer.fail = "";
        throw new Error(`Renderer failed (${stage})`);
      }
    }
    checkFailure("init");
    host.appendChild(document.createElement("canvas"));
    const chart = {
      host,
      disposed: false,
      setOption() {
        checkFailure("setOption");
      },
      resize() {
        checkFailure("resize");
      },
      dispose: vi.fn(() => {
        // Both real ZRender painters clear their entire root on disposal.
        // Keep that DOM side effect while avoiding canvas APIs in jsdom.
        host.innerHTML = "";
        chart.disposed = true;
      }),
    };
    renderer.instances.push(chart);
    checkFailure("initAfterRegistration");
    return chart;
  },
  getInstanceByDom(host: HTMLElement) {
    return renderer.instances.findLast(
      (chart) => chart.host === host && !chart.disposed,
    );
  },
}));

const result: ResultSet = {
  id: "chart-result",
  columns: [
    { id: "month", name: "Месяц", type: "Date" },
    { id: "revenue", name: "Выручка", type: "Float64" },
  ],
  rowCount: 2,
  byteCount: 64,
  createdAt: "2026-10-23T00:00:00Z",
  source: { connectionId: "connection", sql: "select month, revenue" },
};
const rows = [
  ["2026-09-01", 10],
  ["2026-10-01", 20],
];
vi.mock("../src/client/api", () => ({
  getResultRows: vi.fn(async () => ({ result, rows, offset: 0, total: 2 })),
  api: vi.fn(async () => ({ result, rows })),
}));

const valid: ChartSpec = {
  kind: "line",
  x: "month",
  y: ["revenue"],
  legend: true,
};
const invalidSettings: [string, ChartSpec, RegExp][] = [
  ["the final Y field is unchecked", { ...valid, y: [] }, /столбцы X и Y/],
  [
    "scatter uses a date X field",
    { ...valid, kind: "scatter" },
    /числовой столбец/,
  ],
];

describe("chart settings validation lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let uncaught: unknown[];
  let observers: Set<ResizeObserverCallback>;
  let loggedErrors: unknown[];

  beforeEach(() => {
    renderer.fail = "";
    renderer.instances = [];
    observers = new Set();
    loggedErrors = [];
    vi.spyOn(console, "error").mockImplementation((...args) =>
      loggedErrors.push(...args),
    );
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe() {
          observers.add(this.callback);
        }
        disconnect() {
          observers.delete(this.callback);
        }
        unobserve() {
          observers.delete(this.callback);
        }
      },
    );
    uncaught = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container, {
      onUncaughtError: (error) => uncaught.push(error),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function render(spec: ChartSpec, view: "chart" | "table" = "chart") {
    await act(async () => {
      root.render(
        createElement(
          "main",
          null,
          createElement("h1", null, "Доска"),
          createElement(ResultView, {
            id: result.id,
            view,
            chart: spec,
          }),
        ),
      );
    });
  }

  it.each(invalidSettings)(
    "keeps the validation message visible when %s",
    async (_label, invalid, message) => {
      await render(valid);
      expect(container.querySelector('[role="img"]')).not.toBeNull();
      await render(invalid);
      expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
        message,
      );
      const details = container.querySelector<HTMLDetailsElement>("details");
      expect(details).not.toBeNull();
      expect(details?.open).toBe(false);
      expect(details?.querySelector("pre")?.textContent).toMatch(message);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "свойствах блока",
      );
      expect(container.querySelector('[role="alert"] button')).toBeNull();
      expect(container.querySelector("h1")?.textContent).toBe("Доска");
      expect(uncaught).toEqual([]);
    },
  );

  it.each(invalidSettings)(
    "recovers without removing the page after %s",
    async (_label, invalid) => {
      for (let i = 0; i < 3; i++) {
        await render(valid);
        await render(invalid);
        await render(valid);
      }
      expect(uncaught).toEqual([]);
      expect(container.querySelector("h1")?.textContent).toBe("Доска");
      expect(container.querySelector('[role="img"]')).not.toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it.each(["init", "initAfterRegistration", "setOption", "resize"] as const)(
    "keeps renderer %s failures local and supports retry",
    async (stage) => {
      if (stage === "resize") {
        await render(valid);
        renderer.fail = stage;
        await act(async () => {
          for (const callback of [...observers])
            callback([], {} as ResizeObserver);
        });
      } else {
        renderer.fail = stage;
        await render(valid);
      }
      expect(uncaught).toEqual([]);
      expect(container.querySelector("h1")?.textContent).toBe("Доска");
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Не удалось отобразить график.",
      );
      const details = container.querySelector<HTMLDetailsElement>("details");
      expect(details).not.toBeNull();
      expect(details?.open).toBe(false);
      await act(async () => details!.querySelector("summary")!.click());
      expect(details?.open).toBe(true);
      expect(details?.querySelector("pre")?.textContent).toBe(
        `Renderer failed (${stage})`,
      );
      expect(
        loggedErrors.some(
          (error) =>
            error instanceof Error &&
            error.message === `Renderer failed (${stage})`,
        ),
      ).toBe(true);
      if (stage === "initAfterRegistration")
        expect(renderer.instances[0].dispose).toHaveBeenCalledTimes(1);
      const retry = [...container.querySelectorAll("button")].find((button) =>
        /Повторить/.test(button.textContent ?? ""),
      );
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('[role="img"]')).not.toBeNull();
      expect(uncaught).toEqual([]);
    },
  );

  it.each(["snapshot", "chart"])(
    "explains a %s read failure, keeps its details collapsed and retries the read",
    async (target) => {
      const detail = `Internal storage error while reading ${target}`;
      const failure = Object.assign(new Error("Не удалось получить данные"), {
        details: detail,
      });
      if (target === "snapshot")
        vi.mocked(getResultRows).mockRejectedValueOnce(failure);
      else vi.mocked(api).mockRejectedValueOnce(failure);
      await render(valid);
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Не удалось загрузить");
      const details = alert?.querySelector<HTMLDetailsElement>("details");
      expect(details).not.toBeNull();
      expect(details?.open).toBe(false);
      expect(details?.querySelector("pre")?.textContent).toContain(detail);
      const retry = [...alert!.querySelectorAll("button")].find((button) =>
        /Повторить/.test(button.textContent ?? ""),
      )!;
      await act(async () => retry.click());
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('[role="img"]')).not.toBeNull();
      expect(uncaught).toEqual([]);
    },
  );

  it("recovers from an update failure when settings change without retrying unchanged settings", async () => {
    await render(valid);
    const failedSetting: ChartSpec = { ...valid, kind: "bar" };
    renderer.fail = "setOption";
    await render(failedSetting);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await render(failedSetting);
    expect(renderer.instances).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await render({ ...valid, kind: "area" });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="img"]')).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Доска");
    expect(uncaught).toEqual([]);
  });

  it("disposes every chart exactly once across settings changes, validation and unmount", async () => {
    await render(valid);
    await render({ ...valid, kind: "bar", legend: false });
    await render({ ...valid, y: [] });
    await render(valid);
    await render(valid, "table");
    expect(container.querySelector("table")).not.toBeNull();
    await render(valid);
    expect(container.querySelector('[role="img"]')).not.toBeNull();
    await act(async () => root.unmount());
    expect(renderer.instances.length).toBeGreaterThan(0);
    for (const chart of renderer.instances)
      expect(chart.dispose).toHaveBeenCalledTimes(1);
    expect(observers.size).toBe(0);
  });
});
