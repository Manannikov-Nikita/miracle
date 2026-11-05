import { describe, expect, it } from "vitest";
import * as echarts from "echarts";
import type GlobalModel from "echarts/lib/model/Global.js";
import type { Cell, ChartSpec, Column } from "../src/shared/types";
import type { TableSpec } from "../src/shared/tableTypes";
import { createTableSpec } from "../src/client/board/tableModel";
import { chartSeries } from "../src/client/board/model";
import { chartOptions } from "../src/client/board/chartOptions";
import {
  chartTableData,
  normalizeChartSpec,
  tableChartSeries,
} from "../src/client/board/chartTableModel";

const columns: Column[] = [
  { id: "category", name: "Category", type: "String" },
  { id: "amount", name: "Amount", type: "Decimal(18, 4)" },
  { id: "group", name: "Group", type: "String" },
  { id: "other", name: "Other", type: "Int64" },
];
const spec: ChartSpec = {
  kind: "bar",
  x: "category",
  y: ["amount"],
  series: "group",
  legend: true,
};

describe("charts built from table data", () => {
  it("uses the filtered, sorted, ordered, visible table columns and display names", () => {
    const table = chartTableData(
      columns,
      [
        ["A", "1.2300", "one", 4],
        ["B", "2.5", "two", 5],
        ["C", "3.75", "one", 6],
      ],
      {
        ...createTableSpec(columns),
        filters: [{ column: "group", op: "eq", value: "one" }],
        sort: { column: "amount", direction: "desc" },
        columns: { amount: { label: "Revenue" }, other: { hidden: true } },
        order: ["group", "amount", "category"],
      },
    );
    expect(table.columns.map(({ id, name }) => [id, name])).toEqual([
      ["group", "Group"],
      ["amount", "Revenue"],
      ["category", "Category"],
    ]);
    expect(table.rows).toEqual([
      ["one", "3.75", "C"],
      ["one", "1.2300", "A"],
    ]);
    const series = tableChartSeries(table, spec);
    expect(series[0].data).toEqual([
      ["C", 3.75],
      ["A", 1.23],
    ]);
    expect(series[0].name).toBe("Revenue · one");
  });

  it.each(["aggregate", "melt", "pivot"] as const)(
    "builds plots from the %s table shape",
    (kind) => {
      const base = createTableSpec(columns);
      const settings: TableSpec =
        kind === "aggregate"
          ? {
              ...base,
              pivot: {
                row: "category",
                column: "group",
                value: "amount",
                aggregate: "sum",
              },
            }
          : kind === "melt"
            ? {
                ...base,
                reshape: { kind: "melt", columns: ["amount", "other"] },
              }
            : {
                ...base,
                reshape: {
                  kind: "pivot",
                  rows: ["category"],
                  column: "group",
                  value: "amount",
                },
              };
      const inputColumns = columns;
      settings.sourceSchema = createTableSpec(inputColumns).sourceSchema;
      const table = chartTableData(
        inputColumns,
        [
          ["A", "1.25", "one", 4],
          ["B", "2.5", "two", 5],
        ],
        settings,
      );
      const normalized = normalizeChartSpec(table.columns, spec);
      const series = tableChartSeries(table, normalized);
      expect(series[0].data).toEqual(
        kind === "melt"
          ? [
              ["A", 1.25],
              ["A", 4],
            ]
          : [
              ["A", 1.25],
              ["B", null],
            ],
      );
      expect(normalized.y[0]).not.toBe("amount");
      if (kind !== "melt") expect(normalized.series).toBeUndefined();
    },
  );

  it("honors legacy visibleColumns and retains an intentionally empty selection", () => {
    expect(
      chartTableData(columns, [], undefined, [
        "category",
        "amount",
      ]).columns.map((c) => c.id),
    ).toEqual(["category", "amount"]);
    expect(chartTableData(columns, [], undefined, []).columns).toEqual([]);
  });

  it("repairs only missing chart references and preserves chart appearance and valid choices", () => {
    const visible = [columns[0], columns[1]];
    const saved: ChartSpec = {
      ...spec,
      x: "gone",
      y: ["gone", "amount"],
      orientation: "horizontal",
      palette: "warm",
      sort: "desc",
      showLabels: true,
    };
    expect(normalizeChartSpec(visible, saved)).toEqual({
      ...saved,
      x: "category",
      y: ["amount"],
      series: undefined,
    });
    expect(normalizeChartSpec(visible, { ...saved, y: ["gone"] }).y).toEqual([
      "amount",
    ]);
    expect(normalizeChartSpec(visible, { ...saved, y: [] }).y).toEqual([]);
    const invalidScatter = { ...spec, kind: "scatter" as const };
    expect(normalizeChartSpec(visible, invalidScatter).x).toBe("category");
    expect(() =>
      tableChartSeries(
        chartTableData(visible, [["text", "1"]]),
        normalizeChartSpec(visible, invalidScatter),
      ),
    ).toThrow(/числовой/);
    expect(
      normalizeChartSpec(visible, { ...invalidScatter, x: "gone" }).x,
    ).toBe("amount");
  });

  it("formats labels and tooltip values without replacing raw geometry or merging mapped groups", () => {
    const table = chartTableData(
      columns,
      [
        ["A", "1.2300", "one", 1],
        ["B", "2.5000", "two", 2],
      ],
      {
        ...createTableSpec(columns),
        columns: {
          category: {
            mappings: [
              { value: "A", text: "Same" },
              { value: "B", text: "Same" },
            ],
          },
          group: {
            mappings: [
              { value: "one", text: "Mapped" },
              { value: "two", text: "Mapped" },
            ],
          },
          amount: {
            label: "Revenue",
            format: "currency",
            currency: "EUR",
            decimals: 2,
          },
        },
      },
    );
    const series = tableChartSeries(table, spec);
    expect(series).toHaveLength(2);
    expect(series.map((s) => s.name)).toEqual([
      "Revenue · Mapped",
      "Revenue · Mapped",
    ]);
    expect(series.map((s) => s.data)).toEqual([[["A", 1.23]], [["B", 2.5]]]);
    expect(new Set(series.map((s) => s.colorKey)).size).toBe(2);
    const option = chartOptions(
      table.columns,
      { ...spec, showLabels: true },
      series,
    );
    expect(option.xAxis.axisLabel.formatter?.("A")).toBe("Same");
    expect(option.xAxis.axisLabel.formatter?.("B")).toBe("Same");
    expect(
      option.series[0].label.formatter({ value: ["A", 1.23], dataIndex: 0 }),
    ).toBe("€1.23");
    expect(
      option.tooltip.formatter?.([{ seriesIndex: 1, dataIndex: 0 }]),
    ).toContain("€2.50");
  });

  it("retains exact raw auto display and mapped nulls through sorted sparse stacks", () => {
    const table = chartTableData(
      columns,
      [
        ["B", "2.5000", "one", 1],
        ["A", null, "two", 2],
      ],
      {
        ...createTableSpec(columns),
        columns: { amount: { nullText: "Missing" } },
      },
    );
    const next = {
      ...spec,
      kind: "area" as const,
      stacked: true,
      sort: "asc" as const,
    };
    const series = tableChartSeries(table, next);
    expect(series[0].data).toEqual([
      ["A", null],
      ["B", 2.5],
    ]);
    const option = chartOptions(table.columns, next, series);
    expect(
      option.tooltip.formatter?.([{ seriesIndex: 0, dataIndex: 0 }]),
    ).toContain("Missing");
    expect(
      option.tooltip.formatter?.([{ seriesIndex: 0, dataIndex: 1 }]),
    ).toContain("2.5000");
  });

  it("formats scatter coordinates and per-cell colors without changing positions", () => {
    const table = chartTableData(columns, [["A", "1.25", "one", 4]], {
      ...createTableSpec(columns),
      columns: {
        amount: {
          format: "percent",
          decimals: 1,
          display: "color-text",
          thresholds: [{ value: "1", color: "red" }],
        },
        other: { prefix: "x=" },
      },
    });
    const next = { ...spec, kind: "scatter" as const, x: "other" };
    const series = tableChartSeries(table, next);
    expect(series[0].data).toEqual([[4, 1.25]]);
    const option = chartOptions(table.columns, next, series);
    expect(option.series[0].data[0]).toEqual({
      value: [4, 1.25],
      itemStyle: { color: "#ef9c9c" },
    });
    const tooltip = option.tooltip.formatter?.({
      seriesIndex: 0,
      dataIndex: 0,
    });
    expect(tooltip).toContain("x=4");
    expect(tooltip).toContain("125.0%");
  });

  it("escapes table-authored labels inside HTML chart tooltips", () => {
    const table = chartTableData(columns, [["<img src=x>", "1", "one", 1]], {
      ...createTableSpec(columns),
      columns: { amount: { mappings: [{ value: "1", text: "<script>&" }] } },
    });
    const option = chartOptions(
      table.columns,
      spec,
      tableChartSeries(table, spec),
    );
    const tooltip = option.tooltip.formatter?.({
      seriesIndex: 0,
      dataIndex: 0,
    });
    expect(tooltip).toContain("&lt;img src=x&gt;");
    expect(tooltip).toContain("&lt;script&gt;&amp;");
    expect(tooltip).not.toContain("<img");
  });

  it("keeps chart numeric safety checks after table formatting", () => {
    const table = chartTableData(
      columns,
      [["A", "9007199254740993", "one", 1]],
      {
        ...createTableSpec(columns),
        columns: {
          amount: { mappings: [{ value: "9007199254740993", text: "Small" }] },
        },
      },
    );
    expect(() => tableChartSeries(table, spec)).toThrow(/точност/);
  });

  it("keeps chart number formatting unless a table format or matching mapping overrides it", () => {
    const next = {
      ...spec,
      numberFormat: "percent" as const,
      showLabels: true,
    };
    for (const [settings, expected] of [
      [{}, "12,5%"],
      [{ format: "currency", currency: "EUR", decimals: 2 }, "€0.13"],
      [{ mappings: [{ value: "0.125", text: "Mapped" }] }, "Mapped"],
      [{ mappings: [{ value: "unmatched", text: "Ignored" }] }, "12,5%"],
    ] as const) {
      const table = chartTableData(columns, [["A", "0.125", "one", 1]], {
        ...createTableSpec(columns),
        columns: {
          amount: structuredClone(settings) as TableSpec["columns"][string],
        },
      });
      const option = chartOptions(
        table.columns,
        next,
        tableChartSeries(table, next),
      );
      expect(
        option.series[0].label.formatter({ value: ["A", 0.125], dataIndex: 0 }),
      ).toBe(expected);
      expect(
        option.tooltip.formatter?.({ seriesIndex: 0, dataIndex: 0 }),
      ).toContain(expected);
    }
  });

  it("renders mapped categories and preserves independent legend controls for identical mapped group names", () => {
    const table = chartTableData(
      columns,
      [
        ["A", "1", "one", 1],
        ["B", "2", "two", 2],
      ],
      {
        ...createTableSpec(columns),
        columns: {
          category: { mappings: [{ value: "A", text: "First category" }] },
          group: {
            mappings: [
              { value: "one", text: "Mapped" },
              { value: "two", text: "Mapped" },
            ],
          },
        },
      },
    );
    const option = chartOptions(
      table.columns,
      spec,
      tableChartSeries(table, spec),
    );
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 700,
      height: 300,
    }) as echarts.ECharts & { getModel(): GlobalModel };
    try {
      chart.setOption(option);
      expect(chart.renderToSVGString()).toContain("First category");
      const legendNames = (chart.getModel().getComponent("legend") as any)
        .getData()
        .map((item: any) => item.get("name"));
      expect(legendNames).toHaveLength(2);
      expect(legendNames.map(option.legend.formatter)).toEqual([
        "Amount · Mapped",
        "Amount · Mapped",
      ]);
      chart.dispatchAction({ type: "legendUnSelect", name: legendNames[0] });
      expect(
        chart
          .getModel()
          .getSeries()
          .map((series) => chart.getModel().isSeriesFiltered(series)),
      ).toEqual([true, false]);
    } finally {
      chart.dispose();
    }
  });

  it("leaves the plain chart series contract unchanged", () => {
    const series = chartSeries(columns, [["A", "1.2300", "one", 1]], spec);
    expect(series[0]).not.toHaveProperty("displayData");
    expect(
      chartOptions(columns, spec, series).tooltip.formatter,
    ).toBeUndefined();
  });
});
