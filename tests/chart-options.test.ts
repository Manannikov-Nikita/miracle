// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { formatChartNumber } from "../src/client/board/chart-number";
import type { ChartSpec } from "../src/shared/types";
import { boardDocumentSchema } from "../src/server/validation";
import { chartSeries } from "../src/client/board/model";
import { mountBoardChart, textNodes } from "./helpers/chart-render";

const columns = [
  { id: "day", name: "Дата", type: "Date" },
  { id: "visits", name: "Визиты", type: "Int64" },
  { id: "revenue", name: "Выручка", type: "Float64" },
];
const spec: ChartSpec = {
  kind: "line",
  x: "day",
  y: ["revenue", "visits"],
  legend: true,
};

describe("chart presentation", () => {
  const chart = mountBoardChart();
  it.each([
    {
      background: "#ffffff",
      muted: "#475569",
      text: "#20252b",
      grid: "#cbd5e1",
    },
    {
      background: "#202124",
      muted: "#a9adb1",
      text: "#eeeff0",
      grid: "#3b3e43",
    },
  ])(
    "keeps slide labels and grid legible on $background without recoloring series",
    async ({ background, muted, text, grid }) => {
      const series = chartSeries(columns, [["2026-11-06", 3, 120]], spec);
      await chart.render({ columns, spec, series });
      const strokes = () =>
        [...chart.host.querySelectorAll(".bk-line")].map((el) =>
          el.getAttribute("stroke"),
        );
      const colors = strokes();
      expect(colors).toHaveLength(2);
      await chart.render({
        columns,
        spec,
        series,
        presentationBackground: background,
      });
      const plot = chart.host.querySelector<HTMLElement>(".bk-chart")!;
      expect(plot.style.getPropertyValue("--bk-muted")).toBe(muted);
      expect(plot.style.getPropertyValue("--bk-text")).toBe(text);
      expect(plot.style.getPropertyValue("--bk-grid")).toBe(grid);
      expect(strokes()).toEqual(colors);
    },
  );

  it("accepts compact chart settings and retains legacy labels when validating a saved board", () => {
    const document = {
      schemaVersion: 1,
      nodes: [
        {
          id: "n",
          type: "artifact",
          position: { x: 0, y: 0 },
          data: {
            kind: "note",
            title: "Chart",
            chart: {
              ...spec,
              numberFormat: "compact",
              xLabel: "Legacy",
              legendPosition: "right",
              legendAlign: "end",
            },
          },
        },
      ],
      edges: [],
    };
    expect(boardDocumentSchema.parse(document)).toEqual(document);
  });

  it("uses the selected columns as axis names, including on legacy boards", async () => {
    const saved = { ...spec, xLabel: "Старая X", yLabel: "Старая Y" };
    await chart.render({
      columns,
      spec: saved,
      series: chartSeries(columns, [["2026-11-06", 3, 120]], saved),
    });
    expect(textNodes(chart.host, ".bk-axis-name")).toEqual([
      "Дата",
      "Выручка, Визиты",
    ]);
  });

  it.each([
    [34100, "34.1k"],
    [-34100, "-34.1k"],
    [0, "0"],
    [-0, "0"],
    [12.34, "12.3"],
    [0.5, "0.5"],
    [0.0123, "0.0123"],
    [0.0000001, "0.0000001"],
    [999.94, "999.9"],
    [999.95, "1k"],
    [999950, "1M"],
    [1000000000, "1G"],
    [2500000000000, "2.5T"],
  ])("formats compact %s as %s", (value, expected) => {
    expect(formatChartNumber(value, "compact")).toBe(expected);
  });

  it("formats both coordinates for raw numeric scatter points and preserves the metric name", async () => {
    const saved: ChartSpec = {
      ...spec,
      kind: "scatter",
      x: "visits",
      y: ["revenue"],
      numberFormat: "compact",
    };
    const data = [
      ["A", 34100, -2500000],
      ["B", 68200, 5000000],
    ];
    await chart.render({
      columns,
      spec: saved,
      series: chartSeries(columns, data, saved),
    });
    await act(async () =>
      chart.host
        .querySelector('svg[role="img"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
        ),
    );
    expect(textNodes(chart.host, ".chart-tooltip-heading strong")).toEqual([
      "Визиты: 34.1k",
    ]);
    expect(textNodes(chart.host, ".chart-tooltip-value")).toEqual(["-2.5M"]);
    expect(
      textNodes(chart.host, ".bk-scatter-tick-x").some((t) => t.includes("k")),
    ).toBe(true);
    expect(
      textNodes(chart.host, ".bk-scatter-tick-y").some((t) => t.includes("M")),
    ).toBe(true);
  });
  it("preserves existing numeric formats", () => {
    expect(formatChartNumber(12.3456789, "auto")).toBe("12,345679");
    expect(formatChartNumber(12.6, "integer")).toBe("13");
    expect(formatChartNumber(12.345, "decimal")).toBe("12,35");
    expect(formatChartNumber(0.341, "percent")).toBe("34,1%");
  });
});
