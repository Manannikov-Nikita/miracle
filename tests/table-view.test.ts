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
  ) {
    await act(async () => {
      root.render(
        createElement(
          "main",
          null,
          createElement("h1", null, "Доска"),
          createElement(TableView, { result, initialRows, spec }),
        ),
      );
    });
  }
  function bodyRows() {
    return [...container.querySelectorAll("tbody .table-view-row")];
  }
  async function sortBy(label: string) {
    const header = [
      ...container.querySelectorAll<HTMLButtonElement>("thead button"),
    ].find((button) => button.textContent?.includes(label))!;
    await act(async () => header.click());
  }
  function names() {
    return bodyRows().map((row) => row.querySelector("td")?.textContent);
  }

  it("omits pagination for a single page while keeping its row range", async () => {
    const result = resultSet();
    await render(
      result,
      [
        ["A", "1"],
        ["B", "2"],
      ],
      createTableSpec(result.columns),
    );
    expect(container.textContent).toContain("1–2 из 2");
    expect(
      container.querySelector('[aria-label="Предыдущая страница"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Следующая страница"]'),
    ).toBeNull();
  });

  it("returns to the first page when a filter reduces a later page to one row", async () => {
    const result = resultSet(205);
    const rows: Cell[][] = Array.from({ length: 205 }, (_, i) => [
      `row-${i + 1}`,
      String(i + 1),
    ]);
    vi.mocked(api).mockResolvedValue({ result, rows });
    const spec: TableSpec = {
      ...createTableSpec(result.columns),
      sort: { column: "value", direction: "asc" },
    };
    await render(result, rows.slice(0, 200), spec);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Следующая страница"]')!
        .click(),
    );
    expect(container.textContent).toContain("201–205 из 205");
    await render(result, rows.slice(0, 200), {
      ...spec,
      filters: [{ column: "name", op: "eq", value: "row-1" }],
    });
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0].textContent).toContain("row-1");
    expect(container.textContent).toContain("1–1 из 1");
    expect(
      container.querySelector('[aria-label="Предыдущая страница"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Следующая страница"]'),
    ).toBeNull();
  });

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

  it("formats locally and preserves raw titles without executing SQL", async () => {
    const result = resultSet();
    const rows: Cell[][] = [
      ["Альфа", "12.3456"],
      ["Бета", null],
    ];
    const plain = createTableSpec(result.columns);
    await render(result, rows, plain);
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
    await render(result, rows, formatted);
    const cell = container.querySelector('tbody td[title="12.3456"]');
    expect(cell?.textContent).toContain("≈12.35 ед.");
    expect(container.querySelector("thead")?.textContent).toContain("Сумма");
    expect(container.querySelector("tbody")?.textContent).toContain("нет");
    expect(api).not.toHaveBeenCalled();
    expect(getResultRows).not.toHaveBeenCalled();
    expect(uncaught).toEqual([]);
  });

  it("sorts the full snapshot locally and cycles back to its original order", async () => {
    const result = resultSet(205);
    const rows: Cell[][] = Array.from({ length: 205 }, (_, i) => [
      `row-${205 - i}`,
      String(205 - i),
    ]);
    const initialRows = rows.slice(0, 200);
    const spec = createTableSpec(result.columns);
    const original = JSON.stringify(spec);
    vi.mocked(api).mockResolvedValue({ result, rows });
    await render(result, initialRows, spec);
    expect(names()[0]).toBe("row-205");
    await sortBy("Значение");
    expect(names()[0]).toBe("row-1");
    expect(names().at(-1)).toBe("row-200");
    expect(container.querySelectorAll("th")[1].getAttribute("aria-sort")).toBe(
      "ascending",
    );
    await sortBy("Значение");
    expect(names()[0]).toBe("row-205");
    expect(container.querySelectorAll("th")[1].getAttribute("aria-sort")).toBe(
      "descending",
    );
    await sortBy("Значение");
    expect(names()[0]).toBe("row-205");
    expect(container.querySelectorAll("th")[1].getAttribute("aria-sort")).toBe(
      "none",
    );
    expect(JSON.stringify(spec)).toBe(original);
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(`/api/result-sets/${result.id}/table`, {
      signal: expect.any(AbortSignal),
    });
    expect(getResultRows).not.toHaveBeenCalled();
  });

  it("keeps local sorting, pagination and scroll when equivalent saved settings echo back", async () => {
    const result = resultSet(205);
    const rows: Cell[][] = Array.from({ length: 205 }, (_, i) => [
      `row-${205 - i}`,
      String(205 - i),
    ]);
    const initialRows = rows.slice(0, 200);
    const spec: TableSpec = {
      ...createTableSpec(result.columns),
      sort: { column: "value", direction: "desc" },
    };
    vi.mocked(api).mockResolvedValue({ result, rows });
    await render(result, initialRows, spec);
    await sortBy("Название");
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe(
      "ascending",
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Следующая страница"]')!
        .click(),
    );
    const pageNames = names();
    expect(container.textContent).toContain("201–205 из 205");
    const scroll = container.querySelector<HTMLDivElement>(
      ".board-table-scroll",
    )!;
    await act(async () => {
      scroll.scrollTop = 84;
      scroll.dispatchEvent(new Event("scroll"));
    });
    vi.mocked(scroll.scrollTo).mockClear();
    await render({ ...result }, initialRows, {
      sort: { direction: "desc", column: "value" },
      sourceSchema: spec.sourceSchema,
      version: 1,
    });
    expect(names()).toEqual(pageNames);
    expect(container.textContent).toContain("201–205 из 205");
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe(
      "ascending",
    );
    expect(scroll.scrollTo).not.toHaveBeenCalled();
    expect(scroll.scrollTop).toBe(84);
    expect(api).toHaveBeenCalledTimes(1);
    expect(getResultRows).not.toHaveBeenCalled();
  });

  it("adopts changed saved sorting and preserves other remote settings", async () => {
    const result = resultSet(3);
    const rows: Cell[][] = [
      ["C", "2"],
      ["A", "3"],
      ["B", "1"],
    ];
    const spec: TableSpec = {
      ...createTableSpec(result.columns),
      sort: { column: "value", direction: "asc" },
    };
    vi.mocked(api).mockResolvedValue({ result, rows });
    await render(result, rows, spec);
    expect(names()).toEqual(["B", "C", "A"]);
    await sortBy("Название");
    expect(names()).toEqual(["A", "B", "C"]);
    const relabeled: TableSpec = {
      ...spec,
      columns: { value: { label: "Сумма" } },
    };
    await render(result, rows, relabeled);
    expect(names()).toEqual(["A", "B", "C"]);
    expect(container.querySelector("thead")?.textContent).toContain("Сумма");
    await render(result, rows, {
      ...relabeled,
      sort: { column: "value", direction: "desc" },
    });
    expect(names()).toEqual(["A", "C", "B"]);
    expect(container.querySelectorAll("th")[1].getAttribute("aria-sort")).toBe(
      "descending",
    );
    await render(result, rows, spec);
    expect(names()).toEqual(["B", "C", "A"]);
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe(
      "none",
    );
  });

  it("clears a local override for another snapshot and ignores the old pending read", async () => {
    const old = resultSet(),
      next = resultSet();
    const pending = deferred<{ result: ResultSet; rows: Cell[][] }>();
    const oldRows: Cell[][] = [
      ["old-B", "2"],
      ["old-A", "1"],
    ];
    const nextRows: Cell[][] = [
      ["next-B", "4"],
      ["next-A", "3"],
    ];
    const spec = createTableSpec(old.columns);
    vi.mocked(api).mockReturnValue(pending.promise);
    await render(old, oldRows, spec);
    await sortBy("Название");
    expect(container.querySelector('[role="status"]')?.textContent).toMatch(
      /Загрузка/,
    );
    await render(next, nextRows, structuredClone(spec));
    expect(names()).toEqual(["next-B", "next-A"]);
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe(
      "none",
    );
    await act(async () => pending.resolve({ result: old, rows: oldRows }));
    expect(names()).toEqual(["next-B", "next-A"]);
    await render(old, oldRows, structuredClone(spec));
    expect(names()).toEqual(["old-B", "old-A"]);
    expect(container.querySelector("th")?.getAttribute("aria-sort")).toBe(
      "none",
    );
    expect(api).toHaveBeenCalledTimes(1);
    expect(uncaught).toEqual([]);
  });

  it("discards an incompatible local sort when a remote update changes the pivot", async () => {
    const result = resultSet(3);
    result.columns.push({ id: "category", name: "Категория", type: "String" });
    const rows: Cell[][] = [
      ["C", "2", "West"],
      ["A", "3", "East"],
      ["B", "1", "West"],
    ];
    const spec = createTableSpec(result.columns);
    vi.mocked(api).mockResolvedValue({ result, rows });
    await render(result, rows, spec);
    await sortBy("Значение");
    expect(names()).toEqual(["B", "C", "A"]);
    await render(result, rows, {
      ...spec,
      pivot: {
        row: "name",
        column: "category",
        value: "value",
        aggregate: "sum",
      },
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(names()).toEqual(["C", "A", "B"]);
    expect(container.querySelectorAll("th")).toHaveLength(3);
    await sortBy("West");
    expect(container.querySelector('[aria-sort="ascending"]')).not.toBeNull();
    await render(result, rows, spec);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(names()).toEqual(["C", "A", "B"]);
    expect(container.querySelector('[aria-sort="ascending"]')).toBeNull();
  });

  it("paginates and scrolls an unsorted snapshot using reads only", async () => {
    const result = resultSet(205);
    const rows: Cell[][] = Array.from({ length: 205 }, (_, i) => [
      `row-${i + 1}`,
      String(i + 1),
    ]);
    const spec = createTableSpec(result.columns);
    vi.mocked(getResultRows).mockResolvedValue({
      result,
      rows: rows.slice(200),
      offset: 200,
      total: 205,
    });
    await render(result, rows.slice(0, 200), spec);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Следующая страница"]')!
        .click(),
    );
    expect(names()).toEqual([
      "row-201",
      "row-202",
      "row-203",
      "row-204",
      "row-205",
    ]);
    await act(async () =>
      container
        .querySelector(".board-table-scroll")!
        .dispatchEvent(new Event("scroll")),
    );
    expect(getResultRows).toHaveBeenCalledExactlyOnceWith(result.id, 200, 200);
    expect(api).not.toHaveBeenCalled();
    expect(spec.sort).toBeUndefined();
  });

  it("keeps schema mismatch errors inside the block and recovers with fresh settings", async () => {
    const result = resultSet();
    const rows: Cell[][] = [["Целая доска", "1"]];
    const valid = createTableSpec(result.columns);
    await render(result, rows, { ...valid, sourceSchema: "outdated" });
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /схема.*изменилась/i,
    );
    const details = container.querySelector<HTMLDetailsElement>("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("pre")?.textContent).toMatch(
      /схема.*изменилась/i,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "свойствах блока",
    );
    expect(container.querySelector('[role="alert"] button')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Доска");
    expect(uncaught).toEqual([]);
    await render(result, rows, valid);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("tbody")?.textContent).toContain(
      "Целая доска",
    );
  });

  it("retries a failed full snapshot read without exposing the technical error by default", async () => {
    const result = resultSet();
    const rows: Cell[][] = [
      ["A", "1"],
      ["B", "2"],
    ];
    vi.mocked(api)
      .mockRejectedValueOnce(
        Object.assign(new Error("Не удалось загрузить снимок"), {
          details: "SQLITE_CANTOPEN: snapshot storage unavailable",
        }),
      )
      .mockResolvedValueOnce({ result, rows });
    await render(result, rows, {
      ...createTableSpec(result.columns),
      sort: { column: "value", direction: "asc" },
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Не удалось загрузить таблицу");
    const details = alert?.querySelector<HTMLDetailsElement>("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("pre")?.textContent).toContain(
      "SQLITE_CANTOPEN: snapshot storage unavailable",
    );
    await act(async () => alert!.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(names()).toEqual(["A", "B"]);
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
