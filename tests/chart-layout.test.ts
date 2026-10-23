import { describe, expect, it } from "vitest";
import * as echarts from "echarts";
import type GlobalModel from "echarts/lib/model/Global.js";
import type ComponentModel from "echarts/lib/model/Component.js";
import type ComponentView from "echarts/lib/view/Component.js";
import type Displayable from "zrender/lib/graphic/Displayable.js";
import type Text from "zrender/lib/graphic/Text.js";
import type { ChartSpec } from "../src/shared/types";
import { chartOptions } from "../src/client/board/chartOptions";

// ECharts' public declarations omit the inspection methods used by its views.
// Inspect their rendered geometry so these tests catch overlap, not just options.
type InspectableChart = echarts.ECharts & {
  getModel(): GlobalModel;
  getViewOfComponentModel(model: ComponentModel): ComponentView;
};
type LegendView = ComponentView & {
  _backgroundEl: Displayable;
  _getPageInfo(model: ComponentModel): { pageCount: number };
};
const columns = [
  { id: "x", name: "Длинное название категории X", type: "String" },
  {
    id: "y",
    name: "Длинное название оси Y с дополнительными подробностями показателя",
    type: "Float64",
  },
];
const series = Array.from({ length: 24 }, (_, index) => ({
  name: `Длинное название серии ${index} с дополнительными подробностями`,
  data: [
    ["A very long category label", 10000000],
    ["Another category", 30000000],
  ] as [string, number][],
}));
function bounds(element: Displayable) {
  const rect = element.getBoundingRect().clone();
  rect.applyTransform(element.getComputedTransform());
  return rect;
}
function axisTexts(chart: InspectableChart, dimension: "xAxis" | "yAxis") {
  const texts: Text[] = [];
  const view = chart.getViewOfComponentModel(
    chart.getModel().getComponent(dimension),
  );
  view.group.traverse((element) => {
    if (element.type === "text" && !element.ignore) texts.push(element as Text);
  });
  return texts;
}
function verifyLayout(
  chart: InspectableChart,
  width: number,
  height: number,
  position: string,
) {
  const model = chart.getModel();
  const legendModel = model.getComponent("legend");
  const legend = chart.getViewOfComponentModel(legendModel) as LegendView;
  const legendRect = bounds(legend._backgroundEl);
  const yTexts = axisTexts(chart, "yAxis");
  const title = yTexts.find((text) => text.style.text === columns[1].name)!;
  const titleRect = bounds(title);
  const tickRects = yTexts.filter((text) => text !== title).map(bounds);
  expect(titleRect.width).toBeLessThan(20);
  expect(titleRect.x + titleRect.width).toBeLessThan(
    Math.min(...tickRects.map((rect) => rect.x)),
  );
  for (const text of [...yTexts, ...axisTexts(chart, "xAxis")]) {
    const rect = bounds(text);
    expect(rect.x).toBeGreaterThanOrEqual(-1);
    expect(rect.y).toBeGreaterThanOrEqual(-1);
    expect(
      rect.x + rect.width,
      `${position} ${width}x${height} ${text.style.text}`,
    ).toBeLessThanOrEqual(width + 1);
    expect(rect.y + rect.height).toBeLessThanOrEqual(height + 1);
    // Every visible name and tick stays out of the legend's strip.
    if (position === "left")
      expect(rect.x).toBeGreaterThan(legendRect.x + legendRect.width);
    if (position === "right")
      expect(rect.x + rect.width).toBeLessThan(legendRect.x);
    if (position === "top")
      expect(rect.y).toBeGreaterThan(legendRect.y + legendRect.height);
    if (position === "bottom")
      expect(rect.y + rect.height).toBeLessThan(legendRect.y);
  }
  expect(legendRect.x).toBeGreaterThanOrEqual(0);
  expect(legendRect.y).toBeGreaterThanOrEqual(0);
  expect(legendRect.x + legendRect.width).toBeLessThanOrEqual(width);
  expect(legendRect.y + legendRect.height).toBeLessThanOrEqual(height);
  expect(legend._getPageInfo(legendModel).pageCount).toBeGreaterThan(1);
}

describe("rendered chart layout", () => {
  it.each(["top", "bottom", "left", "right"] as const)(
    "keeps a %s legend separate from names and ticks while resizing and switching kinds",
    (legendPosition) => {
      const chart = echarts.init(null, undefined, {
        renderer: "svg",
        ssr: true,
        width: 700,
        height: 300,
      }) as InspectableChart;
      try {
        for (const kind of [
          "line",
          "bar",
          "area",
          "scatter",
        ] as ChartSpec["kind"][]) {
          const plotSeries =
            kind === "scatter"
              ? series.map((item) => ({
                  ...item,
                  data: [
                    [10000000, 10000000],
                    [30000000, 30000000],
                  ] as [number, number][],
                }))
              : series;
          chart.setOption(
            chartOptions(
              columns,
              { kind, x: "x", y: ["y"], legend: true, legendPosition },
              plotSeries,
            ),
            { notMerge: true },
          );
          for (const [width, height] of [
            [700, 300],
            [300, 260],
            [300, 221],
            [300, 180],
            [280, 143],
            [700, 300],
          ]) {
            chart.resize({ width, height });
            verifyLayout(chart, width, height, legendPosition);
          }
        }
      } finally {
        chart.dispose();
      }
    },
  );

  it.each(["top", "bottom", "left", "right"] as const)(
    "positions a short %s legend at start, center and end",
    (legendPosition) => {
      const chart = echarts.init(null, undefined, {
        renderer: "svg",
        ssr: true,
        width: 700,
        height: 300,
      }) as InspectableChart;
      try {
        const origins = ["start", "center", "end"].map((legendAlign) => {
          chart.setOption(
            chartOptions(
              columns,
              {
                kind: "bar",
                x: "x",
                y: ["y"],
                legend: true,
                legendPosition,
                legendAlign: legendAlign as ChartSpec["legendAlign"],
              },
              [{ ...series[0], name: "Короткая" }],
            ),
            { notMerge: true },
          );
          const legend = chart.getViewOfComponentModel(
            chart.getModel().getComponent("legend"),
          ) as LegendView;
          const rect = bounds(legend._backgroundEl);
          return legendPosition === "left" || legendPosition === "right"
            ? rect.y
            : rect.x;
        });
        expect(origins[0]).toBeLessThan(origins[1]);
        expect(origins[1]).toBeLessThan(origins[2]);
      } finally {
        chart.dispose();
      }
    },
  );
});
