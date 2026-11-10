import { expect, it } from "vitest";
import {
  localSourceConnection,
  querySourceForConnection,
} from "../src/client/local-source";
import {
  projectFileQuery,
  datasetQuery,
  datasetTables,
} from "../src/client/dataset-sql";
import { sqlSuggestions } from "../src/client/sql-completion";

it("omits stale remote context when sending local SQL to the runner", () => {
  expect(
    querySourceForConnection(
      localSourceConnection,
      {
        database: "old",
        catalog: "previous",
        schema: "legacy",
      },
      "SELECT 42",
    ),
  ).toEqual({ kind: "local", sql: "SELECT 42" });
});

it("opens a project workbook with a literal path and optional sheet", () => {
  expect(
    projectFileQuery("imports/2026's totals.XLSX", "Ann's orders"),
  ).toEqual({
    kind: "local",
    sql: "SELECT *\nFROM read_xlsx('imports/2026''s totals.XLSX', sheet = 'Ann''s orders')\nLIMIT 100;",
  });
  expect(projectFileQuery("unreadable.xls")).toBeUndefined();
});

it("completes named datasets and their SQL-visible columns", () => {
  const tables = datasetTables([
    {
      name: "Sales",
      columns: [{ name: "Total amount", duckdbType: "DECIMAL(20,2)" }],
    },
  ]);
  expect(
    sqlSuggestions(
      "SELECT * FROM Sal",
      "SELECT * FROM Sal",
      tables,
      {
        engine: "duckdb",
      },
      undefined,
      { prefix: "Sal", schemas: [] },
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: "Sales",
        insertText: '"Sales"',
        kind: "table",
      }),
    ]),
  );
  expect(
    sqlSuggestions(
      "SELECT s. FROM Sales s",
      "SELECT s.",
      tables,
      {
        engine: "duckdb",
      },
      undefined,
      { schemas: [] },
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: "Total amount",
        insertText: '"Total amount"',
        kind: "column",
      }),
    ]),
  );
  expect(datasetQuery("Select")).toEqual({
    kind: "local",
    sql: 'SELECT *\nFROM "Select"\nLIMIT 100;',
  });
});
