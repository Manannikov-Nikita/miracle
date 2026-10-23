// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Cell, ResultSet } from "../src/shared/types";
import type { TableSpec } from "../src/shared/tableTypes";
import TableView from "../src/client/board/TableView";
import { createTableSpec } from "../src/client/board/tableModel";
import { api, getResultRows } from "../src/client/api";

vi.mock("../src/client/api", () => ({ api: vi.fn(), getResultRows: vi.fn() }));
// Table behavior is independent of viewport layout; render every row of the
// current 200-row page deterministically instead of depending on jsdom geometry.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: () => number;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * estimateSize(),
        end: (index + 1) * estimateSize(),
      })),
    getTotalSize: () => count * estimateSize(),
    measure: () => {},
    measureElement: () => {},
  }),
}));
let sequence = 0;
function resultSet(rowCount = 2): ResultSet {
  return {
    id: `table-view-test-${++sequence}`,
    columns: [
      { id: "name", name: "Название", type: "String" },
      { id: "value", name: "Значение", type: "Decimal(38, 4)" },
    ],
    rowCount,
    byteCount: 100,
    createdAt: "2026-10-23T00:00:00Z",
    source: { connectionId: "connection", sql: "select name, value" },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
describe("table snapshot rendering", () => {
  let container: HTMLDivElement;
  let root: Root;
  let uncaught: unknown[];
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("IntersectionObserver", undefined);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement("div");
    document.body.append(container);
    uncaught = [];
    root = createRoot(container, {
      onUncaughtError: (error) => uncaught.push(error),
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function render(
    result: ResultSet,
    initialRows: Cell[][],
    spec: TableSpec,
    onChange?: (spec: TableSpec) => void,
  ) {
    await act(async () => {
      root.render(
        createElement(
          "main",
          null,
          createElement("h1", null, "Доска"),
          createElement(TableView, { result, initialRows, spec, onChange }),
        ),
      );
    });
  }
  function bodyRows() {
    return [...container.querySelectorAll("tbody .table-view-row")];
  }

  it("paginates a full snapshot and keeps summaries over all 205 rows", async () => {
    const result = resultSet(205);
    const rows: Cell[][] = Array.from({ length: 205 }, (_, i) => [
      `строка-${i + 1}`,
      String(i + 1),
    ]);
    vi.mocked(api).mockResolvedValue({ result, rows });
    const spec = {
      ...createTableSpec(result.columns),
      columns: { value: { summary: "sum" as const } },
    };
    await render(result, rows.slice(0, 200), spec);
    expect(bodyRows()).toHaveLength(200);
    expect(container.querySelector('tfoot span[title="21115"]')).not.toBeNull();
    expect(container.textContent).toContain("1–200 из 205");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Следующая страница"]')!
        .click(),
    );
    expect(bodyRows()).toHaveLength(5);
    expect(bodyRows()[0].textContent).toContain("строка-201");
    expect(container.textContent).toContain("201–205 из 205");
    expect(container.querySelector('tfoot span[title="21115"]')).not.toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
    expect(getResultRows).not.toHaveBeenCalled();
  });

  it("ignores a late full snapshot after a different snapshot becomes active", async () => {
    const old = resultSet(),
      next = resultSet();
    const oldRead = deferred<{ result: ResultSet; rows: Cell[][] }>();
    const nextRead = deferred<{ result: ResultSet; rows: Cell[][] }>();
    vi.mocked(api).mockImplementation((path) =>
      path.includes(old.id) ? oldRead.promise : nextRead.promise,
    );
    const spec = (result: ResultSet): TableSpec => ({
      ...createTableSpec(result.columns),
      sort: { column: "name", direction: "asc" },
    });
    await render(old, [["old-page", "1"]], spec(old));
    await render(next, [["new-page", "2"]], spec(next));
    await act(async () =>
      oldRead.resolve({ result: old, rows: [["OLD-FULL", "99"]] }),
    );
    expect(container.textContent).not.toContain("OLD-FULL");
    await act(async () =>
      nextRead.resolve({ result: next, rows: [["NEW-FULL", "22"]] }),
    );
    expect(container.textContent).toContain("NEW-FULL");
    expect(container.textContent).not.toContain("OLD-FULL");
    expect(uncaught).toEqual([]);
  });

  it("does not display rows from a previously loaded full snapshot while the next snapshot loads", async () => {
    const old = resultSet(),
      next = resultSet();
    const pending = deferred<{ result: ResultSet; rows: Cell[][] }>();
    vi.mocked(api).mockImplementation((path) =>
      path.includes(old.id)
        ? Promise.resolve({ result: old, rows: [["OLD-LOADED", "99"]] })
        : pending.promise,
    );
    const spec = (result: ResultSet): TableSpec => ({
      ...createTableSpec(result.columns),
      sort: { column: "name", direction: "asc" },
    });
    await render(old, [], spec(old));
    expect(container.textContent).toContain("OLD-LOADED");
    await render(next, [], spec(next));
    expect(container.textContent).not.toContain("OLD-LOADED");
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(
      /Загрузка/,
    );
    await act(async () =>
      pending.resolve({ result: next, rows: [["NEW-LOADED", "2"]] }),
    );
    expect(container.textContent).toContain("NEW-LOADED");
  });

  it("formats locally, preserves raw titles, and changes sorting without executing SQL", async () => {
    const result = resultSet();
    const rows: Cell[][] = [
      ["Альфа", "12.3456"],
      ["Бета", null],
    ];
    const onChange = vi.fn();
    const plain = createTableSpec(result.columns);
    await render(result, rows, plain, onChange);
    const formatted: TableSpec = {
      ...plain,
      columns: {
        value: {
          label: "Сумма",
          format: "number",
          decimals: 2,
          prefix: "≈",
          suffix: " ед.",
          nullText: "нет",
        },
      },
    };
    await render(result, rows, formatted, onChange);
    const cell = container.querySelector('tbody td[title="12.3456"]');
    expect(cell?.textContent).toContain("≈12.35 ед.");
    expect(container.querySelector("thead")?.textContent).toContain("Сумма");
    expect(container.querySelector("tbody")?.textContent).toContain("нет");
    const header = [
      ...container.querySelectorAll<HTMLButtonElement>("thead button"),
    ].find((button) => button.textContent?.includes("Сумма"))!;
    await act(async () => header.click());
    expect(onChange).toHaveBeenCalledWith({
      ...formatted,
      sort: { column: "value", direction: "asc" },
    });
    expect(api).not.toHaveBeenCalled();
    expect(getResultRows).not.toHaveBeenCalled();
    expect(uncaught).toEqual([]);
  });

  it("keeps schema mismatch errors inside the block and recovers with fresh settings", async () => {
    const result = resultSet();
    const rows: Cell[][] = [["Целая доска", "1"]];
    const valid = createTableSpec(result.columns);
    await render(result, rows, { ...valid, sourceSchema: "outdated" });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /схема.*изменилась/i,
    );
    expect(container.querySelector("h1")?.textContent).toBe("Доска");
    expect(uncaught).toEqual([]);
    await render(result, rows, valid);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("tbody")?.textContent).toContain(
      "Целая доска",
    );
  });
  it("shows a row count without the measured column units or precision", async () => {
    const result = resultSet();
    const rows: Cell[][] = [
      ["A", "1.25"],
      ["B", null],
    ];
    vi.mocked(api).mockResolvedValue({ result, rows });
    await render(result, rows, {
      ...createTableSpec(result.columns),
      columns: {
        value: {
          format: "number",
          decimals: 2,
          suffix: " кг",
          summary: "count",
        },
      },
    });
    expect(container.querySelector("tfoot")?.textContent).toBe("Кол-во2");
  });
});
