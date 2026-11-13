// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getGridApi } from "ag-grid-community";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createEmptyVisualTable,
  type VisualTableResult,
  type VisualTableSpec,
} from "../src/shared/visual-table";
import SqlTableView from "../src/client/board/SqlTableView";

const evaluate = vi.hoisted(() => vi.fn());
vi.mock("../src/client/api", () => ({ evaluateVisualTable: evaluate }));
let host: HTMLDivElement, root: Root, current: VisualTableSpec;
function Harness({
  editable = true,
  onKeyDown,
}: {
  editable?: boolean;
  onKeyDown?: () => void;
}) {
  const [table, setTable] = useState(createEmptyVisualTable);
  current = table;
  return createElement(
    "div",
    { onKeyDown },
    createElement(SqlTableView, { spec: table, editable, onChange: setTable }),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  evaluate.mockImplementation(
    async ({
      table,
    }: {
      table: VisualTableSpec;
    }): Promise<VisualTableResult> => ({
      columns: table.columns,
      rows: table.rows ?? [],
      summaries: {},
      sourceRowCount: table.rows?.length ?? 0,
      totalRowCount: table.rows?.length ?? 0,
      offset: 0,
      limit: 500,
      sql: "SELECT * FROM source",
      parameters: [],
      elapsedMs: 1,
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.getAttribute("aria-label") === label || b.title === label,
  )!;
it("adds a manual row and keeps table undo and redo scoped to that definition", async () => {
  await act(async () => root.render(createElement(Harness)));
  const before = current.rows!.length;
  await act(async () => button("Добавить строку").click());
  expect(current.rows).toHaveLength(before + 1);
  await act(async () => button("Отменить изменение таблицы").click());
  expect(current.rows).toHaveLength(before);
  await act(async () => button("Повторить изменение таблицы").click());
  expect(current.rows).toHaveLength(before + 1);
});
it("keeps the read-only table free of mutating controls", async () => {
  await act(async () =>
    root.render(createElement(Harness, { editable: false })),
  );
  expect(button("Добавить строку")).toBeUndefined();
  expect(button("Добавить столбец")).toBeUndefined();
  expect(button("Отменить изменение таблицы")).toBeUndefined();
  expect(host.querySelector('[aria-label="Тип нового столбца"]')).toBeNull();
});
it("does not let a cell-level keyboard event bubble to the board", async () => {
  const key = vi.fn();
  await act(async () =>
    root.render(createElement(Harness, { onKeyDown: key })),
  );
  const wrapper = host.querySelector(".board-sql-table")!;
  const cell = document.createElement("div");
  cell.tabIndex = 0;
  wrapper.append(cell);
  await act(async () =>
    cell.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Delete",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(key).not.toHaveBeenCalled();
});

it("keeps the next formula field focused when a column name commits on blur", async () => {
  await act(async () => root.render(createElement(Harness)));
  const name = host.querySelector<HTMLInputElement>(
    `[data-column-name="${current.columns[0].id}"]`,
  )!;
  const formula = host.querySelector<HTMLInputElement>(
    `[data-column-formula="${current.columns[1].id}"]`,
  )!;
  name.focus();
  name.value = "Название";
  await act(async () => {
    formula.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(current.columns[0].name).toBe("Название");
  expect(formula.isConnected).toBe(true);
  expect(document.activeElement).toBe(formula);
});
it("mounts one real grid inside the expanded portal and restores it when closed", async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => button("Развернуть таблицу").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector(".ag-root-wrapper")).not.toBeNull();
  expect(document.querySelectorAll(".ag-root-wrapper")).toHaveLength(1);
  await act(async () =>
    dialog.querySelector<HTMLButtonElement>('[aria-label="Закрыть"]')!.click(),
  );
  expect(host.querySelector(".ag-root-wrapper")).not.toBeNull();
  expect(document.querySelectorAll(".ag-root-wrapper")).toHaveLength(1);
});

it("keeps modal header fields attached while another column commits on blur", async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => button("Развернуть таблицу").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const api = getGridApi(dialog.querySelector<HTMLElement>(".ag-root-wrapper")!)!;
  let columnReloads = 0;
  api.addEventListener("newColumnsLoaded", () => columnReloads++);
  const name = dialog.querySelector<HTMLInputElement>(
    `[data-column-name="${current.columns[0].id}"]`,
  )!;
  const formula = dialog.querySelector<HTMLInputElement>(
    `[data-column-formula="${current.columns[1].id}"]`,
  )!;
  const removed: Node[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) removed.push(...record.removedNodes);
  });
  observer.observe(dialog, { childList: true, subtree: true });
  name.focus();
  name.value = "Количество";
  await act(async () => {
    formula.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  observer.disconnect();
  expect(current.columns[0].name).toBe("Количество");
  expect(columnReloads).toBe(0);
  expect(removed.some((node) => node === formula || node.contains(formula))).toBe(false);
  expect(document.activeElement).toBe(formula);
});

it("keeps a focused formula draft when a delayed calculation replaces rows and totals", async () => {
  await act(async () => root.render(createElement(Harness)));
  await act(async () => button("Развернуть таблицу").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const api = getGridApi(dialog.querySelector<HTMLElement>(".ag-root-wrapper")!)!;
  let rowReloads = 0;
  api.addEventListener("rowDataUpdated", () => rowReloads++);
  const name = dialog.querySelector<HTMLInputElement>(
    `[data-column-name="${current.columns[0].id}"]`,
  )!;
  const formula = dialog.querySelector<HTMLInputElement>(
    `[data-column-formula="${current.columns[1].id}"]`,
  )!;
  let resolve!: (data: VisualTableResult) => void;
  evaluate.mockImplementationOnce(() => new Promise<VisualTableResult>((done) => { resolve = done; }));
  name.focus();
  name.value = "Количество";
  await act(async () => {
    formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    formula.focus();
    formula.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    formula.click();
    await new Promise((done) => setTimeout(done, 0));
  });
  expect(document.activeElement).toBe(formula);
  expect(rowReloads).toBe(0);
  formula.value = "[Количество] * 2";
  formula.setSelectionRange(3, 5);
  await act(async () => {
    resolve({
      columns: current.columns,
      rows: [{ id: current.rows![0].id, values: { [current.columns[0].id]: "12" } }],
      summaries: { [current.columns[0].id]: "12" },
      sourceRowCount: 1, totalRowCount: 1, offset: 0, limit: 500,
      sql: "SELECT 12", parameters: [], elapsedMs: 1,
    });
    await new Promise((done) => requestAnimationFrame(done));
  });
  expect(document.activeElement).toBe(formula);
  expect(formula.value).toBe("[Количество] * 2");
  expect(formula.selectionStart).toBe(3);
  expect(formula.selectionEnd).toBe(5);
});
