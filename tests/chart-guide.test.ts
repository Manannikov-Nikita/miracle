import { expect, it } from "vitest";
import { chartGuide, chartInputSchema } from "../src/server/chart-guide";
import { chartSpecSchema } from "../src/shared/board-schema";
import { chartSeries } from "../src/client/board/model";
import { chartOptions } from "../src/client/board/chartOptions";
import { preserveResizeAspect } from "../src/client/board/resize-aspect";
import type { Cell } from "../src/shared/types";

it("renders the MCP guide example with its documented group colors and controls", () => {
  const { columns, rows, chart } = chartGuide.example;
  const spec = chartSpecSchema.parse(chart);
  const series = chartSeries(columns, rows as Cell[][], spec);
  const option = chartOptions(columns, spec, series);
  expect(series.map((item) => item.name)).toEqual([
    "Revenue · Online",
    "Revenue · Stores",
  ]);
  expect(option.series.map((item) => item.itemStyle.color)).toEqual([
    "#82aaff",
    "#8ec9b0",
  ]);
  expect(option.yAxis.axisLabel.show).toBe(false);
  expect(option.yAxis.splitLine.show).toBe(false);
  expect(option.series[0].label.show).toBe(true);
  expect(option.series[0].label.formatter({ value: ["October", 320] })).toBe(
    "320",
  );
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
