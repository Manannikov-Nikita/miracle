import { expect, it } from "vitest";
import { chartGuide, chartInputSchema } from "../src/server/chart-guide";
import { composedMetricStyle } from "../src/shared/chart-appearance";
import { chartSpecSchema } from "../src/shared/board-schema";
import { chartSeries } from "../src/client/board/model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import BoardChartPlot from "../src/client/board/BoardChartPlot";
import { preserveResizeAspect } from "../src/client/board/resize-aspect";
import type { Cell } from "../src/shared/types";

it("renders the MCP guide example with its documented group colors and controls", () => {
  const { columns, rows, chart } = chartGuide.example;
  const spec = chartSpecSchema.parse(chart);
  const series = chartSeries(columns, rows as Cell[][], spec);
  const svg = renderToStaticMarkup(
    createElement(BoardChartPlot, { columns, spec, series, label: "Example" }),
  );
  expect(series.map((item) => item.name)).toEqual([
    "Revenue · Online",
    "Revenue · Stores",
  ]);
  expect(svg).toContain('fill="#82aaff"');
  expect(svg).toContain('fill="#8ec9b0"');
  expect(svg).not.toContain('class="bk-grid"');
  expect(svg).not.toContain(">Revenue</text>");
  expect(svg).toMatch(/class="bk-(?:value|inside)"[^>]*>320</);
});

it("advertises the same accepted HEX casing as persistence", () => {
  const colorsSchema = chartInputSchema.properties.seriesColors;
  const color = colorsSchema.additionalProperties;
  if (typeof color !== "object" || color === null || !color.pattern)
    throw new Error("Missing series color pattern");
  const advertised = new RegExp(color.pattern);
  for (const value of ["#82aaff", "#AABbCC", "blue", "#abcd", "#12345678"]) {
    expect(advertised.test(value)).toBe(
      chartSpecSchema.safeParse({
        ...chartGuide.example.chart,
        seriesColors: { example: value },
      }).success,
    );
  }
});

it("gives MCP resize examples that match the actual Shift corner geometry", () => {
  const { before, bottomRightPatch, topLeftPatch } = chartGuide.resize.example;
  const start = {
    ...before.position,
    width: before.width,
    height: before.height,
  };
  expect(
    preserveResizeAspect({ ...start, ...bottomRightPatch }, start, {
      right: true,
      bottom: true,
    }),
  ).toEqual({ ...start, ...bottomRightPatch });
  expect(
    preserveResizeAspect(
      {
        ...topLeftPatch.position,
        width: topLeftPatch.width,
        height: topLeftPatch.height,
      },
      start,
      { top: true, left: true },
    ),
  ).toEqual({
    ...topLeftPatch.position,
    width: topLeftPatch.width,
    height: topLeftPatch.height,
  });
});

it("round-trips the new chart kinds and composed marks through the advertised schema", () => {
  for (const kind of ["composed", "sparkline", "heatmap"]) {
    const chart = {
      kind,
      x: "month",
      y: ["revenue", "plan", "baseline"],
      legend: true,
      legendPosition: "bottom",
      legendAlign: "end",
      metricStyles: { plan: "area" },
    };
    const saved = chartSpecSchema.parse(JSON.parse(JSON.stringify(chart)));
    expect(saved).toEqual(chart);
    expect(saved.y.map((id) => composedMetricStyle(saved, id))).toEqual([
      "bar",
      "area",
      "line",
    ]);
  }
  const chart = chartGuide.example.chart;
  const invalid = { ...chart, metricStyles: { revenue: "pie" } };
  expect(chartSpecSchema.safeParse(invalid).success).toBe(false);
  const tooMany = Object.fromEntries(
    Array.from({ length: 21 }, (_, i) => [String(i), "bar"]),
  );
  expect(
    chartSpecSchema.safeParse({ ...chart, metricStyles: tooMany }).success,
  ).toBe(false);
  expect(chartInputSchema.properties.metricStyles.maxProperties).toBe(20);
});

it("builds a global category order across sparse series for each standard categorical chart", () => {
  const { columns, chart } = chartGuide.example;
  const rows = [
    ["C", 1, "one"],
    ["A", 2, "two"],
    ["B", null, "one"],
  ];
  for (const kind of [
    "line",
    "bar",
    "composed",
    "sparkline",
    "heatmap",
  ] as const) {
    for (const sort of ["none", "asc", "desc"] as const) {
      const result = chartSeries(columns, rows, { ...chart, kind, sort });
      expect(result[0].xCategories).toEqual(
        sort === "none"
          ? ["C", "A", "B"]
          : sort === "asc"
            ? ["A", "B", "C"]
            : ["C", "B", "A"],
      );
      expect(result[1].xCategories).toBe(result[0].xCategories);
    }
  }
});

it("requires unambiguous heatmap cells and bounds the size of sparse matrices", () => {
  const { columns, chart } = chartGuide.example;
  const heatmap = { ...chart, kind: "heatmap" as const };
  const duplicate = [
    ["A", 1, "region"],
    ["A", 2, "region"],
  ];
  expect(() => chartSeries(columns, duplicate, heatmap)).toThrow(
    /Ячейке тепловой карты/,
  );
  expect(() =>
    chartSeries(columns, duplicate, {
      ...heatmap,
      kind: "sparkline",
      stacked: true,
    }),
  ).not.toThrow();
  const sparse = Array.from({ length: 71 }, (_, i) => [i, i, String(i)]);
  expect(() => chartSeries(columns, sparse, heatmap)).toThrow(/5 000/);
});
