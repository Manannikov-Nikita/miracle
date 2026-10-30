import { describe, expect, it } from "vitest";
import * as echarts from "echarts";
import type GlobalModel from "echarts/lib/model/Global.js";
import type CartesianAxisModel from "echarts/lib/coord/cartesian/AxisModel.js";
import type { Cell, ChartSpec } from "../src/shared/types";
import { chartSeries } from "../src/client/board/model";
import { chartOptions } from "../src/client/board/chartOptions";

const columns = [
  { id: "category", name: "Категория", type: "String" },
  { id: "value", name: "Выручка", type: "Float64" },
  { id: "other", name: "Визиты", type: "Float64" },
  { id: "group", name: "Группа", type: "String" },
];
const horizontal: ChartSpec = {
  kind: "bar",
  orientation: "horizontal",
  x: "category",
  y: ["value"],
  legend: true,
};
const rows: Cell[][] = [
  ["B", 10, 100, "one"],
  ["A", -5, 50, "one"],
  ["C", null, 75, "one"],
];
type InspectableChart = echarts.ECharts & { getModel(): GlobalModel };

function inspect(
  spec: ChartSpec,
  sourceRows: Cell[][],
  verify: (chart: InspectableChart) => void,
) {
  const chart = echarts.init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: 700,
    height: 320,
  }) as InspectableChart;
  try {
    chart.setOption(
      chartOptions(columns, spec, chartSeries(columns, sourceRows, spec)),
    );
    verify(chart);
  } finally {
    chart.dispose();
  }
}

describe("horizontal bar charts", () => {
  it("renders values along X, categories top to bottom, and nulls as gaps", () => {
    inspect(horizontal, rows, (chart) => {
      const x = chart.getModel().getComponent("xAxis") as CartesianAxisModel;
      const y = chart.getModel().getComponent("yAxis") as CartesianAxisModel;
      expect(x.get("type")).toBe("value");
      expect(y.get("type")).toBe("category");
      expect(y.getCategories()).toEqual(["B", "A", "C"]);
      const data = chart.getModel().getSeries()[0].getData();
      const first = data.getItemLayout(0);
      const negative = data.getItemLayout(1);
      const zero = chart.convertToPixel({ xAxisIndex: 0 }, 0) as number;
      expect(first.x).toBeCloseTo(zero, 4);
      expect(first.x + first.width).toBeCloseTo(
        chart.convertToPixel({ xAxisIndex: 0 }, 10) as number,
        4,
      );
      expect(negative.x + negative.width).toBeCloseTo(
        chart.convertToPixel({ xAxisIndex: 0 }, -5) as number,
        4,
      );
      expect(first.y).toBeLessThan(negative.y);
      expect(first.height).toBeGreaterThan(0);
      expect(data.hasValue(2)).toBe(false);
      expect(chart.renderToSVGString()).toContain("Категория");
      expect(chart.renderToSVGString()).toContain("Выручка");
    });
  });

  it.each([
    ["none", ["B", "A", "C"]],
    ["asc", ["A", "B", "C"]],
    ["desc", ["C", "B", "A"]],
  ] as const)(
    "preserves %s category order from top to bottom",
    (sort, expected) => {
      inspect({ ...horizontal, sort }, rows, (chart) => {
        const y = chart.getModel().getComponent("yAxis") as CartesianAxisModel;
        expect(y.getCategories()).toEqual(expected);
        const positions = expected.map(
          (category) =>
            chart.convertToPixel({ yAxisIndex: 0 }, category) as number,
        );
        expect(positions[0]).toBeLessThan(positions[1]);
        expect(positions[1]).toBeLessThan(positions[2]);
      });
    },
  );

  it("keeps sparse stacks, negative totals and independent metrics on horizontal bars", () => {
    const source: Cell[][] = [
      ["B", 2, 20, "one"],
      ["A", 4, 40, "one"],
      ["C", null, 100, "one"],
      ["A", 3, 30, "two"],
      ["B", 5, 50, "two"],
      ["D", 7, 70, "two"],
      ["C", 8, null, "two"],
      ["B", -3, -30, "negative"],
      ["B", -4, -40, "negative2"],
    ];
    inspect(
      { ...horizontal, y: ["value", "other"], series: "group", stacked: true },
      source,
      (chart) => {
        const series = chart.getModel().getSeries();
        const data = (name: string) =>
          series.find((item) => item.name === name)!.getData();
        const totals = (name: string) => {
          const values = data(name);
          const dimension = values.getCalculationInfo("stackResultDimension");
          return Array.from({ length: values.count() }, (_, index) =>
            values.get(dimension, index),
          );
        };
        const y = chart.getModel().getComponent("yAxis") as CartesianAxisModel;
        expect(y.getCategories()).toEqual(["B", "A", "C", "D"]);
        expect(totals("Выручка · two")).toEqual([7, 7, 7, 8]);
        expect(totals("Визиты · two")).toEqual([70, 70, 70, NaN]);
        expect(totals("Выручка · negative2")).toEqual([-7]);
        const first = data("Выручка · one").getItemLayout(0);
        const second = data("Выручка · two").getItemLayout(1);
        const other = data("Визиты · one").getItemLayout(0);
        expect(first.y).toBe(second.y);
        expect(first.y).not.toBe(other.y);
        expect(second.x).toBeCloseTo(first.x + first.width, 4);
      },
    );
  });

  it("moves names and number formatting with the value axis", () => {
    const spec = { ...horizontal, numberFormat: "compact" as const };
    const option = chartOptions(
      columns,
      spec,
      chartSeries(columns, rows, spec),
    );
    expect(option.xAxis.name).toBe("Выручка");
    expect(option.yAxis.name).toBe("Категория");
    expect(option.xAxis.axisLabel.formatter?.(34100)).toBe("34.1k");
    expect(option.yAxis.axisLabel.formatter).toBeUndefined();
    expect(option.tooltip.valueFormatter(["B", 34100])).toBe("B, 34.1k");
  });

  it.each(["line", "area", "scatter"] as const)(
    "ignores saved bar orientation for %s",
    (kind) => {
      const spec = {
        ...horizontal,
        kind,
        ...(kind === "scatter" ? { x: "other" } : {}),
      };
      const option = chartOptions(
        columns,
        spec,
        chartSeries(columns, rows, spec),
      );
      expect(option.xAxis.type).toBe(kind === "scatter" ? "value" : "category");
      expect(option.yAxis.type).toBe("value");
      expect(option.xAxis.name).toBe(
        kind === "scatter" ? "Визиты" : "Категория",
      );
      expect(option.yAxis.name).toBe("Выручка");
    },
  );

  it.each([undefined, "vertical"] as const)(
    "retains vertical bars for orientation %s",
    (orientation) => {
      inspect({ ...horizontal, orientation }, rows, (chart) => {
        const x = chart.getModel().getComponent("xAxis") as CartesianAxisModel;
        const y = chart.getModel().getComponent("yAxis") as CartesianAxisModel;
        expect(x.get("type")).toBe("category");
        expect(y.get("type")).toBe("value");
        const first = chart
          .getModel()
          .getSeries()[0]
          .getData()
          .getItemLayout(0);
        expect(first.y + first.height).toBeCloseTo(
          chart.convertToPixel({ yAxisIndex: 0 }, 10) as number,
          4,
        );
      });
    },
  );
});
