import { expect, it } from "vitest";
import { chartSeries } from "../src/client/board/model";
import {
  autoHistogramBins,
  histogramBinIndex,
  histogramBins,
} from "../src/client/board/histogram-bins";
import { chartSeriesColorKey } from "../src/shared/chart-appearance";
import {
  chartTableData,
  normalizeChartSpec,
  tableChartSeries,
} from "../src/client/board/chartTableModel";
import type { Cell, ChartSpec } from "../src/shared/types";
import { createTableSpec } from "../src/client/board/tableModel";

const columns = [
  { id: "n", name: "Цена", type: "Nullable(Decimal(18,4))" },
  { id: "g", name: "Группа", type: "String" },
  { id: "m", name: "План", type: "Float64" },
];
const chart: ChartSpec = {
  kind: "histogram",
  x: "n",
  y: [],
  legend: true,
  binCount: 3,
};
const counts = (s: ReturnType<typeof chartSeries>[number]) =>
  s.data.map((p) => p[1]);

it("uses shared equal-width intervals, raw identities for breakdowns and a closed final maximum", () => {
  const spec = { ...chart, series: "g" };
  const rows: Cell[][] = [
    [null, "null-only"],
    ["0.1", "А"],
    ["0.2", "А"],
    ["0.3", "А"],
    ["0.4", "А"],
    ["0.2", null],
    ["0.4", "Б"],
  ];
  const groups = chartSeries(columns, rows, spec);
  expect(groups.map((g) => g.name)).toEqual(["А", "∅ NULL", "Б"]);
  const [first, second, third] = groups;
  expect(first.histogramBins).toEqual([
    { lower: 0.1, upper: 0.2 },
    { lower: 0.2, upper: 0.3 },
    { lower: 0.3, upper: 0.4 },
  ]);
  expect(second.histogramBins).toBe(first.histogramBins);
  expect(third.histogramBins).toBe(first.histogramBins);
  expect(first.data).toEqual([
    [0.1, 1],
    [0.2, 1],
    [0.3, 2],
  ]);
  expect(counts(second)).toEqual([0, 1, 0]);
  expect(counts(third)).toEqual([0, 0, 1]);
  expect(second.colorKey).toBe(chartSeriesColorKey("n", "g", null));
  expect(third.metricId).toBe("n");
  expect(
    chartSeries(columns, rows, { ...spec, stacked: true, y: ["missing"] }),
  ).toEqual(groups);
});

it("chooses Sturges bins from all non-null numeric observations; empty ranges and constants are distinct", () => {
  const samples: Cell[][] = Array.from({ length: 8 }, (_, i) => [i - 7]);
  const [s] = chartSeries(columns, [...samples, [null], [null]], {
    ...chart,
    binCount: undefined,
  });
  expect(s.histogramBins).toHaveLength(4);
  expect(s.name).toBe("Цена");
  expect(s.colorKey).toBe(chartSeriesColorKey("n", undefined, undefined));
  expect(s.histogramBins?.map((b) => b.lower)).toEqual([-8, -6, -4, -2]);
  expect(counts(s)).toEqual([1, 2, 2, 3]);
  expect(chartSeries(columns, [], chart)).toEqual([]);
  expect(chartSeries(columns, [[null]], chart)).toEqual([]);
  const [constant] = chartSeries(columns, [[-4], [-4]], {
    ...chart,
    binCount: 100,
  });
  expect(constant.histogramBins).toEqual([{ lower: -4, upper: -4 }]);
  expect(constant.data).toEqual([[-4, 2]]);
  expect(
    chartSeries(columns, samples, { ...chart, binCount: 1 })[0].data,
  ).toEqual([[-7, 8]]);
});

it("keeps complete large inputs and bounds the number of output counters before expanding groups", () => {
  const input: Cell[][] = Array.from({ length: 6000 }, (_, i) => [i - 3000]);
  const [s] = chartSeries(columns, input, { ...chart, binCount: 2 });
  expect(counts(s)).toEqual([3000, 3000]);
  const many: Cell[][] = Array.from({ length: 51 }, (_, i) => [i, String(i)]);
  expect(() =>
    chartSeries(columns, many, { ...chart, series: "g", binCount: 100 }),
  ).toThrow(/5 000/);
  expect(() =>
    chartSeries(
      columns,
      Array.from({ length: 5001 }, (_, i) => [0, String(i)]),
      { ...chart, series: "g" },
    ),
  ).toThrow(/5 000/);
  expect(
    chartSeries(
      columns,
      many.map(([, g]) => [0, g]),
      { ...chart, series: "g", binCount: 100 },
    ),
  ).toHaveLength(51);
});

it("applies table filters and column names without binning rounded display strings or merging mapped groups", () => {
  const table = chartTableData(
    columns,
    [
      [0.1, "A"],
      [0.2, "B"],
      [0.3, "A"],
      [0.4, "B"],
    ],
    {
      ...createTableSpec(columns),
      filters: [{ column: "n", op: "gte", value: "0.2" }],
      columns: {
        n: { label: "Стоимость", format: "number", decimals: 0, prefix: "$" },
        g: {
          mappings: [
            { value: "A", text: "Регион" },
            { value: "B", text: "Регион" },
          ],
        },
      },
    },
  );
  const [one] = tableChartSeries(table, { ...chart, binCount: 2 });
  expect(one.name).toBe("Стоимость");
  expect(counts(one)).toEqual([1, 2]);
  const groups = tableChartSeries(table, {
    ...chart,
    binCount: 2,
    series: "g",
  });
  expect(groups.map((g) => g.name)).toEqual(["Регион", "Регион"]);
  expect(new Set(groups.map((g) => g.colorKey)).size).toBe(2);
  expect(groups.map(counts)).toEqual([
    [1, 1],
    [0, 1],
  ]);
  expect(
    normalizeChartSpec(table.columns, { ...chart, x: "g", y: ["m"] }),
  ).toMatchObject({ x: "n", y: [] });
  expect(normalizeChartSpec([columns[1]], chart)).toMatchObject({
    x: "",
    y: [],
  });
});

it("uses chart-wide numeric validation and omits only unrepresentable internal Float64 boundaries", () => {
  expect(() => chartSeries(columns, [[0, "x"]], { ...chart, x: "g" })).toThrow(
    /числовой/,
  );
  for (const v of [
    "9007199254740993",
    "1.23456789012345678",
    "1e-900",
    Infinity,
  ]) {
    expect(() => chartSeries(columns, [[v]], chart)).toThrow();
  }
  for (const binCount of [0, 101, 1.5, NaN]) {
    expect(() => chartSeries(columns, [[1]], { ...chart, binCount })).toThrow(
      /интервалов/,
    );
  }
  expect(() =>
    chartSeries(columns, [[1, {}]], { ...chart, series: "g" }),
  ).toThrow(/массивы/);
  const m = Number.MAX_VALUE;
  const edges = histogramBins(-m, m, 4);
  expect(edges.map((b) => b.upper)).toEqual([-m / 2, 0, m / 2, m]);
  expect(
    [-m, -m / 2, 0, m / 2, m].map((x) => histogramBinIndex(edges, x)),
  ).toEqual([0, 1, 2, 3, 3]);
  const [small] = chartSeries(
    columns,
    [[0], [Number.MIN_VALUE], [2 * Number.MIN_VALUE]],
    { ...chart, binCount: 100 },
  );
  expect(counts(small)).toEqual([1, 2]);
});

it("aligns a latency distribution to readable 25 ms boundaries while retaining exact manual intervals", () => {
  const samples = Array.from({ length: 4097 }, (_, i) => [
    34 + (i % 338),
    i % 2 ? "А" : "Б",
  ]);
  const groups = chartSeries(columns, samples, {
    ...chart,
    binCount: undefined,
    series: "g",
  });
  expect(groups[0].histogramBins).toBe(groups[1].histogramBins);
  const bins = groups[0].histogramBins!;
  expect(bins[0]).toEqual({ lower: 25, upper: 50 });
  expect(bins.at(-1)).toEqual({ lower: 350, upper: 375 });
  expect(bins.every((b) => b.upper - b.lower === 25)).toBe(true);
  expect(
    groups.flatMap(counts).reduce<number>((sum, v) => sum + (v ?? 0), 0),
  ).toBe(4097);
  const [manual] = chartSeries(columns, samples, { ...chart, binCount: 14 });
  expect(manual.histogramBins![0].lower).toBe(34);
  expect(manual.histogramBins!.at(-1)!.upper).toBe(371);
  expect(manual.histogramBins).toHaveLength(14);
});

it("aligns negative and decimal domains and preserves coverage within numeric and bin limits", () => {
  const negatives = autoHistogramBins(-1.87, -0.04, 32);
  expect(negatives[0]).toEqual({ lower: -2, upper: -1.75 });
  expect(negatives.at(-1)).toEqual({ lower: -0.25, upper: 0 });
  const fractions = autoHistogramBins(0.013, 0.086, 32);
  expect(fractions[0]).toEqual({ lower: 0.01, upper: 0.02 });
  expect(fractions.at(-1)).toEqual({ lower: 0.08, upper: 0.09 });
  expect(histogramBinIndex(fractions, 0.02)).toBe(1);
  expect(autoHistogramBins(7.1, 7.1, 250)).toEqual([
    { lower: 7.1, upper: 7.1 },
  ]);
  const max = Number.MAX_VALUE;
  expect(autoHistogramBins(-max, max, 8192)).toEqual(
    histogramBins(-max, max, 14),
  );
  for (const [min, max] of [
    [-Number.MIN_VALUE, Number.MIN_VALUE],
    [0, Number.MIN_VALUE * 2],
    [1, 1 + Number.EPSILON],
  ]) {
    const bins = autoHistogramBins(min, max, 10000);
    expect(bins[0].lower).toBeLessThanOrEqual(min);
    expect(bins.at(-1)!.upper).toBeGreaterThanOrEqual(max);
    expect(bins.length).toBeLessThanOrEqual(100);
    expect(
      bins.every(
        (b) =>
          Number.isFinite(b.lower) &&
          Number.isFinite(b.upper) &&
          b.upper > b.lower,
      ),
    ).toBe(true);
  }
  expect(autoHistogramBins(-1, 1, 1000, 1)).toEqual([{ lower: -1, upper: 1 }]);
});
