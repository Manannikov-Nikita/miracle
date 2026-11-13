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

it("opens the selected column from its title while sorting remains independent", async () => {
  const { SqlTableHeader } = await import("../src/client/board/SqlTableHeader");
  const openEditor = vi.fn(),
    sort = vi.fn();
  const header = new SqlTableHeader();
  const params = {
    definition: {
      id: "amount",
      name: "Сумма",
      type: "number",
      formula: "Цена * 2",
      summary: "sum",
    },
    editable: true,
    selected: false,
    openEditor,
    sort,
  };
  header.init(params as never);
  host.append(header.getGui());
  expect(
    host.querySelector("input,select,.sql-table-column-formula"),
  ).toBeNull();
  const name = host.querySelector<HTMLButtonElement>(
    '[data-column-name="amount"]',
  )!;
  expect(name.tagName).toBe("BUTTON");
  name.focus();
  expect(openEditor).not.toHaveBeenCalled();
  name.click();
  expect(openEditor).toHaveBeenCalledOnce();
  expect(sort).not.toHaveBeenCalled();
  host.querySelector<HTMLButtonElement>(".sql-table-column-sort")!.click();
  expect(sort).toHaveBeenCalledOnce();
  expect(openEditor).toHaveBeenCalledOnce();
  header.refresh({
    ...params,
    selected: true,
    definition: { ...params.definition, name: "Итог" },
  } as never);
  expect(host.querySelector('[data-column-name="amount"]')).toBe(name);
  expect(name.textContent).toBe("Итог");
  expect(name.getAttribute("aria-expanded")).toBe("true");
});
it("keeps read-only headers as plain names without editor or sorting controls", async () => {
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
    openEditor: vi.fn(),
    sort: vi.fn(),
  } as never);
  host.append(header.getGui());
  expect(host.querySelector("button,input,select")).toBeNull();
  expect(host.textContent).toBe("Сумма");
});
