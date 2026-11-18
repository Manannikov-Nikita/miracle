// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act } from "react";
import { formatChartNumber } from "../src/client/board/chart-number";
import type { Cell, ChartSpec } from "../src/shared/types";
import { boardDocumentSchema } from "../src/shared/board-schema";
import { chartSeries } from "../src/client/board/model";
import { mountBoardChart, textNodes } from "./helpers/chart-render";

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
  const chart = mountBoardChart();
  const render = (spec: ChartSpec, source = rows) =>
    chart.render({
      columns,
      spec,
      series: chartSeries(columns, source, spec),
    });
  it.each(["vertical", "horizontal"] as const)(
    "controls the physical axes, grid and labels independently on %s bars",
    async (orientation) => {
      const saved = { ...base, orientation };
      await render(saved);
      expect(textNodes(chart.host, ".bk-axis-name")).toEqual(
        orientation === "vertical"
          ? ["Категория", "Выручка"]
          : ["Выручка", "Категория"],
      );
      expect(chart.host.querySelector(".bk-grid")).not.toBeNull();
      expect(chart.host.querySelector(".bk-value")).toBeNull();
      await render({ ...saved, showXAxis: false });
      expect(textNodes(chart.host, ".bk-axis-name")).toEqual([
        orientation === "vertical" ? "Выручка" : "Категория",
      ]);
      await render({ ...saved, showYAxis: false });
      expect(textNodes(chart.host, ".bk-axis-name")).toEqual([
        orientation === "vertical" ? "Категория" : "Выручка",
      ]);
      const axesOff = { ...saved, showXAxis: false, showYAxis: false };
      await render(axesOff);
      expect(chart.host.querySelector("svg text")).toBeNull();
      expect(chart.host.querySelector(".bk-grid")).not.toBeNull();
      await render({ ...axesOff, showGrid: false });
      expect(chart.host.querySelector(".bk-grid")).toBeNull();
      expect(chart.host.querySelectorAll(".bk-bar")).toHaveLength(2);
    },
  );

  it.each(["vertical", "horizontal"] as const)(
    "places signed labels outside %s bars and omits nulls",
    async (orientation) => {
      await render({
        ...base,
        orientation,
        showLabels: true,
        numberFormat: "compact",
      });
      expect(textNodes(chart.host, ".bk-value")).toEqual(["3.4k", "-1.2k"]);
      const bars = chart.host.querySelectorAll(".bk-bar");
      for (const [index, label] of [
        ...chart.host.querySelectorAll(".bk-value"),
      ].entries()) {
        const bar = bars[index];
        if (orientation === "horizontal") {
          const x = Number(label.getAttribute("x")),
            left = Number(bar.getAttribute("x"));
          if (index === 0)
            expect(x).toBeGreaterThan(left + Number(bar.getAttribute("width")));
          else expect(x).toBeLessThan(left);
        } else {
          const y = Number(label.getAttribute("y")),
            top = Number(bar.getAttribute("y"));
          if (index === 0) expect(y).toBeLessThan(top);
          else
            expect(y).toBeGreaterThan(top + Number(bar.getAttribute("height")));
        }
      }
    },
  );
  it("shortens long horizontal labels on a narrow card while keeping the full signed value in the tooltip", async () => {
    const amount = 9_000_000_000_000_000;
    const spec: ChartSpec = {
      ...base,
      orientation: "horizontal",
      showLabels: true,
      showXAxis: false,
      showYAxis: false,
    };
    await chart.resize(280, 180);
    await render(spec, [
      ["A", amount, 0, "one"],
      ["B", -amount, 1, "two"],
    ]);
    const labels = [...chart.host.querySelectorAll(".bk-value")];
    expect(labels).toHaveLength(2);
    for (const [i, label] of labels.entries()) {
      expect(label.textContent).toMatch(/…$/);
      const x = Number(label.getAttribute("x"));
      expect(x).toBeGreaterThan(0);
      expect(x).toBeLessThan(280);
      expect(label.getAttribute("text-anchor")).toBe(i === 0 ? "start" : "end");
    }
    const svg = chart.host.querySelector('svg[role="img"]')!;
    for (const [key, value] of [
      ["Home", amount],
      ["End", -amount],
    ] as const) {
      await act(async () =>
        svg.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
      );
      expect(textNodes(chart.host, ".chart-tooltip-value")).toEqual([
        formatChartNumber(value),
      ]);
    }
  });
  it.each(["line", "area", "scatter"] as const)(
    "formats signed %s point labels and omits nulls",
    async (kind) => {
      await render({
        ...base,
        kind,
        x: kind === "scatter" ? "other" : base.x,
        showLabels: true,
        showGrid: false,
        showXAxis: false,
        showYAxis: false,
        numberFormat: "compact",
      });
      expect(
        textNodes(
          chart.host,
          kind === "scatter" ? ".bk-scatter-label" : ".bk-value",
        ),
      ).toEqual(["3.4k", "-1.2k"]);
    },
  );
  it.each([
    { style: "single", grouped: false, stacked: false, colors: ["#8ec5ff"] },
    {
      style: "overlay",
      grouped: true,
      stacked: false,
      colors: ["#155dfc", "#8ec5ff"],
    },
    {
      style: "stacked",
      grouped: true,
      stacked: true,
      colors: ["#2b7fff", "#8ec5ff"],
    },
  ])(
    "uses the $style histogram colors consistently for marks, legend and tooltip on light and dark slides",
    async ({ grouped, stacked, colors }) => {
      const spec: ChartSpec = {
        kind: "histogram",
        x: "value",
        y: [],
        legend: true,
        series: grouped ? "group" : undefined,
        stacked,
        binCount: 1,
      };
      const series = chartSeries(columns, rows, spec);
      const cssColors = colors.map((hex) => {
        const swatch = document.createElement("span");
        swatch.style.backgroundColor = hex;
        return swatch.style.backgroundColor;
      });
      for (const background of ["#ffffff", "#202124"]) {
        await chart.render({
          columns,
          spec,
          series,
          presentationBackground: background,
        });
        const marks = chart.host.querySelectorAll(".bk-histogram-bar");
        expect([...marks].map((mark) => mark.getAttribute("fill"))).toEqual(
          colors,
        );
        expect(
          [
            ...chart.host.querySelectorAll<HTMLElement>(".bk-legend .bk-key"),
          ].map((s) => s.style.backgroundColor),
        ).toEqual(cssColors);
        const svg = chart.host.querySelector('svg[role="img"]')!;
        await act(async () =>
          svg.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
          ),
        );
        expect(
          [
            ...chart.host.querySelectorAll<HTMLElement>(
              ".chart-tooltip-swatch",
            ),
          ].map((s) => s.style.backgroundColor),
        ).toEqual(cssColors);
      }
    },
  );

  it("keeps histogram palette selections and explicit group colors through stacking and legend filtering", async () => {
    const key = JSON.stringify(["value", "group", "two"]);
    const spec: ChartSpec = {
      kind: "histogram",
      x: "value",
      y: [],
      legend: true,
      series: "group",
      palette: "warm",
      seriesColors: { [key]: "#705bdb" },
      binCount: 1,
    };
    const series = chartSeries(columns, rows, spec);
    const fills = () =>
      [...chart.host.querySelectorAll(".bk-histogram-bar")].map((el) =>
        el.getAttribute("fill"),
      );
    for (const stacked of [false, true]) {
      await chart.render({ columns, spec: { ...spec, stacked }, series });
      expect(fills()).toEqual(["#f0ad72", "#705bdb"]);
    }
    await act(async () =>
      chart.host.querySelector<HTMLButtonElement>(".bk-legend button")!.click(),
    );
    expect(fills()).toEqual(["#705bdb"]);
    await chart.render({
      columns,
      spec: { ...spec, palette: "default" },
      series,
    });
    expect(fills()).toEqual(["#705bdb"]);
  });
  it("keeps explicit colors attached to stable typed metric/breakdown identities after reordering", async () => {
    const configured = {
      ...base,
      kind: "line" as const,
      y: ["value", "other"],
      series: "group",
      palette: "warm" as const,
    };
    const source: Cell[][] = [
      ["A", 1, 2, 1],
      ["B", 3, 4, "1"],
      ["C", 5, 6, null],
    ];
    const before = chartSeries(columns, source, configured);
    expect(new Set(before.map((s) => s.colorKey)).size).toBe(6);
    const selected = before[0].colorKey!;
    const saved = { ...configured, seriesColors: { [selected]: "#123456" } };
    const next = chartSeries(columns, source.toReversed(), saved);
    await chart.render({ columns, spec: saved, series: next });
    const lines = [...chart.host.querySelectorAll(".bk-line")];
    const moved = next.findIndex((s) => s.colorKey === selected);
    expect(moved).not.toBe(0);
    expect(lines[moved].getAttribute("stroke")).toBe("#123456");
    expect(
      lines.filter((line) => line.getAttribute("stroke") === "#123456"),
    ).toHaveLength(1);
  });
});
