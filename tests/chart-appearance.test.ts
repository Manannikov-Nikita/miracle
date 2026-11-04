import { describe, expect, it } from "vitest";
import * as echarts from "echarts";
import type GlobalModel from "echarts/lib/model/Global.js";
import type ComponentModel from "echarts/lib/model/Component.js";
import type ComponentView from "echarts/lib/view/Component.js";
import type Displayable from "zrender/lib/graphic/Displayable.js";
import type Group from "zrender/lib/graphic/Group.js";
import type Text from "zrender/lib/graphic/Text.js";
import type { Cell, ChartSpec } from "../src/shared/types";
import { boardDocumentSchema } from "../src/shared/board-schema";
import { chartSeries } from "../src/client/board/model";
import { chartOptions } from "../src/client/board/chartOptions";

const columns = [
  { id: "category", name: "Категория", type: "String" },
  { id: "value", name: "Выручка", type: "Float64" },
  { id: "other", name: "Выручка", type: "Float64" },
  { id: "group", name: "Группа", type: "String" },
];
const base: ChartSpec = {
  kind: "bar",
  x: "category",
  y: ["value"],
  legend: false,
};
const rows: Cell[][] = [
  ["A", 3400, 12, "one"],
  ["B", -1200, 15, "two"],
  ["C", null, 20, "one"],
];
type InspectableChart = echarts.ECharts & {
  getModel(): GlobalModel;
  getViewOfComponentModel(model: ComponentModel): ComponentView;
};
function inspect(
  spec: ChartSpec,
  verify: (chart: InspectableChart) => void,
  source = rows,
) {
  const chart = echarts.init(null, "dark", {
    renderer: "svg",
    ssr: true,
    width: 700,
    height: 360,
  }) as InspectableChart;
  try {
    chart.setOption(
      chartOptions(columns, spec, chartSeries(columns, source, spec)),
    );
    verify(chart);
  } finally {
    chart.dispose();
  }
}
function axisElements(chart: InspectableChart, axis: "xAxis" | "yAxis") {
  const elements: Displayable[] = [];
  chart
    .getViewOfComponentModel(chart.getModel().getComponent(axis))
    .group.traverse((el) => {
      if (!el.ignore && el.type !== "group") elements.push(el as Displayable);
    });
  return elements;
}
function bounds(element: Displayable) {
  const result = element.getBoundingRect().clone();
  result.applyTransform(element.getComputedTransform());
  return result;
}
const documentWith = (chart: unknown) => ({
  schemaVersion: 1,
  nodes: [
    {
      id: "chart",
      type: "artifact",
      position: { x: 0, y: 0 },
      data: { kind: "note", title: "Chart", chart },
    },
  ],
  edges: [],
});

describe("chart appearance persistence", () => {
  it("round-trips appearance settings while keeping legacy charts unchanged", () => {
    const settings = {
      ...base,
      showXAxis: false,
      showYAxis: true,
      showGrid: false,
      showLabels: true,
      labelPosition: "inside",
      palette: "warm",
      seriesColors: { '["value",null,null]': "#A1b2c3" },
    };
    for (const spec of [base, settings]) {
      const document = documentWith(spec);
      expect(
        boardDocumentSchema.parse(JSON.parse(JSON.stringify(document))),
      ).toEqual(document);
    }
  });
  it.each([
    { showXAxis: "false" },
    { showYAxis: 0 },
    { showGrid: null },
    { showLabels: 1 },
    { labelPosition: "left" },
    { palette: "unknown" },
    { seriesColors: { metric: "red" } },
    { seriesColors: { metric: "#fff" } },
    { seriesColors: { metric: "url(javascript:alert(1))" } },
    {
      seriesColors: Object.fromEntries(
        Array.from({ length: 5001 }, (_, i) => [String(i), "#123456"]),
      ),
    },
  ])("rejects malformed appearance case %#", (patch) => {
    expect(
      boardDocumentSchema.safeParse(documentWith({ ...base, ...patch }))
        .success,
    ).toBe(false);
  });
});

describe("rendered chart appearance", () => {
  it("keeps legacy axes and grid visible, with labels off", () => {
    const option = chartOptions(
      columns,
      base,
      chartSeries(columns, rows, base),
    );
    expect(option.series[0].label.show).toBe(false);
    inspect(base, (chart) => {
      expect(chart.renderToSVGString()).toContain("Категория");
      expect(chart.renderToSVGString()).toContain("Выручка");
      expect(
        axisElements(chart, "yAxis").some((el) => el.type === "line"),
      ).toBe(true);
    });
  });
  it.each(["vertical", "horizontal"] as const)(
    "hides both %s axes without hiding grid, then hides grid separately",
    (orientation) => {
      const hidden: ChartSpec = {
        ...base,
        orientation,
        showXAxis: false,
        showYAxis: false,
      };
      inspect(hidden, (chart) => {
        const elements = [
          ...axisElements(chart, "xAxis"),
          ...axisElements(chart, "yAxis"),
        ];
        expect(elements.some((el) => el.type === "text")).toBe(false);
        expect(
          elements.filter((el) => el.type === "line").length,
        ).toBeGreaterThan(2);
      });
      inspect({ ...hidden, showGrid: false }, (chart) => {
        expect([
          ...axisElements(chart, "xAxis"),
          ...axisElements(chart, "yAxis"),
        ]).toHaveLength(0);
        expect(chart.getModel().getSeries()[0].getData().hasValue(0)).toBe(
          true,
        );
      });
    },
  );
  it("hides only the physical X axis and independently removes the scatter grid", () => {
    inspect(
      {
        ...base,
        kind: "scatter",
        x: "other",
        showXAxis: false,
        showGrid: false,
      },
      (chart) => {
        expect(axisElements(chart, "xAxis")).toHaveLength(0);
        expect(
          axisElements(chart, "yAxis").some((el) => el.type === "text"),
        ).toBe(true);
        expect(
          chart.getModel().getComponent("xAxis").get(["splitLine", "show"]),
        ).toBe(false);
        expect(
          chart.getModel().getComponent("yAxis").get(["splitLine", "show"]),
        ).toBe(false);
      },
    );
  });
  it.each(["vertical", "horizontal"] as const)(
    "places formatted positive and negative labels outside %s bars",
    (orientation) => {
      inspect(
        { ...base, orientation, showLabels: true, numberFormat: "compact" },
        (chart) => {
          const data = chart.getModel().getSeries()[0].getData();
          const positive = data.getItemGraphicEl(0)! as Displayable;
          const negative = data.getItemGraphicEl(1)! as Displayable;
          const firstLabel = positive.getTextContent()!;
          const secondLabel = negative.getTextContent()!;
          expect(firstLabel.style.text).toBe("3.4k");
          expect(secondLabel.style.text).toBe("-1.2k");
          const a = bounds(firstLabel),
            b = bounds(secondLabel);
          const p = bounds(positive),
            n = bounds(negative);
          if (orientation === "horizontal") {
            expect(a.x).toBeGreaterThan(p.x + p.width);
            expect(b.x + b.width).toBeLessThan(n.x);
          } else {
            expect(a.y + a.height).toBeLessThan(p.y);
            expect(b.y).toBeGreaterThan(n.y + n.height);
          }
          expect(data.hasValue(2)).toBe(false);
        },
      );
    },
  );
  it.each(["vertical", "horizontal"] as const)(
    "keeps outside %s labels within the canvas when axes are hidden",
    (orientation) => {
      for (const values of [
        [4000, 1000],
        [-4000, -1000],
        [-4000, 4000],
      ]) {
        const source: Cell[][] = values.map((value, index) => [
          String(index),
          value,
          index,
          "one",
        ]);
        inspect(
          {
            ...base,
            orientation,
            showLabels: true,
            showXAxis: false,
            showYAxis: false,
          },
          (chart) => {
            for (const [width, height] of [
              [700, 360],
              [280, 180],
            ]) {
              chart.resize({ width, height });
              const data = chart.getModel().getSeries()[0].getData();
              for (let i = 0; i < data.count(); i++) {
                const label = data.getItemGraphicEl(i)!.getTextContent()!;
                expect(label.ignore).not.toBe(true);
                const rect = bounds(label);
                expect(rect.x, `${values}: label left`).toBeGreaterThanOrEqual(
                  0,
                );
                expect(rect.y, `${values}: label top`).toBeGreaterThanOrEqual(
                  0,
                );
                expect(
                  rect.x + rect.width,
                  `${values}: label right`,
                ).toBeLessThanOrEqual(width);
                expect(
                  rect.y + rect.height,
                  `${values}: label bottom`,
                ).toBeLessThanOrEqual(height);
              }
            }
          },
          source,
        );
      }
    },
  );
  it("labels individual stack segments and preserves nulls and numeric formatting", () => {
    const spec: ChartSpec = {
      ...base,
      stacked: true,
      series: "group",
      showLabels: true,
      numberFormat: "percent",
    };
    const option = chartOptions(
      columns,
      spec,
      chartSeries(columns, rows, spec),
    );
    expect(option.series[0].label.position).toBe("inside");
    const label = option.series[0].label.formatter;
    expect(label({ value: ["A", 0.25] })).toBe("25%");
    expect(label({ value: ["A", 0] })).toBe("0%");
    expect(label({ value: ["A", null] })).toBe("");
    expect(label({ value: ["A"] })).toBe("");
    expect(label({ value: ["A", NaN] })).toBe("");
  });
  it.each(["line", "area", "scatter"] as const)(
    "shows labels on %s points",
    (kind) => {
      const spec: ChartSpec = {
        ...base,
        kind,
        x: kind === "scatter" ? "other" : base.x,
        showLabels: true,
        showXAxis: false,
        showYAxis: false,
        showGrid: false,
      };
      inspect(spec, (chart) => {
        const svg = chart.renderToSVGString();
        expect(svg).toContain("3 400");
        expect(svg).toContain("-1 200");
        expect(svg).not.toContain("null");
      });
    },
  );
  it.each([undefined, "left", "right"] as const)(
    "keeps very long horizontal labels inside a narrow canvas with legend %s",
    (legendPosition) => {
      const spec: ChartSpec = {
        ...base,
        orientation: "horizontal",
        legend: Boolean(legendPosition),
        legendPosition,
        showXAxis: false,
        showYAxis: false,
        showLabels: true,
      };
      inspect(
        spec,
        (chart) => {
          for (const [width, height] of [
            [280, 180],
            [700, 360],
          ]) {
            chart.resize({ width, height });
            const data = chart.getModel().getSeries()[0].getData();
            for (let i = 0; i < data.count(); i++) {
              const label = data.getItemGraphicEl(i)!.getTextContent()!;
              expect(label.ignore).not.toBe(true);
              const rect = bounds(label);
              expect(rect.x).toBeGreaterThanOrEqual(0);
              expect(rect.x + rect.width).toBeLessThanOrEqual(width);
            }
            expect(
              chart.getModel().getSeries()[0].getData().getItemLayout(0).width,
            ).toBeGreaterThan(0);
          }
        },
        [
          ["A", 9000000000000000, 0, "one"],
          ["B", -9000000000000000, 1, "one"],
        ],
      );
    },
  );
  it.each(["line", "area", "scatter"] as const)(
    "keeps labels on extreme %s points within the canvas with hidden axes",
    (kind) => {
      const spec: ChartSpec = {
        ...base,
        kind,
        x: kind === "scatter" ? "other" : base.x,
        showLabels: true,
        showXAxis: false,
        showYAxis: false,
        showGrid: false,
      };
      inspect(
        spec,
        (chart) => {
          for (const [width, height] of [
            [700, 360],
            [280, 180],
          ]) {
            chart.resize({ width, height });
            const data = chart.getModel().getSeries()[0].getData();
            for (let i = 0; i < data.count(); i++) {
              const element = data.getItemGraphicEl(i)!;
              const labels: Text[] = [];
              if (element.getTextContent())
                labels.push(element.getTextContent()!);
              if (element.type === "group")
                (element as Group).traverse((child) => {
                  if (child.getTextContent())
                    labels.push(child.getTextContent()!);
                });
              expect(labels).toHaveLength(1);
              for (const label of labels) {
                expect(label.ignore).not.toBe(true);
                const rect = bounds(label);
                expect(rect.x).toBeGreaterThanOrEqual(0);
                expect(rect.y).toBeGreaterThanOrEqual(0);
                expect(rect.x + rect.width).toBeLessThanOrEqual(width);
                expect(rect.y + rect.height).toBeLessThanOrEqual(height);
              }
            }
          }
        },
        [
          ["A", -4000, 0, "one"],
          ["B", 4000, 10, "one"],
        ],
      );
    },
  );
  it("keeps a series custom color attached across reordering, names and typed breakdowns", () => {
    const spec: ChartSpec = {
      ...base,
      y: ["value", "other"],
      series: "group",
      palette: "warm",
    };
    const source: Cell[][] = [
      ["A", 1, 2, 1],
      ["B", 3, 4, "1"],
      ["C", 5, 6, null],
    ];
    const before = chartSeries(columns, source, spec);
    const keys = before.map((item) => item.colorKey);
    expect(new Set(keys).size).toBe(6);
    expect(keys.every((key) => typeof key === "string")).toBe(true);
    const custom = { ...spec, seriesColors: { [keys[0]!]: "#123456" } };
    const after = chartSeries(columns, source.toReversed(), custom);
    const option = chartOptions(columns, custom, after);
    const moved = after.findIndex((item) => item.colorKey === keys[0]);
    expect(moved).not.toBe(0);
    expect(option.series[moved].itemStyle.color).toBe("#123456");
    expect(option.series[moved].lineStyle.color).toBe("#123456");
    expect(option.series[moved]).not.toHaveProperty("colorKey");
    expect(option.series[moved]).not.toHaveProperty("metricId");
    expect(option.color).not.toEqual(chartOptions(columns, base, []).color);
  });
});
