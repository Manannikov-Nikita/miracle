// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  VisualTableResult,
  VisualTableSpec,
} from "../src/shared/visual-table";
import {
  parseSqlTableCell,
  formatSqlTableCell,
} from "../src/client/board/sql-table-model";
import { useVisualTableEvaluation } from "../src/client/board/useVisualTableEvaluation";

const evaluate = vi.hoisted(() => vi.fn());
vi.mock("../src/client/api", () => ({ evaluateVisualTable: evaluate }));
const spec = (formula = "") =>
  ({
    version: 1,
    columns: [{ id: "amount", name: "Сумма", type: "number", formula }],
    rows: [{ id: "row-1", values: { amount: "12" } }],
    edits: [],
  }) as VisualTableSpec;
const response = (value: string): VisualTableResult => ({
  columns: spec().columns,
  rows: [{ id: "row-1", values: { amount: value } }],
  summaries: { amount: value },
  sourceRowCount: 1,
  totalRowCount: 1,
  offset: 0,
  limit: 500,
  sql: "SELECT 1",
  parameters: [],
  elapsedMs: 1,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let host: HTMLDivElement, root: Root;
let output: ReturnType<typeof useVisualTableEvaluation>;
function Harness({ table }: { table: VisualTableSpec }) {
  output = useVisualTableEvaluation(table, 0);
  return createElement("div", null, output.data?.rows[0]?.values.amount);
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  evaluate.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps exact numeric input and text whitespace without JS Number coercion", () => {
  expect(parseSqlTableCell("9007199254740993.123456789", "number")).toBe(
    "9007199254740993.123456789",
  );
  expect(parseSqlTableCell("1,25", "number")).toBe("1.25");
  expect(parseSqlTableCell("", "number")).toBeNull();
  expect(parseSqlTableCell("  note  ", "text")).toBe("  note  ");
  expect(parseSqlTableCell("false", "boolean")).toBe(false);
  expect(() => parseSqlTableCell("Infinity", "number")).toThrow();
  expect(() => parseSqlTableCell("maybe", "boolean")).toThrow();
  expect(
    formatSqlTableCell("9007199254740993.123456789", "number").replaceAll(
      /\s/g,
      "",
    ),
  ).toBe("9007199254740993,123456789");
});
it("does not replace newer query data when an aborted older request resolves", async () => {
  const older = deferred<VisualTableResult>(),
    newer = deferred<VisualTableResult>();
  evaluate
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);
  await act(async () =>
    root.render(createElement(Harness, { table: spec("1") })),
  );
  const signal = evaluate.mock.calls[0][1] as AbortSignal;
  await act(async () =>
    root.render(createElement(Harness, { table: spec("2") })),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => newer.resolve(response("2")));
  await act(async () => older.resolve(response("1")));
  expect(output.data?.rows[0].values.amount).toBe("2");
  expect(host.textContent).toBe("2");
});
it("keeps the last successful rows and marks them stale after a formula error", async () => {
  evaluate.mockResolvedValueOnce(response("24"));
  await act(async () =>
    root.render(createElement(Harness, { table: spec("12 * 2") })),
  );
  evaluate.mockRejectedValueOnce(new Error("Нет столбца «Ошибка»"));
  await act(async () =>
    root.render(createElement(Harness, { table: spec("Ошибка * 2") })),
  );
  expect(output.data?.rows[0].values.amount).toBe("24");
  expect(output.stale).toBe(true);
  expect(output.error).toContain("Ошибка");
});
it("aborts an evaluation when its table is unmounted", async () => {
  evaluate.mockReturnValue(new Promise(() => {}));
  await act(async () => root.render(createElement(Harness, { table: spec() })));
  const signal = evaluate.mock.calls[0][1] as AbortSignal;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
});

it("commits a column formula on Enter and cancels an uncommitted edit on Escape", async () => {
  const { SqlTableHeader } = await import("../src/client/board/SqlTableHeader");
  const formula = vi.fn(),
    rename = vi.fn();
  const header = new SqlTableHeader();
  header.init({
    definition: {
      id: "amount",
      name: "Сумма",
      type: "number",
      formula: "Цена * 2",
    },
    editable: true,
    formula,
    rename,
    summary: vi.fn(),
    sort: vi.fn(),
  } as never);
  host.append(header.getGui());
  const input = host.querySelector<HTMLInputElement>(
    '[aria-label="Формула: Сумма"]',
  )!;
  input.focus();
  input.value = "Цена * 3";
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(formula).toHaveBeenCalledWith("Цена * 3");
  formula.mockClear();
  input.focus();
  input.value = "Несохранённая правка";
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(input.value).toBe("Цена * 2");
  expect(formula).not.toHaveBeenCalled();
});
it("does not render formula edits, sorting or deletion in a readonly column header", async () => {
  const { SqlTableHeader } = await import("../src/client/board/SqlTableHeader");
  const header = new SqlTableHeader();
  header.init({
    definition: {
      id: "amount",
      name: "Сумма",
      type: "number",
      formula: "Цена * 2",
    },
    editable: false,
    formula: vi.fn(),
    rename: vi.fn(),
    summary: vi.fn(),
    sort: vi.fn(),
    remove: vi.fn(),
  } as never);
  host.append(header.getGui());
  expect(host.querySelector("input")?.readOnly).toBe(true);
  expect(
    host.querySelector("button,select,.sql-table-column-formula"),
  ).toBeNull();
  expect(host.textContent).toContain("Цена * 2");
});

it("refreshes committed header values without losing a focused draft or its selection", async () => {
  const { SqlTableHeader } = await import("../src/client/board/SqlTableHeader");
  const oldCommit = vi.fn(),
    newCommit = vi.fn();
  const header = new SqlTableHeader();
  const params = {
    definition: {
      id: "amount",
      name: "Сумма",
      type: "number",
      formula: "Цена * 2",
    },
    editable: true,
    formula: oldCommit,
    rename: vi.fn(),
    summary: vi.fn(),
    sort: vi.fn(),
  };
  header.init(params as never);
  host.append(header.getGui());
  const input = host.querySelector<HTMLInputElement>(
    '[data-column-formula="amount"]',
  )!;
  input.focus();
  input.value = "Цена * 3";
  input.setSelectionRange(2, 4);
  const refreshed = header.refresh({
    ...params,
    definition: { ...params.definition, name: "Расчёт", formula: "Цена * 4" },
    formula: newCommit,
  } as never);
  expect(refreshed).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("Цена * 3");
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(4);
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(input.value).toBe("Цена * 4");
  expect(oldCommit).not.toHaveBeenCalled();
  expect(newCommit).not.toHaveBeenCalled();
  input.focus();
  input.value = "Цена * 5";
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(newCommit).toHaveBeenCalledWith("Цена * 5");
  expect(oldCommit).not.toHaveBeenCalled();
});

it("lets native focus leave a header input before committing its blur edit", async () => {
  const { SqlTableHeader } = await import("../src/client/board/SqlTableHeader");
  const rename = vi.fn();
  const header = new SqlTableHeader();
  header.init({
    definition: { id: "quantity", name: "Количество", type: "number" },
    editable: true, rename, formula: vi.fn(), summary: vi.fn(), sort: vi.fn(),
  } as never);
  host.append(header.getGui());
  const name = host.querySelector<HTMLInputElement>('[data-column-name="quantity"]')!;
  const next = host.querySelector<HTMLInputElement>('[data-column-formula="quantity"]')!;
  name.focus();
  name.value = "Штук";
  name.blur();
  // Chromium dispatches blur before assigning focus to the click target. Mutating
  // the modal DOM inside this gap makes Radix's observer focus the dialog itself.
  expect(rename).not.toHaveBeenCalled();
  next.focus();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(rename).toHaveBeenCalledWith("Штук");
  expect(document.activeElement).toBe(next);
});

it("flushes the last name edit when its header is destroyed before the next task", async () => {
  const { SqlTableHeader } = await import("../src/client/board/SqlTableHeader");
  const rename = vi.fn();
  const header = new SqlTableHeader();
  header.init({
    definition: { id: "quantity", name: "Количество", type: "number" },
    editable: true, rename, formula: vi.fn(), summary: vi.fn(), sort: vi.fn(),
  } as never);
  host.append(header.getGui());
  const name = host.querySelector<HTMLInputElement>('[data-column-name="quantity"]')!;
  name.focus();
  name.value = "Штук";
  name.blur();
  header.destroy();
  expect(rename).toHaveBeenCalledWith("Штук");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(rename).toHaveBeenCalledTimes(1);
});
