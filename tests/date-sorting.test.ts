import { describe, expect, it } from "vitest";
import { buildTable, createTableSpec } from "../src/shared/tableModel";
import { tableSpecSchema } from "../src/shared/table-schema";
import type { Cell, Column } from "../src/shared/types";
import { isDateColumn } from "../src/shared/column-types";
import { compareDateValues, dateValue } from "../src/shared/date-values";

describe("date semantics", () => {
  it.each([
    "Date",
    "Date32",
    "DateTime('Europe/Moscow')",
    "DateTime64(9, 'UTC')",
    "Nullable(Date)",
    "LowCardinality(Nullable(DateTime64(6)))",
    "date",
    "timestamp",
    "timestamp(9) with time zone",
    "TIMESTAMPTZ",
  ])("recognizes native %s columns", (type) => {
    expect(isDateColumn({ id: "d", name: "d", type })).toBe(true);
  });

  it.each([
    "String",
    "Array(Date)",
    "Map(String, Date)",
    "UInt32",
    "Mixed",
    "DateLabel",
  ])("does not infer dates from %s or display text", (type) =>
    expect(isDateColumn({ id: "d", name: "d", type })).toBe(false),
  );

  it("keeps nanosecond precision and treats equal instants equally", () => {
    expect(
      compareDateValues(
        "2025-01-01 00:00:00.000000002",
        "2025-01-01 00:00:00.000000001",
      ),
    ).toBe(1);
    expect(
      compareDateValues(
        "2025-01-01 00:00:00.1",
        "2025-01-01 00:00:00.100000000",
      ),
    ).toBe(0);
    expect(
      compareDateValues("2025-01-01 03:00:00 +0300", "2025-01-01 00:00:00 UTC"),
    ).toBe(0);
    expect(dateValue("2025-01-01")).toBe(dateValue("01.01.2025"));
    expect(dateValue("2025-01-01T00:00:00Z")).toBe(dateValue("2025-01-01"));
  });

  it.each([
    "2025-02-29",
    "31.04.2025",
    "2025-00-01",
    "2025-01-00",
    "2025-13-01",
    "2025-01-32",
    "2025-01-01T24:00:00Z",
    "2025-01-01T12:60:00Z",
    "2025-01-01T12:00:60Z",
    "2025-01-01T12:00:00+24:00",
    "2025-01-01T12:00:00+00:60",
    "2025-01-01T12:00:00.1234567890Z",
    "01/02/2025",
    "2025",
    "",
    1735689600000,
    null,
  ])("rejects invalid or ambiguous calendar value %s", (value) => {
    expect(dateValue(value)).toBeUndefined();
  });

  it("checks leap days without JavaScript calendar normalization", () => {
    expect(dateValue("2024-02-29")).toBeDefined();
    expect(dateValue("1900-02-29")).toBeUndefined();
    expect(dateValue("2000-02-29")).toBeDefined();
  });
});

describe("date sorting in tables", () => {
  const column = (type: string): Column => ({ id: "date", name: "Дата", type });
  const order = (
    type: string,
    values: Cell[],
    direction: "asc" | "desc" = "asc",
    dataType?: "date",
  ) => {
    const columns = [column(type)];
    return buildTable(
      columns,
      values.map((value) => [value]),
      {
        ...createTableSpec(columns),
        columns: dataType ? { date: { dataType } } : undefined,
        sort: { column: "date", direction },
      },
    ).rows.map(([value]) => value);
  };

  it("sorts native timestamps by their instant, including timezone offsets", () => {
    const earlier = "2025-01-01 01:00:00+03:00";
    const later = "2024-12-31 23:00:00Z";
    expect(order("timestamp(6) with time zone", [later, earlier])).toEqual([
      earlier,
      later,
    ]);
  });

  it("allows a date type override for text without changing stored values", () => {
    const values = ["02.01.2025", "31.12.2024", "12.01.2025"];
    expect(order("String", values, "asc", "date")).toEqual([
      "31.12.2024",
      "02.01.2025",
      "12.01.2025",
    ]);
    expect(order("String", values, "desc", "date")).toEqual([
      "12.01.2025",
      "02.01.2025",
      "31.12.2024",
    ]);
    expect(order("String", values)).toEqual([
      "02.01.2025",
      "12.01.2025",
      "31.12.2024",
    ]);
  });

  it("keeps invalid dates and nulls after dates in both directions", () => {
    const values = ["bad", "2025-02-30", "2025-02-01", null, "2025-01-01"];
    expect(order("Nullable(Date)", values)).toEqual([
      "2025-01-01",
      "2025-02-01",
      "bad",
      "2025-02-30",
      null,
    ]);
    expect(order("Nullable(Date)", values, "desc")).toEqual([
      "2025-02-01",
      "2025-01-01",
      "bad",
      "2025-02-30",
      null,
    ]);
  });

  it("preserves source order without an explicit sort", () => {
    const columns = [column("Date")];
    const rows = [["2025-03-01"], ["2025-01-01"], ["2025-02-01"]];
    expect(buildTable(columns, rows, createTableSpec(columns)).rows).toEqual(
      rows,
    );
  });

  it("persists the date override in the shared request schema", () => {
    const spec = {
      ...createTableSpec([column("String")]),
      columns: { date: { dataType: "date" } },
    };
    expect(tableSpecSchema.parse(spec).columns?.date).toEqual({
      dataType: "date",
    });
    expect(
      tableSpecSchema.safeParse({
        ...spec,
        columns: { date: { dataType: "invalid" } },
      }).success,
    ).toBe(false);
  });
});
