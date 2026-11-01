import { afterEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { customChartShell } from "../src/client/board/custom-chart-runtime";
import {
  customChartExamples,
  infrastructureWaterfallExample,
  verticalColumnsExample,
  type CustomChartExample,
} from "./fixtures/custom-chart-examples";
import type { Cell, Column } from "../src/shared/types";

const windows: JSDOM[] = [];
afterEach(() => windows.splice(0).forEach((dom) => dom.window.close()));
function render(
  example: CustomChartExample,
  rows: Cell[][] = example.rows,
  columns: Column[] = example.columns,
) {
  const reports: Record<string, unknown>[] = [];
  const parent = {
    postMessage: (message: Record<string, unknown>) => reports.push(message),
  };
  const dom = new JSDOM(customChartShell(), {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperty(window, "parent", { value: parent });
    },
  });
  windows.push(dom);
  const identity = {
    channel: "miracle-custom-chart",
    instanceId: "example",
    generation: "one",
  };
  const send = (data: object) =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent("message", {
        data: { ...identity, ...data },
        source: parent as any,
      }),
    );
  send({ type: "connect" });
  send({
    type: "render",
    spec: example.spec,
    data: { rows, columns },
    width: 960,
    height: 650,
    theme: "light",
  });
  return { document: dom.window.document, reports, window: dom.window };
}

describe("data-driven custom chart examples", () => {
  it.each(customChartExamples)(
    "renders $id from snapshot rows, with a responsive SVG",
    (example) => {
      const { document, reports } = render(example);
      expect(reports.at(-1)).toMatchObject({ type: "rendered" });
      expect(
        document.querySelector("svg")?.getAttribute("viewBox"),
      ).toBeTruthy();
      expect(document.body.textContent).toContain("Синтетические данные");
      expect(document.querySelectorAll("[data-mark]")).toHaveLength(
        example.rows.length,
      );
    },
  );
  it("updates positive and negative column geometry and callout values when rows change", () => {
    const first = render(verticalColumnsExample).document;
    const changed = verticalColumnsExample.rows.map((row) => [...row]);
    changed[2][1] = 24;
    const second = render(verticalColumnsExample, changed).document;
    const selector = '[data-mark="2030"]';
    expect(first.querySelector(selector)?.getAttribute("height")).not.toBe(
      second.querySelector(selector)?.getAttribute("height"),
    );
    expect(
      second.querySelector('[data-callout="2030"]')?.textContent,
    ).toContain("24");
    expect(
      Number(first.querySelector('[data-mark="2050"]')?.getAttribute("y")),
    ).toBeGreaterThanOrEqual(320);
  });
  it("derives cumulative waterfall geometry, connectors and grouped totals from all eight rows", () => {
    const first = render(infrastructureWaterfallExample).document;
    expect(first.querySelectorAll("[data-connector]")).toHaveLength(7);
    expect(
      first.querySelector('[data-total="Строительство"]')?.textContent,
    ).toContain("305");
    expect(
      first.querySelector('[data-total="Инженерные системы"]')?.textContent,
    ).toContain("255");
    expect(first.querySelector('[data-total="Резерв"]')?.textContent).toContain(
      "440",
    );
    expect(first.querySelector("[data-grand-total]")?.textContent).toContain(
      "1 000",
    );
    const changed = infrastructureWaterfallExample.rows.map((row) => [...row]);
    changed[0][1] = 240;
    const second = render(infrastructureWaterfallExample, changed).document;
    expect(
      first
        .querySelector('[data-mark="Подготовка площадки"]')
        ?.getAttribute("width"),
    ).not.toBe(
      second
        .querySelector('[data-mark="Подготовка площадки"]')
        ?.getAttribute("width"),
    );
    expect(
      second.querySelector('[data-total="Строительство"]')?.textContent,
    ).toContain("425");
    expect(second.querySelector("[data-grand-total]")?.textContent).toContain(
      "1 120",
    );
  });
  it.each(customChartExamples)(
    "shows an honest empty state for $id",
    (example) => {
      const { document, reports } = render(example, []);
      expect(reports.at(-1)).toMatchObject({ type: "rendered" });
      expect(document.body.textContent).toContain("Нет строк");
      expect(document.querySelectorAll("[data-mark]")).toHaveLength(0);
    },
  );
  it.each(customChartExamples)(
    "binds $id columns by ID after reordering, and accepts explicit finite decimal strings",
    (example) => {
      const reordered = [...example.columns].reverse();
      const rows = example.rows.map((row) =>
        row.map((cell, index) => (index === 1 ? String(cell) : cell)).reverse(),
      );
      const { document, reports } = render(example, rows, reordered);
      expect(reports.at(-1)).toMatchObject({ type: "rendered" });
      expect(document.querySelectorAll("[data-mark]")).toHaveLength(
        example.rows.length,
      );
    },
  );
  it.each(customChartExamples)(
    "binds $id to verified names when the database assigns fresh IDs",
    (example) => {
      const columns = example.columns.map((column, index) => ({
        ...column,
        id: "database-" + index,
      }));
      const { document, reports } = render(example, example.rows, columns);
      expect(reports.at(-1)).toMatchObject({ type: "rendered" });
      expect(document.querySelectorAll("[data-mark]")).toHaveLength(
        example.rows.length,
      );
    },
  );
  it("does not silently turn null, empty strings or imprecise integers into fake points", () => {
    for (const value of [null, "", "9007199254740993"]) {
      const rows = verticalColumnsExample.rows.map((row) => [...row]);
      rows[0][1] = value;
      const { reports } = render(verticalColumnsExample, rows);
      expect(reports.at(-1)).toMatchObject({ type: "error", stage: "init" });
    }
  });
  it("keeps cell labels as text and supports local button interaction", () => {
    const rows = infrastructureWaterfallExample.rows.map((row) => [...row]);
    rows[0][0] = '<img src=x onerror="window.injected=true">';
    const { document, window } = render(infrastructureWaterfallExample, rows);
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain(
      '<img src=x onerror="window.injected=true">',
    );
    const button = document.querySelector("button")!;
    expect(button.textContent).toContain("Подписи");
    button.click();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(
      document.querySelector("[data-value]")?.getAttribute("visibility"),
    ).toBe("hidden");
    expect(
      document.querySelector('[data-mark][tabindex="0"] title')?.textContent,
    ).toContain("120");
    expect((window as any).injected).toBeUndefined();
  });
});
