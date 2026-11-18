// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { mountBoardChart } from "./helpers/chart-render";
import { readFileSync } from "node:fs";
const chartStyles = readFileSync(
  "src/client/board/chart-kit/charts.css",
  "utf8",
);
import type { ChartSeriesItem } from "../src/client/board/model";
import type { ChartSpec } from "../src/shared/types";

const columns = [
  { id: "x", name: "Длинное название категории X", type: "String" },
  {
    id: "y",
    name: "Длинное название оси Y с дополнительными подробностями показателя",
    type: "Float64",
  },
];
const series: ChartSeriesItem[] = Array.from({ length: 24 }, (_, i) => ({
  name: `Длинное название серии ${i} с дополнительными подробностями`,
  data: [
    ["A very long category label", 10000000],
    ["Another category", 30000000],
  ],
}));
const chart = mountBoardChart();
let styles: HTMLStyleElement;
beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = chartStyles;
  document.head.append(styles);
});
afterEach(() => styles.remove());
const base: ChartSpec = { kind: "bar", x: "x", y: ["y"], legend: true };

it.each([
  ["top", "column"],
  ["bottom", "column-reverse"],
  ["left", "row"],
  ["right", "row-reverse"],
] as const)(
  "reserves a scrollable %s legend outside the plotting area, including after resize",
  async (legendPosition, direction) => {
    const spec = { ...base, legendPosition };
    await chart.render({ spec, columns, series });
    const frame = chart.host.querySelector<HTMLElement>(".bk-chart")!;
    const legend = frame.querySelector<HTMLElement>(
      '[role="group"][aria-label="Легенда"]',
    )!;
    expect(legend.nextElementSibling?.className).toBe("bk-plot");
    expect(getComputedStyle(frame).flexDirection).toBe(direction);
    expect(getComputedStyle(legend).overflow).toBe("auto");
    expect(
      [...legend.querySelectorAll("button")].map((button) => button.title),
    ).toEqual(series.map((s) => s.name));
    for (const [width, height] of [
      [700, 300],
      [300, 180],
      [280, 143],
      [700, 300],
    ]) {
      await chart.resize(width, height);
      const svg = frame.querySelector("svg[role=img]")!;
      expect(svg.getAttribute("viewBox")).toBe(`0 0 ${width} ${height}`);
      expect(svg.querySelectorAll(".bk-axis-name")).toHaveLength(2);
      for (const text of svg.querySelectorAll("text")) {
        // Rotated axis titles use a local coordinate system.
        if (text.hasAttribute("transform")) continue;
        const x = Number(text.getAttribute("x")),
          y = Number(text.getAttribute("y"));
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(height);
      }
    }
    await chart.render({ spec: { ...spec, legend: false }, columns, series });
    expect(frame.querySelector(".bk-legend")).toBeNull();
    expect(frame.children).toHaveLength(1);
  },
);
it.each([
  ["start", "flex-start"],
  ["center", "safe center"],
  ["end", "safe end"],
] as const)(
  "aligns horizontal and vertical legends at %s",
  async (legendAlign, cssAlign) => {
    for (const legendPosition of ["top", "right"] as const) {
      await chart.render({
        spec: { ...base, legendAlign, legendPosition },
        columns,
        series,
      });
      const legend = chart.host.querySelector<HTMLElement>(".bk-legend")!;
      expect(getComputedStyle(legend).justifyContent).toBe(cssAlign);
      if (legendPosition === "right")
        expect(getComputedStyle(legend).flexDirection).toBe("column");
    }
  },
);
it("defaults old charts to a centered legend above the plot", async () => {
  await chart.render({ spec: base, columns, series });
  expect(
    chart.host.querySelector(".bk-chart")?.getAttribute("data-legend-position"),
  ).toBe("top");
  expect(
    chart.host.querySelector(".bk-legend")?.getAttribute("data-align"),
  ).toBe("center");
});
