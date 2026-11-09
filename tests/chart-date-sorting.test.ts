import { describe, expect, it } from "vitest";
import { chartSeries } from "../src/client/board/model";
import { tableChartSeries } from "../src/client/board/chartTableModel";
import { chartOptions } from "../src/client/board/chartOptions";
import type { Cell, ChartSpec, Column } from "../src/shared/types";
import type {
  TableColumnOptions,
  TableViewData,
} from "../src/shared/tableTypes";

const columns = (type = "Date"): Column[] => [
  { id: "date", name: "Дата", type },
  { id: "amount", name: "Выручка", type: "UInt64" },
  { id: "group", name: "Канал", type: "String" },
];
const spec = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({
  kind: "line",
  x: "date",
  y: ["amount"],
  legend: false,
  sort: "asc",
  ...overrides,
});
const table = (rows: Cell[][], options: TableColumnOptions): TableViewData => ({
  columns: columns("String").map((column) => ({
    ...column,
    sourceId: column.id,
    options: column.id === "date" ? options : {},
  })),
  rows,
  sourceRowCount: rows.length,
  filteredRowCount: rows.length,
  summaries: {},
  ranges: {},
});

describe("chronological chart sorting", () => {
  it.each(["asc", "desc"] as const)(
    "sorts native dates %s with timezone and nanosecond precision; missing dates stay last",
    (sort) => {
      const laterNs = "2026-01-01T00:00:00.000000002Z";
      const earlierNs = "2026-01-01T03:00:00.000000001+03:00";
      const previousYear = "2025-12-31 23:59:59.999999999";
      const nextDay = "02.01.2026 00:00:00";
      const rows: Cell[][] = [
        [laterNs, 30],
        [nextDay, 40],
        [null, 50],
        ["not-a-date", 60],
        [earlierNs, 20],
        [previousYear, 10],
      ];
      const ordered = [
        [previousYear, 10],
        [earlierNs, 20],
        [laterNs, 30],
        [nextDay, 40],
      ];
      const series = chartSeries(
        columns("Nullable(DateTime64(9, 'UTC'))"),
        rows,
        spec({ sort }),
      );
      expect(series[0].data).toEqual([
        ...(sort === "desc" ? ordered.toReversed() : ordered),
        ["NULL", 50],
        ["not-a-date", 60],
      ]);
      expect(rows[0][0]).toBe(laterNs);
    },
  );

  it.each(["asc", "desc"] as const)(
    "honors a String-to-date override for %s sorting while retaining display labels",
    (sort) => {
      const rows: Cell[][] = [
        ["01.02.2026", 20],
        ["15.01.2026", 10],
        ["09.12.2025", 5],
        [null, 1],
      ];
      const options: TableColumnOptions = {
        dataType: "date",
        nullText: "Нет даты",
        mappings: [
          { value: "01.02.2026", text: "Февраль" },
          { value: "15.01.2026", text: "Январь" },
          { value: "09.12.2025", text: "Декабрь" },
        ],
      };
      const data = table(rows, options);
      const series = tableChartSeries(data, spec({ sort }));
      const ordered = [
        ["09.12.2025", 5],
        ["15.01.2026", 10],
        ["01.02.2026", 20],
      ];
      const display = [
        ["Декабрь", "5"],
        ["Январь", "10"],
        ["Февраль", "20"],
      ];
      expect(series[0].data).toEqual([
        ...(sort === "desc" ? ordered.toReversed() : ordered),
        ["NULL", 1],
      ]);
      expect(series[0].displayData?.map(({ x, value }) => [x, value])).toEqual([
        ...(sort === "desc" ? display.toReversed() : display),
        ["Нет даты", "1"],
      ]);
      expect(series[0].categoryLabels?.["01.02.2026"]).toBe("Февраль");
      expect(data.rows).toEqual(rows);
    },
  );

  it("preserves source order with sort:none, for both native dates and explicit overrides", () => {
    const rows: Cell[][] = [
      ["01.02.2026", 20],
      [null, 1],
      ["15.01.2026", 10],
      ["09.12.2025", 5],
    ];
    const expected = [
      ["01.02.2026", 20],
      ["NULL", 1],
      ["15.01.2026", 10],
      ["09.12.2025", 5],
    ];
    expect(
      chartSeries(columns(), rows, spec({ sort: "none" }))[0].data,
    ).toEqual(expected);
    expect(
      tableChartSeries(
        table(rows, { dataType: "date" }),
        spec({ sort: "none" }),
      )[0].data,
    ).toEqual(expected);
  });

  it("uses one chronological union for sparse stacked lines, keeping point displays attached", () => {
    const rows: Cell[][] = [
      ["01.02.2026", 20, "B"],
      ["15.01.2026", 10, "B"],
      ["09.12.2025", 5, "A"],
    ];
    const settings = spec({ series: "group", stacked: true });
    const series = chartSeries(
      columns(),
      rows,
      settings,
      (value, _column, role) => ({
        text: role === "category" ? `Дата ${value}` : String(value ?? "NULL"),
      }),
    );
    const dates = ["09.12.2025", "15.01.2026", "01.02.2026"];
    expect(series.map((item) => item.xCategories)).toEqual([dates, dates]);
    expect(series[0].data).toEqual([
      [dates[0], null],
      [dates[1], 10],
      [dates[2], 20],
    ]);
    expect(series[1].data).toEqual([
      [dates[0], 5],
      [dates[1], null],
      [dates[2], null],
    ]);
    expect(series[0].displayData?.map(({ x, value }) => [x, value])).toEqual([
      [`Дата ${dates[0]}`, "NULL"],
      [`Дата ${dates[1]}`, "10"],
      [`Дата ${dates[2]}`, "20"],
    ]);
    expect(chartOptions(columns(), settings, series).xAxis.data).toEqual(dates);
  });

  it.each(["line", "horizontal bar"] as const)(
    "uses a chronological category union for sparse non-stacked %s series",
    (kind) => {
      const rows: Cell[][] = [
        ["01.02.2026", 20, "B"],
        ["15.01.2026", 10, "B"],
        ["09.12.2025", 5, "A"],
      ];
      const settings = spec({
        kind: kind === "line" ? "line" : "bar",
        orientation: kind === "line" ? "vertical" : "horizontal",
        series: "group",
        stacked: false,
      });
      const series = chartSeries(columns(), rows, settings);
      const options = chartOptions(columns(), settings, series);
      const axis = kind === "line" ? options.xAxis : options.yAxis;
      expect(axis.data).toEqual(["09.12.2025", "15.01.2026", "01.02.2026"]);
      expect(series[0].data).toEqual([
        ["15.01.2026", 10],
        ["01.02.2026", 20],
      ]);
      expect(series[1].data).toEqual([["09.12.2025", 5]]);
    },
  );
});
