import { describe, expect, it } from "vitest";
import * as echarts from "echarts";
import type GlobalModel from "echarts/lib/model/Global.js";
import type ComponentModel from "echarts/lib/model/Component.js";
import type ComponentView from "echarts/lib/view/Component.js";
import type Displayable from "zrender/lib/graphic/Displayable.js";
import MarkerModel from "echarts/lib/component/marker/MarkerModel.js";
import type { Cell, ChartSpec } from "../src/shared/types";
import { chartSeries } from "../src/client/board/model";
import {
  chartOptions,
  formatChartNumber,
} from "../src/client/board/chartOptions";

const columns = [
  { id: "x", name: "Категория", type: "String" },
  { id: "revenue", name: "Выручка", type: "Float64" },
  { id: "visits", name: "Посещения", type: "Float64" },
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
  ["positive", 12, 120, "one"],
  ["positive", 18, 180, "two"],
  ["negative", -6, -60, "one"],
  ["negative", -9, -90, "two"],
  ["mixed", 7, -70, "one"],
  ["mixed", -2, 20, "two"],
  ["zero", 0, 0, "one"],
  ["cancelled", 5, 50, "one"],
  ["cancelled", -5, -50, "two"],
  ["sparse", null, 3, "one"],
  ["sparse", 4, null, "two"],
  ["missing", null, null, "one"],
];

type InspectableChart = echarts.ECharts & {
  getModel(): GlobalModel;
  getViewOfComponentModel(model: ComponentModel): ComponentView;
};
function bounds(element: Displayable) {
  const rectangle = element.getBoundingRect().clone();
  rectangle.applyTransform(element.getComputedTransform());
  return rectangle;
}
function render(
  next: ChartSpec = spec,
  sourceRows = rows,
  selected?: Record<string, boolean>,
  sourceColumns = columns,
) {
  const plotted = chartSeries(sourceColumns, sourceRows, next);
  const option = chartOptions(
    sourceColumns,
    next,
    plotted,
    undefined,
    selected,
  );
  const chart = echarts.init(null, undefined, {
    renderer: "svg",
    ssr: true,
    width: 800,
    height: 500,
  }) as InspectableChart;
  chart.setOption(option);
  return { chart, option, plotted };
}

describe("totals on stacked bars", () => {
  it("creates one numeric total for each metric/category and no helper series", () => {
    const { chart, option, plotted } = render();
    try {
      expect(option.series).toHaveLength(plotted.length);
      expect(chart.getModel().getSeries()).toHaveLength(plotted.length);
      const totals = option.series.flatMap((item) =>
        (item.markPoint?.data ?? []).map((point) => ({
          metric: item.stack,
          category: point.coord[0],
          total: point.value,
        })),
      );
      for (const [metric, multiplier] of [
        ["revenue", 1],
        ["visits", 10],
      ] as const) {
        const matching = totals.filter(
          (item) => item.metric === `metric:${metric}`,
        );
        expect(matching).toHaveLength(6);
        const value = (category: string) =>
          matching.find((item) => item.category === category)?.total;
        expect(value("positive")).toBe(30 * multiplier);
        expect(value("negative")).toBe(-15 * multiplier);
        expect(value("mixed")).toBe(metric === "revenue" ? 5 : -50);
        expect(value("zero")).toBe(0);
        expect(value("cancelled")).toBe(0);
        expect(value("sparse")).toBe(metric === "revenue" ? 4 : 3);
        expect(value("missing")).toBeUndefined();
      }
      expect(option.legend.data).toEqual(
        option.series.map((item) => item.name),
      );
      for (const item of option.series.filter((item) => item.markPoint)) {
        expect(item.markPoint!.silent).toBe(true);
        expect(item.markPoint!.tooltip.show).toBe(false);
        expect(item.markPoint!.symbolSize).toBe(0);
      }
    } finally {
      chart.dispose();
    }
  });

  it.each([
    { ...spec, showTotals: false },
    { ...spec, stacked: false },
    { ...spec, series: undefined },
    { ...spec, kind: "line" as const },
    { ...spec, kind: "area" as const },
  ])("does not add totals when unsupported or disabled: %j", (next) => {
    const plotted = chartSeries(columns, rows, next);
    expect(
      chartOptions(columns, next, plotted).series.every(
        (item) => !item.markPoint,
      ),
    ).toBe(true);
  });

  it.each(["vertical", "horizontal"] as const)(
    "uses real %s grouped-bar centers and places net totals outside the signed extent",
    (orientation) => {
      const { chart, option, plotted } = render({ ...spec, orientation });
      try {
        const models = chart.getModel().getSeries();
        const horizontal = orientation === "horizontal";
        let inspected = 0;
        models.forEach((model, index) => {
          const marker = MarkerModel.getMarkerModelFromSeries(
            model,
            "markPoint",
          );
          if (!marker) return;
          const data = marker.getData();
          option.series[index].markPoint!.data.forEach((point, pointIndex) => {
            const category = point.coord[horizontal ? 1 : 0];
            const rectangles = models.flatMap((candidate, seriesIndex) => {
              if (plotted[seriesIndex].metricId !== plotted[index].metricId)
                return [];
              const dataIndex = plotted[seriesIndex].data.findIndex(
                ([x, value]) => x === category && value !== null,
              );
              return dataIndex < 0
                ? []
                : [candidate.getData().getItemLayout(dataIndex)];
            });
            const [x, y] = data.getItemLayout(pointIndex);
            const rectangle = rectangles[0];
            if (horizontal) {
              expect(y).toBeCloseTo(rectangle.y + rectangle.height / 2, 6);
              const ends = rectangles.flatMap((rect) => [
                rect.x,
                rect.x + rect.width,
              ]);
              expect(x).toBeCloseTo(
                point.value < 0 ? Math.min(...ends) : Math.max(...ends),
                6,
              );
              expect(point.label.position).toBe(
                point.value < 0 ? "left" : "right",
              );
            } else {
              expect(x).toBeCloseTo(rectangle.x + rectangle.width / 2, 6);
              const ends = rectangles.flatMap((rect) => [
                rect.y,
                rect.y + rect.height,
              ]);
              expect(y).toBeCloseTo(
                point.value < 0 ? Math.max(...ends) : Math.min(...ends),
                6,
              );
              expect(point.label.position).toBe(
                point.value < 0 ? "bottom" : "top",
              );
            }
            inspected++;
          });
        });
        expect(inspected).toBe(12);
        const svg = chart.renderToSVGString();
        expect(svg).toContain(">30</text>");
        expect(svg).toContain(">-15</text>");
      } finally {
        chart.dispose();
      }
    },
  );

  it("updates totals from visible legend names and drops obsolete selection keys", () => {
    const selected = {
      "Выручка · two": false,
      "Посещения · one": false,
      removed: false,
    };
    const { chart, option } = render(spec, rows, selected);
    try {
      expect(option.legend.selected).toEqual({
        "Выручка · two": false,
        "Посещения · one": false,
      });
      const points = option.series.flatMap((item) =>
        (item.markPoint?.data ?? []).map((point) => ({
          name: item.name,
          ...point,
        })),
      );
      expect(
        points.find(
          (point) =>
            point.name === "Выручка · one" && point.coord[0] === "positive",
        )?.value,
      ).toBe(12);
      expect(
        points.find(
          (point) =>
            point.name === "Посещения · two" && point.coord[0] === "positive",
        )?.value,
      ).toBe(180);
      expect(
        points.some(
          (point) => selected[point.name as keyof typeof selected] === false,
        ),
      ).toBe(false);
      expect(
        points.some(
          (point) =>
            point.name === "Выручка · one" && point.coord[0] === "sparse",
        ),
      ).toBe(false);
      expect(chart.renderToSVGString()).not.toContain(">30</text>");
    } finally {
      chart.dispose();
    }
  });

  it("keeps same-named metrics independently selectable", () => {
    const repeated = columns.map((column) =>
      column.id === "visits" ? { ...column, name: "Выручка" } : column,
    );
    const plotted = chartSeries(repeated, rows, spec);
    const initial = chartOptions(repeated, spec, plotted);
    expect(new Set(initial.series.map((item) => item.name)).size).toBe(
      plotted.length,
    );
    const hiddenIndex = plotted.findIndex(
      (item) => item.metricId === "visits" && item.name.endsWith(" · one"),
    );
    const selected = { [initial.series[hiddenIndex].name]: false };
    const option = chartOptions(repeated, spec, plotted, undefined, selected);
    const total = (metric: string) =>
      option.series
        .filter((item) => item.stack === `metric:${metric}`)
        .flatMap((item) => item.markPoint?.data ?? [])
        .find((point) => point.coord[0] === "positive")?.value;
    expect(total("revenue")).toBe(30);
    expect(total("visits")).toBe(180);
  });

  it("preserves segment labels and uses chart number formatting for totals", () => {
    const next = {
      ...spec,
      y: ["revenue"],
      showLabels: true,
      numberFormat: "compact" as const,
    };
    const { chart, option } = render(next, [
      ["A", 1200, 0, "one"],
      ["A", 1800, 0, "two"],
    ]);
    try {
      expect(
        option.series.every(
          (item) => item.label.show && item.label.position === "inside",
        ),
      ).toBe(true);
      expect(option.series[0].markPoint!.label.formatter({ value: 3000 })).toBe(
        "3k",
      );
      const svg = chart.renderToSVGString();
      for (const value of [1200, 1800, 3000])
        expect(svg).toContain(`>${formatChartNumber(value, "compact")}</text>`);
    } finally {
      chart.dispose();
    }
  });

  it("renders no totals when all real series are hidden", () => {
    const plotted = chartSeries(columns, rows, spec);
    const initial = chartOptions(columns, spec, plotted);
    const selected = Object.fromEntries(
      initial.series.map((item) => [item.name, false]),
    );
    const { chart, option } = render(spec, rows, selected);
    try {
      expect(option.series.every((item) => !item.markPoint)).toBe(true);
      expect(chart.renderToSVGString()).not.toContain(">30</text>");
    } finally {
      chart.dispose();
    }
  });

  it("does not alter grouped bar widths or positions within the same plot area", () => {
    const { chart, option } = render();
    try {
      const layouts = () =>
        chart
          .getModel()
          .getSeries()
          .map((model) =>
            Array.from({ length: model.getData().count() }, (_, index) =>
              model.getData().getItemLayout(index),
            ),
          );
      const original = structuredClone(layouts());
      // Keep the reserved label gutter: test the bar layout, independently of
      // the intentional extra room that enabled totals add around the plot.
      const withoutMarkers = {
        ...option,
        series: option.series.map(({ markPoint: _, ...item }) => item),
        media: [],
      };
      chart.setOption(withoutMarkers, { notMerge: true });
      expect(layouts()).toEqual(original);
    } finally {
      chart.dispose();
    }
  });

  it.each(["top", "bottom", "left", "right"] as const)(
    "keeps long totals within the canvas and outside the %s legend",
    (legendPosition) => {
      for (const orientation of ["vertical", "horizontal"] as const) {
        const { chart } = render(
          {
            ...spec,
            legendPosition,
            orientation,
            showXAxis: false,
            showYAxis: false,
          },
          [
            ["A", 123456789012.3, 1234567890.1, "one"],
            ["A", 456789012345.6, 4567890123.4, "two"],
            ["B", -123456789012.3, -1234567890.1, "one"],
            ["B", -456789012345.6, -4567890123.4, "two"],
          ],
        );
        try {
          chart.renderToSVGString();
          const legendView = chart.getViewOfComponentModel(
            chart.getModel().getComponent("legend"),
          ) as ComponentView & { _backgroundEl: Displayable };
          const legend = bounds(legendView._backgroundEl);
          let labels = 0;
          for (const model of chart.getModel().getSeries()) {
            const marker = MarkerModel.getMarkerModelFromSeries(
              model,
              "markPoint",
            );
            if (!marker) continue;
            const data = marker.getData();
            for (let index = 0; index < data.count(); index++) {
              data.getItemGraphicEl(index).traverse((element) => {
                const text = element.getTextContent();
                if (!text) return;
                const rectangle = bounds(text);
                expect(rectangle.x).toBeGreaterThanOrEqual(0);
                expect(rectangle.y).toBeGreaterThanOrEqual(0);
                expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(800);
                expect(rectangle.y + rectangle.height).toBeLessThanOrEqual(500);
                if (legendPosition === "top")
                  expect(rectangle.y).toBeGreaterThan(legend.y + legend.height);
                if (legendPosition === "bottom")
                  expect(rectangle.y + rectangle.height).toBeLessThan(legend.y);
                if (legendPosition === "left")
                  expect(rectangle.x).toBeGreaterThan(legend.x + legend.width);
                if (legendPosition === "right")
                  expect(rectangle.x + rectangle.width).toBeLessThan(legend.x);
                labels++;
              });
            }
          }
          expect(labels).toBe(4);
        } finally {
          chart.dispose();
        }
      }
    },
  );
});
