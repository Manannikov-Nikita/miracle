// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import ResultView from "../src/client/board/ResultView";
import type { CustomChartSpec } from "../src/shared/custom-charts";

const failure = vi.hoisted(() => ({ rows: false }));
vi.mock("../src/client/api", () => ({
  getResultRows: async (id: string) => {
    if (failure.rows) throw new Error("Preview unavailable");
    return {
      result: {
        id,
        columns: [{ id: "value", name: "value", type: "UInt64" }],
        rowCount: 1,
        byteCount: 10,
        createdAt: "2026-11-01",
        source: { connectionId: "c", sql: "SELECT 12" },
      },
      rows: [[12]],
      offset: 0,
      total: 1,
    };
  },
  api: async () => ({
    columns: [{ id: "value", name: "value", type: "UInt64" }],
    rows: [[12]],
  }),
}));
const spec: CustomChartSpec = {
  version: 1,
  description: "Выбросы и выноски",
  html: "",
  css: "",
  javascript: "api.root.textContent = 'inside only';",
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  failure.rows = false;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value() {},
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("routes a persisted custom view to the real renderer, without running source in the parent", async () => {
  await act(async () =>
    root.render(
      createElement(ResultView, {
        id: "snapshot",
        view: "custom",
        customChart: spec,
        boardId: "board",
        nodeId: "node",
      }),
    ),
  );
  expect(host.querySelector(".custom-chart")).not.toBeNull();
  expect(host.textContent).toContain("Выбросы и выноски");
  expect(host.textContent).not.toContain("inside only");
});
it("reports missing custom source instead of silently showing a table", async () => {
  await act(async () =>
    root.render(
      createElement(ResultView, {
        id: "snapshot",
        view: "custom",
        boardId: "board",
        nodeId: "node",
      }),
    ),
  );
  expect(host.textContent).toContain("Не удалось открыть кастомный график");
});

it("starts the diagnostic renderer even when the separate table preview request fails", async () => {
  failure.rows = true;
  await act(async () =>
    root.render(
      createElement(ResultView, {
        id: "snapshot",
        view: "custom",
        customChart: spec,
        boardId: "board",
        nodeId: "node",
      }),
    ),
  );
  expect(host.querySelector(".custom-chart")).not.toBeNull();
  expect(host.textContent).not.toContain("Preview unavailable");
});

it("can return from a failed fallback table to the custom chart", async () => {
  failure.rows = true;
  await act(async () =>
    root.render(
      createElement(ResultView, {
        id: "snapshot",
        view: "custom",
        boardId: "board",
        nodeId: "node",
      }),
    ),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(host.textContent).toContain("Preview unavailable");
  const back = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "Вернуться к графику",
  );
  expect(back).toBeDefined();
  await act(async () => back!.click());
  expect(host.textContent).toContain("Не удалось открыть кастомный график");
});
