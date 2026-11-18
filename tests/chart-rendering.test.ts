// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ResultView from "../src/client/board/ResultView";
import type { ChartSpec, ResultSet } from "../src/shared/types";
import { api, getResultRows } from "../src/client/api";

const renderer = vi.hoisted(() => ({ fail: false, attempts: 0 }));
vi.mock(
  "../src/client/board/chart-kit/cartesian-geometry",
  async (original) => {
    const geometry =
      await original<
        typeof import("../src/client/board/chart-kit/cartesian-geometry")
      >();
    return {
      ...geometry,
      cartesianGeometry: (
        ...args: Parameters<typeof geometry.cartesianGeometry>
      ) => {
        renderer.attempts++;
        if (renderer.fail) throw new Error("Cannot draw chart");
        return geometry.cartesianGeometry(...args);
      },
    };
  },
);

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
const scatter: ChartSpec = { ...valid, kind: "scatter", x: "revenue" };
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

  beforeEach(() => {
    renderer.fail = false;
    renderer.attempts = 0;
    observers = new Set();
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300);
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
      onCaughtError: () => {},
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

  it("contains drawing failures and retries the SVG plot", async () => {
    renderer.fail = true;
    await render(valid);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Не удалось отобразить график.");
    const details = alert!.querySelector<HTMLDetailsElement>("details")!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector("summary")!.click());
    expect(details.querySelector("pre")?.textContent).toBe("Cannot draw chart");
    renderer.fail = false;
    await act(async () => alert!.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();
    expect(container.querySelector("h1")?.textContent).toBe("Доска");
    expect(uncaught).toEqual([]);
  });

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
    const failedSetting: ChartSpec = { ...valid, showLabels: true };
    renderer.fail = true;
    await render(failedSetting);
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    const attempts = renderer.attempts;
    await render(failedSetting);
    expect(renderer.attempts).toBe(attempts);
    renderer.fail = false;
    await render({ ...valid, legend: false });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('svg[role="img"]')).toBeTruthy();
    expect(uncaught).toEqual([]);
  });

  it("disconnects plot observers across chart types, validation, table view and unmount", async () => {
    await render(scatter);
    expect(
      container.querySelector('.bk-chart[data-kind="scatter"] svg[role="img"]'),
    ).toBeTruthy();
    await render({ ...scatter, legend: false });
    await render(valid);
    expect(
      container.querySelector('.bk-chart[data-kind="line"] svg[role="img"]'),
    ).toBeTruthy();
    await render({ ...valid, y: [] });
    expect(container.querySelector(".bk-chart")).toBeNull();
    await render(scatter, "table");
    expect(container.querySelector("table")).toBeTruthy();
    await render(scatter);
    expect(observers.size).toBeGreaterThan(0);
    await act(async () => root.render(null));
    expect(observers.size).toBe(0);
  });
});
