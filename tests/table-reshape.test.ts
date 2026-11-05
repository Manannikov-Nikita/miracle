import { describe, expect, it } from "vitest";
import type { Cell, Column } from "../src/shared/types";
import type { TableSpec } from "../src/shared/tableTypes";
import {
  buildTable,
  createTableSpec,
  formatTableCell,
} from "../src/client/board/tableModel";

const wide: Column[] = [
  { id: "region", name: "Region", type: "String" },
  { id: "year", name: "Year", type: "UInt16" },
  { id: "jan", name: "January", type: "Decimal(38, 8)" },
  { id: "feb", name: "February", type: "Decimal(38, 8)" },
];
const long: Column[] = [
  wide[0],
  wide[1],
  { id: "month", name: "Month", type: "String" },
  { id: "amount", name: "Amount", type: "Decimal(38, 8)" },
];
const melt = (columns = wide): TableSpec => ({
  ...createTableSpec(columns),
  reshape: { kind: "melt", columns: ["jan", "feb"] },
});
const pivot = (columns = long): TableSpec => ({
  ...createTableSpec(columns),
  reshape: {
    kind: "pivot",
    rows: ["region", "year"],
    column: "month",
    value: "amount",
  },
});

describe("table reshape without aggregation", () => {
  it("melts source columns in order and preserves every raw value and duplicate row", () => {
    const result = buildTable(
      wide,
      [
        ["A", 2026, "9007199254740993.100", null],
        ["A", 2026, "9007199254740993.100", null],
      ],
      { ...melt(), reshape: { kind: "melt", columns: ["feb", "jan"] } },
    );
    expect(result.columns.map(({ name, type }) => [name, type])).toEqual([
      ["Region", "String"],
      ["Year", "UInt16"],
      ["Ключ", "String"],
      ["Значение", "Decimal(38, 8)"],
    ]);
    expect(result.rows).toEqual([
      ["A", 2026, "January", "9007199254740993.100"],
      ["A", 2026, "February", null],
      ["A", 2026, "January", "9007199254740993.100"],
      ["A", 2026, "February", null],
    ]);
    expect(result.sourceRowCount).toBe(2);
    expect(result.filteredRowCount).toBe(2);
  });

  it("uses safe Mixed metadata when melting different types without coercing cells", () => {
    const columns = [
      wide[0],
      { id: "flag", name: "Flag", type: "Bool" },
      { id: "details", name: "Details", type: "Object" },
      wide[2],
    ];
    const details = { nested: [true, null, "9007199254740993"] };
    const result = buildTable(columns, [["A", false, details, "1.2300"]], {
      ...createTableSpec(columns),
      reshape: {
        kind: "melt",
        columns: ["flag", "details", "jan"],
        keyName: "Metric",
        valueName: "Raw",
      },
    });
    expect(result.columns.map((c) => c.name)).toEqual([
      "Region",
      "Metric",
      "Raw",
    ]);
    expect(result.columns[2].type).toBe("Mixed");
    expect(result.rows).toEqual([
      ["A", "Flag", false],
      ["A", "Details", details],
      ["A", "January", "1.2300"],
    ]);
    expect(result.rows[1][2]).toBe(details);
  });

  it("can melt all columns and produce a valid empty result", () => {
    const settings = {
      ...createTableSpec(wide),
      reshape: { kind: "melt" as const, columns: wide.map((c) => c.id) },
    };
    expect(buildTable(wide, [["A", 2026, "1", null]], settings).rows).toEqual([
      ["Region", "A"],
      ["Year", 2026],
      ["January", "1"],
      ["February", null],
    ]);
    const empty = buildTable(wide, [], settings);
    expect(empty.rows).toEqual([]);
    expect(empty.columns.map((c) => c.name)).toEqual(["Ключ", "Значение"]);
  });

  it("filters source rows before melting and sorts and formats generated values afterwards", () => {
    const result = buildTable(
      wide,
      [
        ["B", 2026, "0", "1"],
        ["A", 2026, "9007199254740993.125", "2"],
      ],
      {
        ...melt(),
        filters: [{ column: "region", op: "eq", value: "A" }],
        sort: { column: "reshape:melt:value", direction: "asc" },
        columns: { "reshape:melt:value": { format: "number", decimals: 2 } },
      },
    );
    expect(result.rows).toEqual([
      ["A", 2026, "February", "2"],
      ["A", 2026, "January", "9007199254740993.125"],
    ]);
    expect(result.filteredRowCount).toBe(1);
    expect(
      formatTableCell(
        result.rows[1][3],
        result.columns[3],
        result.columns[3].options,
      ).text,
    ).toBe("9,007,199,254,740,993.13");
  });

  it("pivots multiple row keys without changing values and fills absent cells with null", () => {
    const result = buildTable(
      long,
      [
        ["A", 2025, "Jan", "9007199254740993.100"],
        ["A", 2026, "Jan", null],
        ["A", 2026, "Feb", "1.2300"],
      ],
      pivot(),
    );
    expect(result.columns.map(({ name, type }) => [name, type])).toEqual([
      ["Region", "String"],
      ["Year", "UInt16"],
      ["Jan", "Decimal(38, 8)"],
      ["Feb", "Decimal(38, 8)"],
    ]);
    expect(result.rows).toEqual([
      ["A", 2025, "9007199254740993.100", null],
      ["A", 2026, null, "1.2300"],
    ]);
  });

  it("pivots raw booleans, objects, strings and arrays with zero row keys", () => {
    const columns = [long[2], { ...long[3], type: "Mixed" }];
    const result = buildTable(
      columns,
      [
        ["Flag", false],
        ["Object", { b: [1, null] }],
        ["Text", "1.2300"],
        ["Array", [true, "x"]],
      ],
      {
        ...createTableSpec(columns),
        reshape: { kind: "pivot", rows: [], column: "month", value: "amount" },
      },
    );
    expect(result.rows).toEqual([
      [false, { b: [1, null] }, "1.2300", [true, "x"]],
    ]);
    expect(result.columns.every((c) => c.type === "Mixed")).toBe(true);
  });

  it.each([null, "same", "9007199254740993"])(
    "rejects duplicate pivot coordinates even for equal values %j",
    (value) => {
      expect(() =>
        buildTable(
          long,
          [
            ["A", 2026, "Jan", value],
            ["A", 2026, "Jan", value],
          ],
          pivot(),
        ),
      ).toThrow(/конфликт.*ключ/i);
    },
  );

  it("uses typed tuple keys instead of conflating null, text, numbers or tuple boundaries", () => {
    const input: Cell[][] = [
      [null, "x", null, "1"],
      ["NULL", "x", "NULL", "2"],
      [1, "x", 1, "3"],
      ["1", "x", "1", "4"],
      ["a|b", "c", "x", "5"],
      ["a", "b|c", "x", "6"],
    ];
    const result = buildTable(long, input, pivot());
    expect(result.rows).toHaveLength(6);
    expect(result.columns).toHaveLength(7);
    expect(new Set(result.columns.map((c) => c.id)).size).toBe(7);
    expect(
      result.rows.map((row) =>
        row.filter(
          (value) => typeof value === "string" && /^[1-6]$/.test(value),
        ),
      ),
    ).toEqual([["1"], ["2"], ["3"], ["1", "4"], ["5"], ["6"]]);
  });

  it("treats structurally equal object keys as the same coordinate", () => {
    expect(() =>
      buildTable(
        long,
        [
          [{ a: 1, b: [true] }, 2026, { x: 1, y: null }, "1"],
          [{ b: [true], a: 1 }, 2026, { y: null, x: 1 }, "2"],
        ],
        pivot(),
      ),
    ).toThrow(/конфликт/i);
  });

  it("filters before duplicate validation and tolerates temporarily absent generated sort columns", () => {
    const input: Cell[][] = [
      ["A", 2025, "Jan", "1"],
      ["A", 2026, "Feb", "2"],
    ];
    const all = buildTable(long, input, pivot());
    const id = all.columns[3].id;
    const result = buildTable(long, input, {
      ...pivot(),
      filters: [{ column: "year", op: "eq", value: "2025" }],
      sort: { column: id, direction: "asc" },
      columns: { [id]: { label: "February" } },
      order: [id],
    });
    expect(result.rows).toEqual([["A", 2025, "1"]]);
    expect(result.columns[2].id).toBe(all.columns[2].id);
  });

  it("round trips regular wide data through melt and pivot", () => {
    const original: Cell[][] = [
      ["A", 2025, "1.2300", null],
      ["B", 2026, "9007199254740993", "2"],
    ];
    const melted = buildTable(wide, original, melt());
    expect(melted.rows).toHaveLength(4);
    const result = buildTable(melted.columns, melted.rows, {
      ...createTableSpec(melted.columns),
      reshape: {
        kind: "pivot",
        rows: ["region", "year"],
        column: melted.columns[2].id,
        value: melted.columns[3].id,
      },
    });
    expect(result.rows).toEqual(original);
    expect(result.columns.map(({ name, type }) => [name, type])).toEqual(
      wide.map(({ name, type }) => [name, type]),
    );
  });

  it("keeps generated ids distinct from source ids and stable across data filters", () => {
    const columns = [
      { id: "reshape:melt:key", name: "Existing", type: "String" },
      ...wide,
    ];
    const result = buildTable(
      columns,
      [["keep", "A", 2026, "1", "2"]],
      melt(columns),
    );
    expect(new Set(result.columns.map((c) => c.id)).size).toBe(
      result.columns.length,
    );
    expect(result.columns[3].id).toBe("reshape:1:melt:key");
    expect(result.columns[4].id).toBe("reshape:1:melt:value");
    const pivotColumns = [
      { ...long[0], id: 'reshape:pivot:["string","Jan"]' },
      ...long.slice(1),
    ];
    const settings = {
      ...createTableSpec(pivotColumns),
      reshape: {
        kind: "pivot" as const,
        rows: [pivotColumns[0].id],
        column: "month",
        value: "amount",
      },
    };
    const widened = buildTable(
      pivotColumns,
      [["A", 2026, "Jan", "1"]],
      settings,
    );
    expect(new Set(widened.columns.map((c) => c.id)).size).toBe(2);
  });

  it("rejects duplicate melt source names and output names that would lose key identity", () => {
    const duplicateNames = wide.map((c) =>
      c.id === "feb" ? { ...c, name: "January" } : c,
    );
    expect(() => buildTable(duplicateNames, [], melt(duplicateNames))).toThrow(
      /имен/i,
    );
    expect(() =>
      buildTable(wide, [], {
        ...melt(),
        reshape: { kind: "melt", columns: ["jan", "feb"], keyName: "Region" },
      }),
    ).toThrow(/имен/i);
  });

  it.each([
    { kind: "melt", columns: [] },
    { kind: "melt", columns: ["jan", "jan"] },
    { kind: "melt", columns: ["missing"] },
    { kind: "melt", columns: ["jan"], keyName: " " },
    { kind: "pivot", rows: ["region", "region"], column: "jan", value: "feb" },
    { kind: "pivot", rows: ["region"], column: "region", value: "feb" },
    { kind: "pivot", rows: [], column: "jan", value: "jan" },
    { kind: "pivot", rows: [], column: "missing", value: "jan" },
    { kind: "unknown", columns: ["jan"] },
  ])("rejects malformed reshape settings %#", (reshape) => {
    expect(() =>
      buildTable(wide, [], { ...melt(), reshape } as TableSpec),
    ).toThrow();
  });

  it("rejects concurrent aggregate pivot and reshape modes", () => {
    expect(() =>
      buildTable(wide, [], {
        ...melt(),
        pivot: {
          row: "region",
          column: "year",
          value: "jan",
          aggregate: "sum",
        },
      }),
    ).toThrow(/одновременно/i);
  });

  it("rejects melt expansion before allocating output cells", () => {
    const columns = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      name: String(i),
      type: "String",
    }));
    const unread = new Proxy([], {
      get: () => {
        throw new Error("output allocation began");
      },
    }) as Cell[];
    expect(() =>
      buildTable(columns, Array(400).fill(unread), {
        ...createTableSpec(columns),
        reshape: {
          kind: "melt",
          columns: columns.slice(0, 50).map((c) => c.id),
        },
      }),
    ).toThrow(/1.?000.?000/);
  });

  it("allows 200 pivot value columns but rejects 201 and oversized output", () => {
    const input: Cell[][] = Array.from({ length: 201 }, (_, i) => [
      "A",
      2026,
      String(i),
      "1",
    ]);
    expect(buildTable(long, input.slice(0, 200), pivot()).columns).toHaveLength(
      202,
    );
    expect(() => buildTable(long, input, pivot())).toThrow(/200/);
    expect(() =>
      buildTable(
        long,
        Array.from({ length: 5001 }, (_, i) => [
          String(i),
          2026,
          String(i % 200),
          "1",
        ]),
        pivot(),
      ),
    ).toThrow(/1.?000.?000/);
  });
});
