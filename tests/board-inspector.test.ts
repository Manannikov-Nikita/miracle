// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Inspector from "../src/client/board/Inspector";
import type { BoardNode, ResultSet, TableSpec } from "../src/shared/types";

const result: ResultSet = {
  id: "result-inspector",
  columns: [
    { id: "month", name: "Месяц", type: "Date" },
    { id: "revenue", name: "Выручка", type: "Float64" },
  ],
  rowCount: 2,
  byteCount: 64,
  createdAt: "2026-10-23T00:00:00Z",
  source: { connectionId: "connection", sql: "select month, revenue" },
};
const table: TableSpec = {
  version: 1,
  sourceSchema: '[["month","Месяц","Date"],["revenue","Выручка","Float64"]]',
  columns: { revenue: { format: "currency", currency: "RUB" } },
  sort: { column: "revenue", direction: "desc" },
  wrap: true,
};
function fixture(view: "chart" | "table" = "chart"): BoardNode {
  return {
    id: "node-inspector",
    type: "artifact",
    position: { x: 15, y: 20 },
    data: {
      title: "Выручка по месяцам",
      kind: "result",
      resultSetId: result.id,
      view,
      chart: { kind: "line", x: "month", y: ["revenue"], legend: true },
      table,
      visibleColumns: ["month"],
    },
  };
}

// Render the actual inspector and both real settings components. A settings-only
// harness would miss a wiring regression that mounts the wrong component.
describe("board inspector settings integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: BoardNode;
  let changes: BoardNode[];
  let uncaught: unknown[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    uncaught = [];
    changes = [];
    root = createRoot(container, {
      onUncaughtError: (error) => uncaught.push(error),
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(
    node: BoardNode,
    options: { editable?: boolean; missingMetadata?: boolean } = {},
  ) {
    function Board() {
      const [value, setValue] = useState(node);
      current = value;
      return createElement(Inspector, {
        node: value,
        result: options.missingMetadata ? undefined : result,
        editable: options.editable ?? true,
        change(next) {
          changes.push(next);
          setValue(next);
        },
        close() {},
        openSource() {},
      });
    }
    await act(async () => root.render(createElement(Board)));
  }
  function button(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === text,
    );
    expect(found, `button ${text}`).toBeDefined();
    return found!;
  }
  function checkbox(text: string): HTMLInputElement {
    const label = [...container.querySelectorAll("label")].find(
      (item) => item.textContent?.trim() === text,
    );
    const found = label?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(found, `checkbox ${text}`).toBeDefined();
    return found!;
  }
  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }

  it("shows chart settings exclusively for a graph block", async () => {
    await render(fixture());
    expect(container.querySelector('[aria-label="Ось X"]')).not.toBeNull();
    expect(checkbox("Выручка").checked).toBe(true);
    expect(
      container.querySelector('[aria-label="Раздел настроек таблицы"]'),
    ).toBeNull();
    expect(uncaught).toEqual([]);
  });

  it.each(["table", undefined] as const)(
    "shows the full table settings for view %s",
    async (view) => {
      const node = fixture("table");
      node.data.view = view;
      await render(node);
      expect(
        container.querySelector('[aria-label="Раздел настроек таблицы"]'),
      ).not.toBeNull();
      expect(container.querySelector('[aria-label="Ось X"]')).toBeNull();
      await click(button("Вид"));
      expect(checkbox("Переносить текст").checked).toBe(true);
      await click(checkbox("Переносить текст"));
      expect(current.data.table).toEqual({ ...table, wrap: false });
      expect(current.data.chart).toEqual(node.data.chart);
      expect(current.data.visibleColumns).toEqual(["month"]);
    },
  );

  it("edits the graph while preserving the independent table configuration", async () => {
    const node = fixture();
    await render(node);
    await click(checkbox("Выручка"));
    expect(current.data.chart).toEqual({ ...node.data.chart, y: [] });
    expect(current.data.table).toBe(table);
    await click(checkbox("Выручка"));
    await click(checkbox("Легенда"));
    expect(current.data.chart).toEqual({ ...node.data.chart, legend: false });
    expect(current.data.table).toBe(table);
    expect(current.data.visibleColumns).toEqual(["month"]);
    expect(uncaught).toEqual([]);
  });

  it("preserves both configurations when switching between graph and table", async () => {
    const node = fixture();
    await render(node);
    await click(button("Таблица"));
    expect(current.data.view).toBe("table");
    expect(
      container.querySelector('[aria-label="Раздел настроек таблицы"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-label="Ось X"]')).toBeNull();
    await click(button("График"));
    expect(current.data.view).toBe("chart");
    expect(container.querySelector('[aria-label="Ось X"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Раздел настроек таблицы"]'),
    ).toBeNull();
    for (const changed of changes) {
      expect(changed.data.chart).toBe(node.data.chart);
      expect(changed.data.table).toBe(table);
      expect(changed.data.visibleColumns).toEqual(["month"]);
    }
  });

  it("restores legend placement after hiding the legend and switching views", async () => {
    const node = fixture();
    node.data.chart = {
      ...node.data.chart!,
      legendPosition: "right",
      legendAlign: "end",
    };
    await render(node);
    const placement = () =>
      container.querySelector('[aria-label="Положение легенды"]');
    const alignment = () =>
      container.querySelector('[aria-label="Выравнивание легенды"]');
    expect(placement()?.textContent).toBe("Справа");
    expect(alignment()?.textContent).toBe("По нижнему краю");
    await click(checkbox("Легенда"));
    expect(placement()).toBeNull();
    expect(current.data.chart).toEqual({ ...node.data.chart, legend: false });
    await click(button("Таблица"));
    await click(button("График"));
    await click(checkbox("Легенда"));
    expect(placement()?.textContent).toBe("Справа");
    expect(alignment()?.textContent).toBe("По нижнему краю");
    expect(current.data.chart).toEqual(node.data.chart);
    expect(current.data.table).toBe(table);
    expect(uncaught).toEqual([]);
  });

  it.each(["bar", "line", "area"] as const)(
    "toggles %s stacking and preserves it when switching table/chart views",
    async (kind) => {
      const node = fixture();
      node.data.chart = { ...node.data.chart!, kind, series: "month" };
      await render(node);
      expect(checkbox("С накоплением").checked).toBe(false);
      await click(checkbox("С накоплением"));
      expect(current.data.chart).toEqual({ ...node.data.chart, stacked: true });
      expect(current.data.table).toBe(table);
      await click(button("Таблица"));
      await click(button("График"));
      expect(checkbox("С накоплением").checked).toBe(true);
      await click(checkbox("С накоплением"));
      expect(current.data.chart?.stacked).toBe(false);
      expect(uncaught).toEqual([]);
    },
  );

  it.each([
    { kind: "scatter" as const, series: "month" },
    { kind: "bar" as const, series: undefined },
    { kind: "line" as const, series: undefined },
    { kind: "area" as const, series: undefined },
  ])(
    "hides stacking when no stackable breakdown is active (%j)",
    async (config) => {
      const node = fixture();
      node.data.chart = { ...node.data.chart!, ...config, stacked: true };
      await render(node);
      expect(container.textContent).not.toContain("С накоплением");
      expect(current.data.chart?.stacked).toBe(true);
    },
  );

  it.each(["bar", "line", "area"] as const)(
    "prevents a viewer changing %s stacking",
    async (kind) => {
      const node = fixture();
      node.data.chart = {
        ...node.data.chart!,
        kind,
        series: "month",
        stacked: true,
      };
      await render(node, { editable: false });
      expect(checkbox("С накоплением").matches(":disabled")).toBe(true);
      await click(checkbox("С накоплением"));
      expect(changes).toEqual([]);
    },
  );

  it.each(["chart", "table"] as const)(
    "keeps an inspector safe without result metadata in %s mode",
    async (view) => {
      await render(fixture(view), { missingMetadata: true });
      expect(
        container.querySelector('[aria-label="Свойства блока"]'),
      ).not.toBeNull();
      expect(container.querySelector('[aria-label="Ось X"]')).toBeNull();
      expect(
        container.querySelector('[aria-label="Раздел настроек таблицы"]'),
      ).toBeNull();
      expect(button("График").disabled).toBe(true);
      await click(button("График"));
      expect(changes).toEqual([]);
      expect(uncaught).toEqual([]);
    },
  );

  it.each(["chart", "table"] as const)(
    "prevents a viewer changing the stored %s settings",
    async (view) => {
      await render(fixture(view), { editable: false });
      expect(button("График").disabled).toBe(true);
      expect(button("Таблица").disabled).toBe(true);
      expect(
        container.querySelector<HTMLInputElement>('input[maxlength="500"]')
          ?.readOnly,
      ).toBe(true);
      if (view === "chart") {
        expect(
          container.querySelector('[aria-label="Ось X"]')?.matches(":disabled"),
        ).toBe(true);
        expect(checkbox("Легенда").matches(":disabled")).toBe(true);
        await click(checkbox("Легенда"));
      } else {
        await click(button("Вид"));
        expect(checkbox("Переносить текст").disabled).toBe(true);
        await click(checkbox("Переносить текст"));
      }
      await click(button("График"));
      await click(button("Таблица"));
      expect(changes).toEqual([]);
      expect(uncaught).toEqual([]);
    },
  );
});
