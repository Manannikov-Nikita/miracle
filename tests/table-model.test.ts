import { describe, expect, it } from "vitest";
import type { Cell, Column } from "../src/shared/types";
import {
  buildTable,
  createTableSpec,
  formatTableCell,
  tableBarPercent,
  tableSourceSchema,
} from "../src/client/board/tableModel";

const columns: Column[] = [
  { id: "r", name: "Region", type: "String" },
  { id: "k", name: "Kind", type: "String" },
  { id: "v", name: "Value", type: "Decimal(38, 8)" },
];
const spec = () => createTableSpec(columns);
const rows: Cell[][] = [
  ["A", "one", "9007199254740993"],
  ["A", "one", "2"],
  ["B", "two", null],
];
const pivot = () => ({
  ...spec(),
  pivot: { row: "r", column: "k", value: "v", aggregate: "sum" as const },
});
const fmt = (
  value: Cell,
  options: Parameters<typeof formatTableCell>[2] = {},
) => formatTableCell(value, columns[2], options);

describe("table transformation", () => {
  it("fingerprints ordered ids names and types", () => {
    expect(tableSourceSchema(columns)).toBe(
      JSON.stringify(columns.map((c) => [c.id, c.name, c.type])),
    );
    expect(tableSourceSchema([...columns].reverse())).not.toBe(
      tableSourceSchema(columns),
    );
  });
  it("migrates legacy visibility including an explicitly empty selection", () => {
    expect(
      buildTable(columns, rows, createTableSpec(columns, ["v"])).columns.map(
        (c) => c.id,
      ),
    ).toEqual(["v"]);
    expect(
      buildTable(columns, rows, createTableSpec(columns, [])).columns,
    ).toEqual([]);
  });
  it("rejects a changed source schema", () =>
    expect(() =>
      buildTable(
        [...columns, { id: "new", name: "N", type: "String" }],
        rows,
        spec(),
      ),
    ).toThrow(/схем/i));
  it("applies raw AND filters before pivot and keeps separate row counts", () => {
    const result = buildTable(columns, rows, {
      ...pivot(),
      filters: [
        { column: "r", op: "eq", value: "A" },
        { column: "v", op: "gt", value: "2" },
      ],
    });
    expect(result.sourceRowCount).toBe(3);
    expect(result.filteredRowCount).toBe(1);
    expect(result.rows).toEqual([["A", "9007199254740993"]]);
  });
  it("sorts unsafe integers exactly and stably", () => {
    const result = buildTable(
      columns,
      [
        ["x", "a", "9007199254740993"],
        ["y", "a", "9007199254740992"],
        ["z", "a", "9007199254740993"],
      ],
      { ...spec(), sort: { column: "v", direction: "asc" } },
    );
    expect(result.rows.map((r) => r[0])).toEqual(["y", "x", "z"]);
  });
  it("orders and hides columns after sorting", () => {
    const result = buildTable(columns, rows, {
      ...spec(),
      order: ["v", "r"],
      columns: { k: { hidden: true } },
    });
    expect(result.columns.map((c) => c.id)).toEqual(["v", "r"]);
    expect(result.rows[0]).toEqual(["9007199254740993", "A"]);
  });
  it("summarizes the entire unpaged dataset", () => {
    const result = buildTable(
      columns,
      Array.from({ length: 350 }, () => ["A", "x", "0.1"]),
      { ...spec(), columns: { v: { summary: "sum" } } },
    );
    expect(result.rows).toHaveLength(350);
    expect(result.summaries.v).toBe("35");
    expect(result.ranges.v).toEqual({ min: "0.1", max: "0.1" });
  });
  it("ignores null in sum and leaves an all-null sum null", () => {
    expect(
      buildTable(columns, [["a", "x", null]], {
        ...spec(),
        columns: { v: { summary: "sum" } },
      }).summaries.v,
    ).toBeNull();
    expect(
      buildTable(columns, rows, {
        ...spec(),
        columns: { v: { summary: "sum" } },
      }).summaries.v,
    ).toBe("9007199254740995");
  });
  it("counts all rows including null", () =>
    expect(
      buildTable(columns, rows, {
        ...spec(),
        columns: { v: { summary: "count" } },
      }).summaries.v,
    ).toBe(3));
  it("rounds averages to twelve decimal places", () =>
    expect(
      buildTable(
        columns,
        [
          ["a", "x", "1"],
          ["a", "x", "0"],
          ["a", "x", "0"],
        ],
        { ...spec(), columns: { v: { summary: "avg" } } },
      ).summaries.v,
    ).toBe("0.333333333333"));
  it("computes min and max exactly", () => {
    expect(
      buildTable(columns, rows, {
        ...spec(),
        columns: { v: { summary: "min" } },
      }).summaries.v,
    ).toBe("2");
    expect(
      buildTable(columns, rows, {
        ...spec(),
        columns: { v: { summary: "max" } },
      }).summaries.v,
    ).toBe("9007199254740993");
  });
  it("aggregates repeated pivot coordinates and fills missing values with null", () => {
    const result = buildTable(columns, rows, pivot());
    expect(result.rows).toEqual([
      ["A", "9007199254740995", null],
      ["B", null, null],
    ]);
    expect(result.columns).toHaveLength(3);
  });
  it("inherits pivot value options without replacing generated captions", () => {
    const result = buildTable(columns, rows, {
      ...pivot(),
      columns: { v: { label: "Sales", format: "currency", currency: "EUR" } },
    });
    expect(result.columns[1].sourceId).toBe("v");
    expect(result.columns[1].name).toContain("one");
    expect(result.columns[1].options.label).toBeUndefined();
    expect(result.columns[1].options.currency).toBe("EUR");
  });
  it("uses typed collision-safe pivot row and column keys", () => {
    const result = buildTable(
      columns,
      [
        [null, null, "1"],
        ["null", "null", "2"],
        [1, 1, "3"],
        ["1", "1", "4"],
      ],
      pivot(),
    );
    expect(result.rows).toHaveLength(4);
    expect(result.columns).toHaveLength(5);
    expect(new Set(result.columns.map((c) => c.id)).size).toBe(5);
    expect(result.columns.map((c) => c.id)).toEqual(
      buildTable(
        columns,
        [
          [null, null, "1"],
          ["null", "null", "2"],
          [1, 1, "3"],
          ["1", "1", "4"],
        ],
        pivot(),
      ).columns.map((c) => c.id),
    );
  });
  it("supports count pivoting a text column", () => {
    expect(
      buildTable(columns, rows, {
        ...spec(),
        pivot: { row: "r", column: "k", value: "r", aggregate: "count" },
      }).rows,
    ).toEqual([
      ["A", 2, null],
      ["B", null, 1],
    ]);
  });
  it("allows exactly 200 pivot value columns and rejects 201", () => {
    const many = Array.from({ length: 201 }, (_, i): Cell[] => [
      "A",
      String(i),
      "1",
    ]);
    expect(
      buildTable(columns, many.slice(0, 200), pivot()).columns,
    ).toHaveLength(201);
    expect(() => buildTable(columns, many, pivot())).toThrow(/200/);
  });
  it("rejects oversized pivot keys", () =>
    expect(() =>
      buildTable(columns, [["a", "x".repeat(10001), "1"]], pivot()),
    ).toThrow(/ключ|идентификатор/i));
  it("rejects more than one million output cells incrementally", () =>
    expect(() =>
      buildTable(
        columns,
        Array.from({ length: 5001 }, (_, i) => [
          String(i),
          String(i % 200),
          "1",
        ]),
        pivot(),
      ),
    ).toThrow(/1.?000.?000/));
  it.each([
    { filters: [{ column: "missing", op: "eq", value: "A" }] },
    { sort: { column: "missing", direction: "asc" } },
    { pivot: { row: "r", column: "r", value: "v", aggregate: "sum" } },
    { pivot: { row: "r", column: "k", value: "r", aggregate: "sum" } },
    { columns: { v: { decimals: 13 } } },
    { columns: { v: { thresholds: [{ value: "no", color: "red" }] } } },
    { filters: [{ column: "v", op: "gt", value: "NaN" }] },
  ])("rejects invalid settings visibly: %j", (invalid) =>
    expect(() =>
      buildTable(columns, rows, { ...spec(), ...invalid } as ReturnType<
        typeof spec
      >),
    ).toThrow(),
  );
  it("supports null and contains filters", () => {
    expect(
      buildTable(columns, rows, {
        ...spec(),
        filters: [{ column: "v", op: "isNull" }],
      }).rows,
    ).toHaveLength(1);
    expect(
      buildTable(columns, rows, {
        ...spec(),
        filters: [{ column: "k", op: "contains", value: "ON" }],
      }).rows,
    ).toHaveLength(2);
  });
  it("rejects invalid numeric values rather than silently corrupting aggregates", () =>
    expect(() =>
      buildTable(columns, [["a", "x", "Infinity"]], {
        ...spec(),
        columns: { v: { summary: "sum" } },
      }),
    ).toThrow(/числ/i));
  it("rejects arithmetic exceeding the exact precision budget instead of rounding a sum", () =>
    expect(() =>
      buildTable(
        columns,
        [
          ["a", "x", "9".repeat(1000)],
          ["a", "x", "2"],
        ],
        { ...spec(), columns: { v: { summary: "sum" } } },
      ),
    ).toThrow(/точност/i));
  it("validates summaries even for hidden text columns", () =>
    expect(() =>
      buildTable(columns, rows, {
        ...spec(),
        columns: { r: { hidden: true, summary: "sum" } },
      }),
    ).toThrow(/числ/i));
  it("rejects averages whose twelve decimal places exceed the precision budget", () => {
    expect(() =>
      buildTable(
        columns,
        [
          ["a", "x", "1e1000"],
          ["a", "x", "0"],
          ["a", "x", "0"],
        ],
        { ...spec(), columns: { v: { summary: "avg" } } },
      ),
    ).toThrow(/точност/i);
  });
  it("allows an exact integer average near the exponent boundary", () => {
    expect(
      buildTable(
        columns,
        [
          ["a", "x", "1e1000"],
          ["a", "x", "0"],
        ],
        { ...spec(), columns: { v: { summary: "avg" } } },
      ).summaries.v,
    ).toBe(`5${"0".repeat(999)}`);
  });
  it("rejects a source sort column absent after pivot", () =>
    expect(() =>
      buildTable(columns, rows, {
        ...pivot(),
        sort: { column: "k", direction: "asc" },
      }),
    ).toThrow(/сортиров/i));
});

describe("table presentation", () => {
  it("preserves exact raw values in auto and text formats", () => {
    expect(fmt("9007199254740993.100").text).toBe("9007199254740993.100");
    expect(fmt("1.2300", { format: "text" }).text).toBe("1.2300");
  });
  it("formats unsafe numbers and rounds decimals without Number conversion", () =>
    expect(
      fmt("9007199254740993.125", { format: "number", decimals: 2 }).text,
    ).toBe("9,007,199,254,740,993.13"));
  it("formats compact, fractional percent and already-percent values", () => {
    expect(fmt("34100", { format: "compact", decimals: 1 }).text).toBe("34.1k");
    expect(fmt("0.12345", { format: "percent", decimals: 2 }).text).toBe(
      "12.35%",
    );
    expect(fmt("12.345", { format: "percent100", decimals: 2 }).text).toBe(
      "12.35%",
    );
  });
  it.each([
    ["RUB", "₽"],
    ["USD", "$"],
    ["EUR", "€"],
  ] as const)("formats %s currency", (currency, symbol) =>
    expect(
      fmt("1234.5", { format: "currency", currency, decimals: 2 }).text,
    ).toBe(`${symbol}1,234.50`),
  );
  it("uses prefix suffix and explicit null labels", () => {
    expect(fmt("12", { prefix: "~", suffix: " ms" }).text).toBe("~12 ms");
    expect(fmt(null, { nullText: "нет", prefix: "~" }).text).toBe("нет");
  });
  it("gives exact value and null mappings precedence over formatting and thresholds", () => {
    expect(
      fmt("1.00", {
        prefix: "~",
        mappings: [{ value: "1.00", text: "OK", color: "blue" }],
        thresholds: [{ value: "0", color: "red" }],
      }),
    ).toEqual({ text: "OK", color: "blue" });
    expect(
      fmt(null, {
        mappings: [{ value: null, text: "Missing", color: "yellow" }],
      }),
    ).toEqual({ text: "Missing", color: "yellow" });
  });
  it("sorts thresholds numerically and uses the highest matching inclusive boundary", () =>
    expect(
      fmt("9007199254740993", {
        thresholds: [
          { value: "9007199254740993", color: "red" },
          { value: "2", color: "green" },
        ],
      }).color,
    ).toBe("red"));
  it("formats ISO dates and datetimes explicitly in UTC", () => {
    expect(fmt("2026-10-23T00:30:00+03:00", { format: "date" }).text).toBe(
      "2026-10-22",
    );
    expect(fmt("2026-10-23T00:30:00+03:00", { format: "datetime" }).text).toBe(
      "2026-10-22 21:30:00 UTC",
    );
    expect(fmt(1720000000, { format: "date" }).text).toBe("1720000000");
  });
  it("formats a duration in seconds", () => {
    expect(fmt("3661.25", { format: "duration", decimals: 2 }).text).toBe(
      "1:01:01.25",
    );
    expect(fmt("-61", { format: "duration", decimals: 0 }).text).toBe(
      "-0:01:01",
    );
  });
  it.each(["abc", "NaN", "Infinity", "0x10", "1e1001"])(
    "falls back to raw unsupported numeric input %s",
    (value) => expect(fmt(value, { format: "number" }).text).toBe(value),
  );
  it("rejects out-of-bound exponents without decimal underflow", () =>
    expect(fmt("1e-1001", { format: "number" }).text).toBe("1e-1001"));
  it("falls back to raw if scaling a percent would overflow", () =>
    expect(fmt("1e1000", { format: "percent" }).text).toBe("1e1000"));
  it("leaves impossible calendar dates unchanged", () =>
    expect(fmt("2026-02-30", { format: "date" }).text).toBe("2026-02-30"));
  it("interprets SQL timestamps as UTC explicitly", () =>
    expect(fmt("2026-10-23 15:35:41", { format: "datetime" }).text).toBe(
      "2026-10-23 15:35:41 UTC",
    ));
  it("computes clamped bar positions precisely", () => {
    const range = { min: "9007199254740992", max: "9007199254740994" };
    expect(tableBarPercent("9007199254740993", range)).toBe(50);
    expect(tableBarPercent("0", range)).toBe(0);
    expect(tableBarPercent("9999999999999999", range)).toBe(100);
    expect(tableBarPercent(null, range)).toBe(0);
    expect(tableBarPercent("3", { min: "3", max: "3" })).toBe(100);
  });
});
