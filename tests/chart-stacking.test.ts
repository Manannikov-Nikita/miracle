import { describe, expect, it } from "vitest";
import * as echarts from "echarts";
import type GlobalModel from "echarts/lib/model/Global.js";
import type SeriesModel from "echarts/lib/model/Series.js";
import type CartesianAxisModel from "echarts/lib/coord/cartesian/AxisModel.js";
import type { Cell, ChartSpec } from "../src/shared/types";
import { chartSeries } from "../src/client/board/model";
import { chartOptions } from "../src/client/board/chartOptions";

const columns = [
  { id: "x", name: "Категория", type: "String" },
  { id: "revenue", name: "Показатель", type: "Float64" },
  // Repeated display names must not merge separate metrics into one stack.
  { id: "visits", name: "Показатель", type: "Float64" },
  { id: "group", name: "Разбивка", type: "String" },
];
const spec: ChartSpec = {
  kind: "bar",
  x: "x",
  y: ["revenue", "visits"],
  series: "group",
  legend: true,
  stacked: true,
};
const rows: Cell[][] = [
  ["A", 2, 20, "one"],
  ["B", 4, 40, "one"],
  ["C", null, 100, "one"],
  ["B", 3, 30, "two"],
  ["A", 5, 50, "two"],
  ["D", 7, 70, "two"],
  ["C", 8, null, "two"],
  ["A", -3, -30, "negative"],
  ["A", -4, -40, "negative2"],
];
function computedStacks(next: ChartSpec, sourceRows = rows) {
  const plotted = chartSeries(columns, sourceRows, next);
  const option = chartOptions(columns, next, plotted);
  const chart = echarts.init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: 700,
    height: 300,
  }) as echarts.ECharts & {
    getModel(): GlobalModel;
    getViewOfSeriesModel(model: SeriesModel): {
      _polyline?: { shape: { points: ArrayLike<number> } };
      _polygon?: { shape: { stackedOnPoints: ArrayLike<number> } };
    };
  };
  try {
    chart.setOption(option);
    return chart
      .getModel()
      .getSeries()
      .map((model, index) => {
        const data = model.getData();
        const resultDimension = data.getCalculationInfo("stackResultDimension");
        const baseDimension = data.getCalculationInfo("stackedOverDimension");
        const linePoints =
          chart.getViewOfSeriesModel(model)._polyline?.shape.points;
        const baselinePoints =
          chart.getViewOfSeriesModel(model)._polygon?.shape.stackedOnPoints;
        return {
          categories: (
            chart.getModel().getComponent("xAxis") as CartesianAxisModel
          ).getCategories(),
          metricId: plotted[index].metricId,
          name: plotted[index].name,
          results: plotted[index].data.map(([x], rowIndex) => ({
            x,
            total: resultDimension
              ? data.get(resultDimension, rowIndex)
              : undefined,
            base: baseDimension ? data.get(baseDimension, rowIndex) : undefined,
            layout: data.getItemLayout(rowIndex),
            point: linePoints
              ? [linePoints[rowIndex * 2], linePoints[rowIndex * 2 + 1]]
              : undefined,
            baselinePoint: baselinePoints
              ? [baselinePoints[rowIndex * 2], baselinePoints[rowIndex * 2 + 1]]
              : undefined,
            expectedPoint: resultDimension
              ? chart.convertToPixel({ seriesIndex: index }, [
                  x,
                  data.get(resultDimension, rowIndex),
                ])
              : undefined,
            expectedBaselinePoint: baseDimension
              ? chart.convertToPixel({ seriesIndex: index }, [
                  x,
                  Number.isNaN(data.get(baseDimension, rowIndex))
                    ? 0
                    : data.get(baseDimension, rowIndex),
                ])
              : undefined,
          })),
        };
      });
  } finally {
    chart.dispose();
  }
}

describe("stacked breakdown charts", () => {
  it("stacks sparse categories by X and keeps metrics with identical names independent", () => {
    const stacks = computedStacks(spec);
    const metric = (metricId: string, group: string) =>
      stacks.find(
        (item) =>
          item.metricId === metricId && item.name.endsWith(` · ${group}`),
      )!;
    expect(
      metric("revenue", "two").results.map(({ x, total }) => [x, total]),
    ).toEqual([
      ["B", 7],
      ["A", 7],
      ["D", 7],
      ["C", 8],
    ]);
    expect(
      metric("visits", "two").results.map(({ x, total }) => [x, total]),
    ).toEqual([
      ["B", 70],
      ["A", 70],
      ["D", 70],
      ["C", NaN],
    ]);
    expect(
      metric("revenue", "one").results.find((item) => item.x === "C")?.total,
    ).toBeNaN();
    expect(
      metric("revenue", "two").results.find((item) => item.x === "C")?.base,
    ).toBeNaN();
    // The two breakdown categories occupy the same bar slot for their metric;
    // another metric occupies a separate slot even when its label is identical.
    const first = metric("revenue", "one").results.find(
      (item) => item.x === "A",
    )!;
    const second = metric("revenue", "two").results.find(
      (item) => item.x === "A",
    )!;
    const other = metric("visits", "one").results.find(
      (item) => item.x === "A",
    )!;
    expect(first.layout.x).toBe(second.layout.x);
    expect(first.layout.x).not.toBe(other.layout.x);
  });

  it.each(["bar", "line", "area"] as const)(
    "keeps positive and negative %s stacks on their respective sides of zero",
    (kind) => {
      const stacks = computedStacks({ ...spec, kind });
      const negative = stacks.find(
        (item) =>
          item.metricId === "revenue" && item.name.endsWith(" · negative"),
      )!;
      const nextNegative = stacks.find(
        (item) =>
          item.metricId === "revenue" && item.name.endsWith(" · negative2"),
      )!;
      expect(negative.results[0].total).toBe(-3);
      expect(negative.results[0].base).toBeNaN();
      expect(nextNegative.results[0].total).toBe(-7);
      expect(nextNegative.results[0].base).toBe(-3);
      if (kind !== "bar") {
        expect(nextNegative.results[0].point![1]).toBeCloseTo(
          nextNegative.results[0].expectedPoint![1],
          4,
        );
        if (kind === "area")
          expect(nextNegative.results[0].baselinePoint![1]).toBeCloseTo(
            nextNegative.results[0].expectedBaselinePoint![1],
            4,
          );
      }
    },
  );

  it.each([
    { ...spec, stacked: undefined },
    { ...spec, stacked: false },
    { ...spec, series: undefined },
    { ...spec, kind: "line" as const, stacked: false },
    { ...spec, kind: "area" as const, stacked: false },
    { ...spec, kind: "scatter" as const, x: "visits" },
  ])(
    "does not stack without a supported kind + enabled setting + breakdown: %j",
    (next) => {
      const plotted = chartSeries(columns, rows, next);
      expect(
        chartOptions(columns, next, plotted).series.every(
          (item) => item.stack === undefined,
        ),
      ).toBe(true);
      expect(
        computedStacks(next).every((item) =>
          item.results.every((point) => point.total === undefined),
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["none", ["10", "2", "30", "1"]],
    ["asc", ["1", "2", "10", "30"]],
    ["desc", ["30", "10", "2", "1"]],
  ] as const)(
    "keeps a global sparse-category order for %s",
    (sort, expected) => {
      const sparse: Cell[][] = [
        ["10", 1, 10, "one"],
        ["2", 2, 20, "two"],
        ["30", 3, 30, "one"],
        ["1", 4, 40, "two"],
      ];
      for (const kind of ["bar", "line", "area"] as const) {
        const result = computedStacks({ ...spec, sort, kind }, sparse)[0];
        expect(result.categories).toEqual(expected);
        if (kind !== "bar")
          expect(result.results.map((point) => point.x)).toEqual(expected);
      }
    },
  );

  it("rejects duplicate X/breakdown rows only for active stacked charts", () => {
    const duplicate: Cell[][] = [
      ["A", 1, 10, "one"],
      ["A", 2, 20, "one"],
    ];
    for (const kind of ["bar", "line", "area"] as const)
      expect(() => chartSeries(columns, duplicate, { ...spec, kind })).toThrow(
        /SQL \(GROUP BY\)/,
      );
    for (const next of [
      { ...spec, stacked: false },
      { ...spec, series: undefined },
      { ...spec, kind: "line" as const, stacked: false },
      { ...spec, kind: "area" as const, stacked: false },
      { ...spec, kind: "scatter" as const, x: "visits" },
    ])
      expect(() => chartSeries(columns, duplicate, next)).not.toThrow();
  });

  it.each(["line", "area"] as const)(
    "renders %s at cumulative totals and keeps missing/null categories as gaps",
    (kind) => {
      const sparse: Cell[][] = [
        ["A", 2, 20, "one"],
        ["B", null, 40, "one"],
        ["C", 4, 40, "one"],
        ["C", 6, 60, "two"],
        ["A", 3, 30, "two"],
        ["D", 8, 80, "two"],
      ];
      const stacks = computedStacks({ ...spec, kind }, sparse);
      const first = stacks.find(
        (item) => item.metricId === "revenue" && item.name.endsWith(" · one"),
      )!;
      const second = stacks.find(
        (item) => item.metricId === "revenue" && item.name.endsWith(" · two"),
      )!;
      const otherMetric = stacks.find(
        (item) => item.metricId === "visits" && item.name.endsWith(" · two"),
      )!;
      expect(otherMetric.results.map(({ total }) => total)).toEqual([
        50,
        NaN,
        100,
        80,
      ]);
      expect(second.results.map(({ x, total }) => [x, total])).toEqual([
        ["A", 5],
        ["B", NaN],
        ["C", 10],
        ["D", 8],
      ]);
      expect(first.results.map(({ x, total }) => [x, total])).toEqual([
        ["A", 2],
        ["B", NaN],
        ["C", 4],
        ["D", NaN],
      ]);
      for (const result of second.results) {
        if (Number.isNaN(result.total)) {
          expect(result.point![1]).toBeNaN();
          continue;
        }
        expect(result.point![0]).toBeCloseTo(result.expectedPoint![0], 4);
        expect(result.point![1]).toBeCloseTo(result.expectedPoint![1], 4);
        if (kind === "area") {
          expect(result.baselinePoint![0]).toBeCloseTo(
            result.expectedBaselinePoint![0],
            4,
          );
          expect(result.baselinePoint![1]).toBeCloseTo(
            result.expectedBaselinePoint![1],
            4,
          );
          if (result.x !== "D")
            expect(result.baselinePoint![1]).not.toBe(
              second.results.find((point) => point.x === "D")!
                .baselinePoint![1],
            );
        } else expect(result.baselinePoint).toBeUndefined();
      }
      expect(sparse).toEqual([
        ["A", 2, 20, "one"],
        ["B", null, 40, "one"],
        ["C", 4, 40, "one"],
        ["C", 6, 60, "two"],
        ["A", 3, 30, "two"],
        ["D", 8, 80, "two"],
      ]);
    },
  );

  it.each(["line", "area"] as const)(
    "limits sparse %s expansion before allocating gaps",
    (kind) => {
      const sparse: Cell[][] = Array.from({ length: 51 }, (_, index) => [
        String(index),
        index,
        index,
        `group-${index}`,
      ]);
      expect(() => chartSeries(columns, sparse, { ...spec, kind })).toThrow(
        /5 000/,
      );
      expect(() => chartSeries(columns, sparse, spec)).not.toThrow();
      expect(() =>
        chartSeries(columns, sparse, { ...spec, kind, stacked: false }),
      ).not.toThrow();
    },
  );

  it("clears stacks and area bands while switching types and disabling stacking", () => {
    const chart = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: 700,
      height: 300,
    }) as echarts.ECharts & { getModel(): GlobalModel };
    try {
      for (const next of [
        { ...spec, kind: "line" as const },
        { ...spec, kind: "area" as const },
        spec,
        { ...spec, kind: "area" as const, stacked: false },
        { ...spec, kind: "scatter" as const, x: "visits" },
        { ...spec, kind: "area" as const },
      ]) {
        chart.setOption(
          chartOptions(columns, next, chartSeries(columns, rows, next)),
          { notMerge: true },
        );
        const models = chart.getModel().getSeries();
        const active = next.kind !== "scatter" && next.stacked;
        for (const model of models) {
          expect(
            Boolean(model.getData().getCalculationInfo("stackResultDimension")),
          ).toBe(Boolean(active));
          expect(Boolean(model.get("areaStyle"))).toBe(next.kind === "area");
        }
      }
    } finally {
      chart.dispose();
    }
  });

  it("preserves source rows and null values when preparing and rendering stacks", () => {
    const original = structuredClone(rows);
    computedStacks({ ...spec, sort: "asc" });
    expect(rows).toEqual(original);
    expect(chartSeries(columns, rows, spec)[0].data[2]).toEqual(["C", null]);
  });
});
