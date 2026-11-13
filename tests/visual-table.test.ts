import { describe, expect, it } from "vitest";
import {
  createEmptyVisualTable,
  createResultVisualTable,
  renameVisualTableColumn,
  setVisualTableCell,
  visualTableSpecSchema,
} from "../src/shared/visual-table";
import type { ResultSet } from "../src/shared/types";

const result: ResultSet = {
  id: "28cbf200-a1b9-4ed3-b6ea-d0db36935476",
  columns: [
    { id: "quantity", name: "Количество", type: "Int64" },
    { id: "price", name: "Цена", type: "Decimal(20,4)" },
  ],
  rowCount: 2,
  byteCount: 100,
  createdAt: "2026-11-13T00:00:00.000Z",
  source: {
    connectionId: "04dfc44d-ecc6-4ce2-8d83-8403bb40fb94",
    sql: "select * from sales",
  },
};

describe("visual table document", () => {
  it("creates isolated editable empty rows and stores cell changes without mutating the original", () => {
    const table = createEmptyVisualTable();
    expect(table.columns).toHaveLength(3);
    expect(table.rows).toHaveLength(5);
    expect(new Set(table.rows!.map((row) => row.id)).size).toBe(5);
    const next = setVisualTableCell(
      table,
      table.rows![0].id,
      table.columns[1].id,
      "9007199254740993.01",
    );
    expect(next.edits[0].value).toBe("9007199254740993.01");
    expect(table.edits).toEqual([]);
    expect(visualTableSpecSchema.parse(next)).toEqual(next);
  });
  it("anchors SQL columns and edits to the immutable snapshot", () => {
    const table = createResultVisualTable(result);
    expect(table.sourceResultSetId).toBe(result.id);
    expect(table.rows).toBeUndefined();
    expect(table.columns.map((c) => c.sourceColumnId)).toEqual([
      "quantity",
      "price",
    ]);
    expect(() =>
      setVisualTableCell(
        table,
        "different-snapshot:0",
        table.columns[0].id,
        10,
      ),
    ).toThrow();
    expect(
      setVisualTableCell(table, `${result.id}:0`, table.columns[0].id, 10)
        .edits,
    ).toHaveLength(1);
  });
  it("renames references without rewriting string literals or longer names", () => {
    const table = createEmptyVisualTable();
    table.columns = [
      { id: "a", name: "Цена", type: "number" },
      { id: "b", name: "ЦенаНовая", type: "number" },
      {
        id: "c",
        name: "Расчёт",
        type: "text",
        formula: "concat('Цена', [Цена], Цена, ЦенаНовая)",
      },
    ];
    table.rows = [];
    const next = renameVisualTableColumn(table, "a", "Цена со скидкой");
    expect(next.columns[2].formula).toBe(
      "concat('Цена', [Цена со скидкой], [Цена со скидкой], ЦенаНовая)",
    );
    expect(table.columns[0].name).toBe("Цена");
  });
  it("rejects inconsistent identities, over-limit inputs and unsafe number values", () => {
    const table = createEmptyVisualTable();
    const bad = structuredClone(table);
    bad.columns[1].name = bad.columns[0].name;
    expect(visualTableSpecSchema.safeParse(bad).success).toBe(false);
    expect(
      visualTableSpecSchema.safeParse({
        ...table,
        rows: Array.from({ length: 1001 }, (_, i) => ({
          id: String(i),
          values: {},
        })),
      }).success,
    ).toBe(false);
    expect(() =>
      setVisualTableCell(
        table,
        table.rows![0].id,
        table.columns[0].id,
        Number.NaN,
      ),
    ).toThrow();
    expect(() =>
      setVisualTableCell(
        table,
        table.rows![0].id,
        table.columns[1].id,
        9007199254740992,
      ),
    ).toThrow();
    expect(
      visualTableSpecSchema.safeParse({
        ...createResultVisualTable(result),
        rows: [],
      }).success,
    ).toBe(false);
  });
});

import { evaluateVisualTable } from "../src/server/visual-table";
function manual() {
  const table = createEmptyVisualTable();
  table.columns = [
    { id: "qty", name: "Количество", type: "number", summary: "sum" },
    { id: "price", name: "Цена", type: "number", summary: "avg" },
    {
      id: "amount",
      name: "Сумма",
      type: "number",
      formula: "Количество * Цена",
      summary: "sum",
    },
    {
      id: "discount",
      name: "Скидка",
      type: "number",
      formula: "[Сумма] * 0.1",
    },
  ];
  table.rows = [
    { id: "one", values: { qty: "12", price: "250" } },
    { id: "two", values: { qty: "8", price: "600" } },
    { id: "three", values: { qty: null, price: "30" } },
  ];
  return table;
}
describe("DuckDB visual transformations", () => {
  it("calculates dependencies after local overrides and retains nulls", async () => {
    let table = setVisualTableCell(manual(), "one", "qty", "20");
    let output = await evaluateVisualTable({ table });
    expect(String(output.rows[0].values.amount)).toBe("5000");
    expect(String(output.summaries.amount)).toBe("9800");
    expect(output.rows[2].values.amount).toBeNull();
    table = setVisualTableCell(table, "one", "amount", "100");
    output = await evaluateVisualTable({ table });
    expect(String(output.rows[0].values.discount)).toBe("10.0");
    expect(String(output.summaries.amount)).toBe("4900");
  });
  it("keeps decimal and large integer source values exact in calculations and totals", async () => {
    const table = createResultVisualTable(result);
    table.columns.push({
      id: "amount",
      name: "Итого",
      type: "number",
      formula: "Количество + Цена",
      summary: "sum",
    });
    const output = await evaluateVisualTable({
      table,
      source: {
        result,
        rows: [
          ["9007199254740993", "0.01"],
          ["2", "0.02"],
        ],
      },
    });
    expect(output.rows[0].values.quantity).toBe("9007199254740993");
    expect(output.rows[0].values.amount).toBe("9007199254740993.01");
    expect(output.summaries.amount).toBe("9007199254740995.03");
  });
  it("computes totals over all filtered rows before pagination and keeps row IDs stable", async () => {
    const table = manual();
    table.filters = [{ columnId: "price", op: "gte", value: "200" }];
    table.sort = { columnId: "amount", direction: "desc" };
    const output = await evaluateVisualTable({ table, offset: 1, limit: 1 });
    expect(output.totalRowCount).toBe(2);
    expect(output.rows.map((r) => r.id)).toEqual(["one"]);
    expect(String(output.summaries.amount)).toBe("7800");
  });
  it("evaluates window aggregates and parameterizes quoted scalar strings", async () => {
    const table = manual();
    table.columns.push({
      id: "all",
      name: "Все",
      type: "number",
      formula: "SUM([Сумма])",
    });
    table.columns.push({
      id: "label",
      name: "Текст",
      type: "text",
      formula: "concat('D''Angelo', ' ; DROP TABLE source;')",
    });
    const output = await evaluateVisualTable({ table });
    expect(String(output.rows[0].values.all)).toBe("7800");
    expect(output.rows[0].values.label).toBe("D'Angelo ; DROP TABLE source;");
    expect(output.sql).not.toContain("DROP TABLE");
    expect(output.parameters).toContain(" ; DROP TABLE source;");
  });
  it("rejects stale or incomplete snapshots, bad pages and unsafe input numbers", async () => {
    const table = createResultVisualTable(result);
    await expect(
      evaluateVisualTable({
        table,
        source: {
          result: { ...result, id: "a48b7423-b326-4792-80fd-d766ec983812" },
          rows: [
            [1, 2],
            [3, 4],
          ],
        },
      }),
    ).rejects.toThrow(/сним/);
    await expect(
      evaluateVisualTable({ table, source: { result, rows: [[1, 2]] } }),
    ).rejects.toThrow(/непол/);
    await expect(
      evaluateVisualTable({
        table,
        source: {
          result: { ...result, columns: [...result.columns].reverse() },
          rows: [
            [1, 2],
            [3, 4],
          ],
        },
      }),
    ).rejects.toThrow(/схем/);
    await expect(
      evaluateVisualTable({ table: manual(), limit: 2001 }),
    ).rejects.toThrow();
    await expect(
      evaluateVisualTable({
        table,
        source: {
          result,
          rows: [
            [9007199254740992, 2],
            [3, 4],
          ],
        },
      }),
    ).rejects.toThrow(/точност/);
  });
  it.each([
    "read_csv('/etc/passwd')",
    "1; SELECT 2",
    "(SELECT 1)",
    "Количество + unknown",
    "SUM(SUM(Количество))",
  ])("rejects unsafe or invalid expression %s", async (formula) => {
    const table = manual();
    table.columns[2].formula = formula;
    await expect(evaluateVisualTable({ table })).rejects.toThrow();
  });
  it("rejects cycles and decimal values outside the supported precision instead of truncating", async () => {
    const table = manual();
    table.columns[2].formula = "[Скидка] * 10";
    await expect(evaluateVisualTable({ table })).rejects.toThrow(/Цикл/);
    table.columns[2].formula = "Количество * Цена";
    table.rows![0].values.price = "0.000000000000000000000000000000000000001";
    await expect(evaluateVisualTable({ table })).rejects.toThrow(/точност/);
  });
});

describe("visual table precision and isolation boundaries", () => {
  it("does not silently narrow precise decimals through approximate average or division", async () => {
    const table = manual();
    table.rows = [
      { id: "one", values: { qty: "0.1234567890123456789", price: "1" } },
    ];
    table.columns[0].summary = "avg";
    await expect(evaluateVisualTable({ table })).rejects.toThrow(/точност/);
    table.columns[0].summary = "none";
    table.columns[2].formula = "Количество / 3";
    await expect(evaluateVisualTable({ table })).rejects.toThrow(/точност/);
  });
  it("rejects source type reinterpretation and edits outside existing snapshot rows", async () => {
    const table = createResultVisualTable(result);
    table.columns[0].type = "text";
    await expect(
      evaluateVisualTable({
        table,
        source: {
          result,
          rows: [
            [1, 2],
            [3, 4],
          ],
        },
      }),
    ).rejects.toThrow(/тип/i);
    table.columns[0].type = "number";
    table.edits.push({
      rowId: `${result.id}:2`,
      columnId: table.columns[0].id,
      value: "3",
    });
    await expect(
      evaluateVisualTable({
        table,
        source: {
          result,
          rows: [
            [1, 2],
            [3, 4],
          ],
        },
      }),
    ).rejects.toThrow(/строк/);
  });
  it("retains numeric source order across the :9 to :10 row-ID boundary", async () => {
    const source = {
      result: { ...result, rowCount: 12 },
      rows: Array.from({ length: 12 }, (_, i) => [String(i), "1"]),
    };
    const table = createResultVisualTable(source.result);
    const output = await evaluateVisualTable({
      table,
      source,
      offset: 9,
      limit: 3,
    });
    expect(output.rows.map((row) => row.id)).toEqual([
      `${result.id}:9`,
      `${result.id}:10`,
      `${result.id}:11`,
    ]);
  });
  it("handles quotes in names and keeps concurrent evaluations isolated", async () => {
    const left = manual();
    left.columns[0].name = 'Кол"ичество';
    left.columns[2].formula = '[Кол"ичество] * Цена';
    const right = setVisualTableCell(manual(), "one", "qty", "1");
    const [a, b] = await Promise.all([
      evaluateVisualTable({ table: left }),
      evaluateVisualTable({ table: right }),
    ]);
    expect(String(a.rows[0].values.amount)).toBe("3000");
    expect(String(b.rows[0].values.amount)).toBe("250");
  });
});

describe("visual table nullable and named expressions", () => {
  it("does not rename unquoted NULL/TRUE literals when a column has that name", () => {
    const table = manual();
    table.columns[0].name = "NULL";
    table.columns[2].formula = "coalesce([NULL], NULL)";
    expect(
      renameVisualTableColumn(table, "qty", "Количество").columns[2].formula,
    ).toBe("coalesce([Количество], NULL)");
  });
  it("supports boolean source columns, text NULL formulas and fractional computed overrides", async () => {
    const table = manual();
    table.columns.push({
      id: "label",
      name: "Заметка",
      type: "text",
      formula: "NULL",
    });
    table.columns.push({
      id: "flag",
      name: "Активен",
      type: "boolean",
      formula: "Количество > 10",
    });
    const edited = setVisualTableCell(
      table,
      "one",
      "amount",
      "0.1234567890123456789",
    );
    const output = await evaluateVisualTable({ table: edited });
    expect(output.rows[0].values.label).toBeNull();
    expect(output.rows[0].values.flag).toBe(true);
    expect(output.rows[0].values.discount).toBe("0.01234567890123456789");
    const boolResult = {
      ...result,
      rowCount: 2,
      columns: [{ id: "active", name: "Активен", type: "Bool" }],
    };
    const boolTable = createResultVisualTable(boolResult);
    const boolOutput = await evaluateVisualTable({
      table: boolTable,
      source: { result: boolResult, rows: [[true], [false]] },
    });
    expect(boolOutput.rows.map((row) => row.values.active)).toEqual([
      true,
      false,
    ]);
  });
});

describe("visual table bounded output", () => {
  it("treats missing prototype-shaped column IDs as NULL and rejects oversized computed cells", async () => {
    const table = createEmptyVisualTable();
    table.columns = [{ id: "toString", name: "Текст", type: "text" }];
    table.rows = [{ id: "one", values: {} }];
    expect(
      (await evaluateVisualTable({ table })).rows[0].values.toString,
    ).toBeNull();
    table.rows[0].values.toString = "a".repeat(5001);
    table.columns.push({
      id: "large",
      name: "Большой",
      type: "text",
      formula: "concat([Текст], [Текст])",
    });
    await expect(evaluateVisualTable({ table })).rejects.toThrow(/10 000/);
  });
});

it("rejects an override that DuckDB CASE would narrow to fit a calculated decimal", async () => {
  const table = manual();
  table.rows = [
    {
      id: "one",
      values: { qty: "99999999999999999999999999999999999999", price: "1" },
    },
  ];
  table.columns = table.columns.filter((c) => c.id !== "discount");
  table.columns[1].summary = "none";
  const edited = setVisualTableCell(table, "one", "amount", "0.00001");
  await expect(evaluateVisualTable({ table: edited })).rejects.toThrow(
    /точност/,
  );
});

it("supports explicit decimal ROUND precision and rejects fractional precision", async () => {
  const table = manual();
  table.rows = [{ id: "one", values: { qty: "1.2345", price: "1" } }];
  table.columns[2].formula = "round(Количество, 2)";
  expect((await evaluateVisualTable({ table })).rows[0].values.amount).toBe(
    "1.23",
  );
  table.columns[2].formula = "round(Количество, 2.5)";
  await expect(evaluateVisualTable({ table })).rejects.toThrow(/цел/);
});

describe("lossless decimal common types", () => {
  const huge = "99999999999999999999999999999999999999";
  it.each([
    `if(true, 0.00001, ${huge})`,
    `coalesce(0.00001, ${huge})`,
    `least(0.00001, ${huge})`,
    `greatest(0.00001, ${huge})`,
    `nullif(0.00001, ${huge})`,
  ])("rejects common-type coercion that narrows %s", async (formula) => {
    const table = manual();
    table.columns = table.columns.slice(0, 3);
    table.columns[2].summary = "none";
    table.rows = [{ id: "one", values: { qty: "1", price: "1" } }];
    table.columns[2].formula = formula;
    await expect(evaluateVisualTable({ table })).rejects.toThrow(/точност/);
  });
  it("keeps ordinary nullable and mixed-scale expressions exact", async () => {
    const table = manual();
    table.columns[2].formula =
      "if(Количество > 10, coalesce(NULL, 0.00001), greatest(0.01, 0.001))";
    const output = await evaluateVisualTable({ table });
    expect(output.rows[0].values.amount).toBe("0.00001");
    expect(output.rows[1].values.amount).toBe("0.01000");
  });
  it("rejects numeric comparisons and filters that discard fractional precision", async () => {
    const table = manual();
    table.rows = [
      { id: "one", values: { qty: "0", price: "1" } },
      { id: "two", values: { qty: huge, price: "1" } },
    ];
    table.columns = table.columns.slice(0, 2);
    table.columns[1].summary = "none";
    table.columns.push({
      id: "compare",
      name: "Равно",
      type: "boolean",
      formula: "Количество = 0.00001",
    });
    await expect(evaluateVisualTable({ table })).rejects.toThrow(/точност/);
    table.columns.pop();
    table.filters = [{ columnId: "qty", op: "eq", value: "0.00001" }];
    await expect(evaluateVisualTable({ table })).rejects.toThrow(/точност/);
  });
});

it.each([
  "0.1234567890123456789 + (0 / 2)",
  "0.1234567890123456789 * sqrt(1)",
  "(0 / 2) - 0.1234567890123456789",
])("rejects transitive floating point promotion of %s", async (formula) => {
  const table = manual();
  table.columns[2].formula = formula;
  await expect(evaluateVisualTable({ table })).rejects.toThrow(/точност/);
});

it.each([
  ["0.00000001 / 2", 0.000000005],
  ["if(true, 0.00000001, 1 / 2)", 0.00000001],
])(
  "accepts equivalent small decimal/float representations for %s",
  async (formula, expected) => {
    const table = manual();
    table.columns = table.columns.slice(0, 3);
    table.columns[2].formula = String(formula);
    table.columns[2].summary = "none";
    expect((await evaluateVisualTable({ table })).rows[0].values.amount).toBe(
      expected,
    );
  },
);

it.each([
  "coalesce(NULL, NULL)",
  "if(true, NULL, NULL)",
  "greatest(NULL, NULL)",
  "nullif(NULL, NULL)",
  "coalesce(coalesce(NULL, NULL), NULL)",
])("allows all-NULL common types for %s", async (formula) => {
  const table = createEmptyVisualTable();
  table.columns = [{ id: "nil", name: "Пусто", type: "text", formula }];
  table.rows = [{ id: "one", values: {} }];
  expect((await evaluateVisualTable({ table })).rows[0].values.nil).toBeNull();
});

it("rejects guard expansion before building or running oversized SQL", async () => {
  const table = createEmptyVisualTable();
  const formula = "coalesce(".repeat(50) + "1" + ", 1)".repeat(50);
  table.columns = Array.from({ length: 50 }, (_, index) => ({
    id: `c${index}`,
    name: `Число${index}`,
    type: "number" as const,
    formula,
  }));
  table.rows = [{ id: "one", values: {} }];
  await expect(evaluateVisualTable({ table })).rejects.toThrow(
    /сложн|размер.*SQL/i,
  );
}, 10000);

it("keeps a NULL-only formula column usable by downstream COALESCE", async () => {
  const table = createEmptyVisualTable();
  table.columns = [
    { id: "nil", name: "Пусто", type: "text", formula: "NULL" },
    {
      id: "next",
      name: "Далее",
      type: "text",
      formula: "coalesce([Пусто], NULL)",
    },
  ];
  table.rows = [{ id: "one", values: {} }];
  expect((await evaluateVisualTable({ table })).rows[0].values.next).toBeNull();
});

it("allows a small decimal override on a floating-point formula", async () => {
  const table = manual();
  table.columns = table.columns.slice(0, 3);
  table.columns[2].formula = "Количество / 2";
  table.columns[2].summary = "none";
  const edited = setVisualTableCell(table, "one", "amount", "0.00000001");
  expect(
    (await evaluateVisualTable({ table: edited })).rows[0].values.amount,
  ).toBe(0.00000001);
});
