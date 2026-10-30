import { describe, expect, it } from "vitest";
import {
  dateRangeDates,
  hasDatePlaceholder,
  substituteDate,
  type DateRangeOptions,
} from "../src/shared/date-batch";
const range = (value: Partial<DateRangeOptions> = {}): DateRangeOptions => ({
  startDate: "2026-10-01",
  endDate: "2026-10-03",
  granularity: "day",
  retries: 2,
  ...value,
});

describe("calendar date ranges", () => {
  it("includes both day endpoints and handles leap days", () => {
    expect(dateRangeDates(range())).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(
      dateRangeDates(range({ startDate: "2024-02-28", endDate: "2024-03-01" })),
    ).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
  });
  it("iterates calendar Mondays across a year boundary", () => {
    expect(
      dateRangeDates(
        range({
          granularity: "week",
          startDate: "2025-12-22",
          endDate: "2026-01-05",
        }),
      ),
    ).toEqual(["2025-12-22", "2025-12-29", "2026-01-05"]);
  });
  it("iterates month starts without month-end drift", () => {
    expect(
      dateRangeDates(
        range({
          granularity: "month",
          startDate: "2025-12-01",
          endDate: "2026-03-01",
        }),
      ),
    ).toEqual(["2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01"]);
  });
  it.each([
    { granularity: "week", startDate: "2026-10-01", endDate: "2026-10-05" },
    { granularity: "week", startDate: "2026-10-05", endDate: "2026-10-06" },
    { granularity: "month", startDate: "2026-10-15", endDate: "2026-11-01" },
    { granularity: "month", startDate: "2026-10-01", endDate: "2026-11-15" },
  ] as const)(
    "rejects nonaligned endpoints rather than silently rounding %j",
    (dates) => {
      expect(() => dateRangeDates(range(dates))).toThrow();
    },
  );
  it.each([
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-1-01",
    "0000-01-01",
    "2026-01-01T00:00:00Z",
  ])("rejects invalid calendar date %s", (date) => {
    expect(() => dateRangeDates(range({ startDate: date }))).toThrow();
  });
  it("rejects reversed dates, invalid retries and oversized ranges", () => {
    expect(() => dateRangeDates(range({ startDate: "2026-10-04" }))).toThrow();
    for (const retries of [-1, 1.5, 11, NaN])
      expect(() => dateRangeDates(range({ retries }))).toThrow();
    expect(() =>
      dateRangeDates(range({ startDate: "2000-01-01", endDate: "2050-01-01" })),
    ).toThrow();
  });
  it("uses UTC calendar dates across daylight saving transitions and supports one-date ranges", () => {
    expect(
      dateRangeDates(range({ startDate: "2026-03-28", endDate: "2026-03-30" })),
    ).toEqual(["2026-03-28", "2026-03-29", "2026-03-30"]);
    expect(
      dateRangeDates(
        range({
          startDate: "9999-12-01",
          endDate: "9999-12-01",
          granularity: "month",
        }),
      ),
    ).toEqual(["9999-12-01"]);
  });
});

describe("SQL date parameter", () => {
  it("quotes a bare parameter and replaces dates inside existing literals", () => {
    const sql =
      "SELECT {{date}}, '{{date}}', DATE '{{date}}', '{{date}} 00:00:00'";
    expect(hasDatePlaceholder(sql)).toBe(true);
    expect(substituteDate(sql, "2024-02-29")).toBe(
      "SELECT '2024-02-29', '2024-02-29', DATE '2024-02-29', '2024-02-29 00:00:00'",
    );
  });
  it("ignores comments and quoted identifiers", () => {
    const sql =
      'SELECT "{{date}}", `{{date}}` -- {{date}}\n/* nested /* {{date}} */ {{date}} */';
    expect(hasDatePlaceholder(sql)).toBe(false);
    expect(substituteDate(sql, "2026-10-01")).toBe(sql);
    expect(hasDatePlaceholder("SELECT 1 # {{date}}", "clickhouse")).toBe(false);
  });
  it("preserves comment tokens inside strings and escaped quote semantics", () => {
    expect(
      substituteDate(
        "SELECT '-- {{date}}', 'a''{{date}}' /* {{date}} */",
        "2026-10-01",
        "trino",
      ),
    ).toBe("SELECT '-- 2026-10-01', 'a''2026-10-01' /* {{date}} */");
    expect(
      substituteDate("SELECT 'a\\'{{date}}'", "2026-10-01", "clickhouse"),
    ).toBe("SELECT 'a\\'2026-10-01'");
  });
  it("handles ClickHouse heredocs as string values", () => {
    expect(
      substituteDate(
        "SELECT $tag${{date}}$tag$, {{date}}",
        "2026-10-01",
        "clickhouse",
      ),
    ).toBe("SELECT $tag$2026-10-01$tag$, '2026-10-01'");
  });
  it("rejects non-date substitution values", () => {
    expect(() =>
      substituteDate("SELECT {{date}}", "2026-10-01'; DROP TABLE x"),
    ).toThrow();
  });
});
