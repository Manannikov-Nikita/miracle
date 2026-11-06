import { describe, expect, it } from "vitest";
import { fuzzyScore } from "../node_modules/monaco-editor/esm/vs/base/common/filters.js";
import { sqlSuggestions } from "../src/client/sql-completion";
import { clickhouseFunctionSuggestions } from "../src/client/clickhouse-completion";
import type { SchemaTable } from "../src/shared/types";

const tables: SchemaTable[] = [
  {
    schema: "analytics",
    name: "sales records",
    columns: [
      { name: "order total", type: "Float64" },
      { name: "total_count", type: "UInt64" },
    ],
  },
  { schema: "analytics", name: "records_archive" },
];

describe("SQL substring completion", () => {
  it.each([
    ["umIf", "sumIf"],
    ["OrNull", "sumOrNull"],
    ["rNuL", "sumOrNull"],
  ])("matches generated aggregate names anywhere for %s", (typed, wanted) => {
    const sql = `SELECT ${typed}`;
    const items = sqlSuggestions(
      sql,
      sql,
      [],
      { engine: "clickhouse" },
      {
        functions: [{ name: "sum", isAggregate: true }],
        aggregateCombinators: ["If", "OrNull"],
      },
      { prefix: typed, limit: 200 },
    );
    expect(items).toContainEqual(
      expect.objectContaining({ label: wanted, insertText: wanted }),
    );
  });

  it("reserves generated prefix matches before bounding internal aggregate variants", () => {
    const items = clickhouseFunctionSuggestions("sum", {
      functions: [
        ...Array.from({ length: 130 }, (_, index) => ({
          name: `oldSum${index}`,
          isAggregate: true,
        })),
        { name: "sum", isAggregate: true },
      ],
      aggregateCombinators: ["If"],
    });
    const generated = items.filter((item) => item.label.endsWith("If"));
    expect(generated).toHaveLength(120);
    expect(generated[0].label).toBe("sumIf");
    expect(generated.at(-1)?.label).toBe("oldSum118If");
  });

  it("keeps generated internal matches out of row expressions and obeys server combinators", () => {
    const catalog = {
      functions: [
        { name: "sum", isAggregate: true },
        { name: "rank", isAggregate: true },
        { name: "custom", isAggregate: false },
      ],
      aggregateCombinators: ["If"],
    };
    const sql = "SELECT 1 WHERE umIf";
    expect(
      sqlSuggestions(sql, sql, [], { engine: "clickhouse" }, catalog, {
        prefix: "umIf",
      }),
    ).toEqual([]);
    const functions = clickhouseFunctionSuggestions("If", catalog).map(
      (item) => item.label,
    );
    expect(functions).toContain("sumIf");
    expect(functions).not.toContain("rankIf");
    expect(functions).not.toContain("customIf");
    expect(
      clickhouseFunctionSuggestions("OrNull", catalog).map(
        (item) => item.label,
      ),
    ).not.toContain("sumOrNull");
  });

  it("matches names case-insensitively and ranks prefixes before internal matches", () => {
    const sql = "SELECT * FROM analytics.REC";
    const items = sqlSuggestions(sql, sql, tables, {}, undefined, {
      prefix: "REC",
    });
    expect(items.map((item) => item.label)).toEqual([
      "records_archive",
      "sales records",
    ]);
    expect(items.map((item) => item.insertText)).toEqual([
      "records_archive",
      '"sales records"',
    ]);
    expect(items[0].sortText! < items[1].sortText!).toBe(true);
  });

  it("keeps qualified columns scoped to their alias and quotes substring insertions", () => {
    const sql = 'SELECT s.TOt FROM analytics."sales records" s';
    const items = sqlSuggestions(sql, "SELECT s.TOt", tables, {}, undefined, {
      prefix: "TOt",
    });
    expect(items.map((item) => item.insertText)).toEqual([
      "total_count",
      '"order total"',
    ]);
  });

  it("matches schema names without requiring a catalog prefix", () => {
    const sql = "SELECT * FROM lYt";
    const items = sqlSuggestions(sql, sql, [], {}, undefined, {
      prefix: "lYt",
      schemas: [{ catalog: "lake", schema: "analytics" }],
    });
    expect(items).toEqual([
      expect.objectContaining({
        label: "lake.analytics",
        insertText: "lake.analytics",
      }),
    ]);
  });

  it("matches SELECT aliases while keeping completed grouping keys excluded", () => {
    const sql =
      "SELECT lower(city) AS shipping_city, city AS city_code FROM sales GROUP BY city_code, ping";
    const items = sqlSuggestions(
      sql,
      sql,
      [],
      { engine: "clickhouse" },
      undefined,
      {
        prefix: "ping",
      },
    );
    expect(
      items
        .filter((item) => item.detail === "Из SELECT")
        .map((item) => item.insertText),
    ).toEqual(["shipping_city"]);
  });

  it("keeps later prefix matches ahead of a full substring bucket before applying the limit", () => {
    const metadata = [
      ...Array.from({ length: 400 }, (_, index) => ({
        schema: "demo",
        name: `old_events_${index}`,
      })),
      { schema: "demo", name: "events_current" },
    ];
    const sql = "SELECT * FROM demo.events";
    const items = sqlSuggestions(sql, sql, metadata, {}, undefined, {
      prefix: "events",
      limit: 3,
    });
    expect(items.map((item) => item.label)).toEqual([
      "events_current",
      "old_events_0",
      "old_events_1",
    ]);
  });

  it("ranks a column prefix above a selected alias substring within a bounded list", () => {
    const sql =
      'SELECT s."order total" AS subtotal FROM analytics."sales records" s GROUP BY tot';
    const items = sqlSuggestions(
      sql,
      sql,
      tables,
      { engine: "clickhouse" },
      undefined,
      {
        prefix: "tot",
        limit: 1,
      },
    );
    expect(items.map((item) => item.insertText)).toEqual(["total_count"]);
  });

  it("retains schema and keyword categories beside many internal table matches", () => {
    const sql = "SELECT ect";
    const items = sqlSuggestions(
      sql,
      sql,
      Array.from({ length: 500 }, (_, index) => ({
        schema: "selected",
        name: `old_selections_${index}`,
      })),
      {},
      undefined,
      { prefix: "ect", limit: 200 },
    );
    expect(items).toHaveLength(200);
    expect(new Set(items.map((item) => item.kind))).toEqual(
      new Set(["table", "schema", "keyword"]),
    );
  });

  it("passes internal keyword and function matches through Monaco without changing insertion", () => {
    const sql = "SELECT ere";
    const items = sqlSuggestions(
      sql,
      sql,
      [],
      { engine: "clickhouse" },
      {
        functions: [{ name: "customHere", isAggregate: false }],
        aggregateCombinators: [],
      },
      { prefix: "ere" },
    );
    expect(items.map((item) => item.label)).toEqual(
      expect.arrayContaining(["WHERE", "PREWHERE", "customHere"]),
    );
    const scores = items.map((item) => {
      const filter = item.filterText || item.label;
      return fuzzyScore("ere", "ere", 0, filter, filter.toLowerCase(), 0)?.[0];
    });
    expect(scores.every((score) => score !== undefined)).toBe(true);
    expect(new Set(scores).size).toBe(1);
    expect(items.find((item) => item.label === "customHere")?.insertText).toBe(
      "customHere",
    );
  });
});
