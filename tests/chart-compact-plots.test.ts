// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import MatrixPlot from "../src/client/board/chart-kit/MatrixPlot";
import TrendPlot from "../src/client/board/chart-kit/TrendPlot";
import type { ChartPlotProps } from "../src/client/board/chart-kit/plot-types";
import { trendLine } from "../src/client/board/chart-kit/bklit/trend-line";

let host: HTMLElement;
let root: Root;
const props: ChartPlotProps = {
  label: "Динамика",
  colors: ["#e0f0ff", "#1da0ff"],
  columns: [],
  spec: { kind: "heatmap", x: "period", y: ["value"], legend: true },
  series: [
    {
      name: "Север",
      xCategories: ["Q1", "Q2", "Q3"],
      data: [
        ["Q1", -30],
        ["Q2", 0],
        ["Q3", null],
      ],
      displayData: [
        { x: "I", value: "−30 шт." },
        { x: "II", value: "0 шт." },
        { x: "III", value: "пусто" },
      ],
    },
    { name: "Юг", data: [["Q2", 100]] },
  ],
};
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(500);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(300);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const tooltipText = () => host.querySelector('[role="tooltip"]')?.textContent;
async function key(key: string) {
  await act(async () => {
    host
      .querySelector("svg")!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}
it("draws the whole heat matrix, differentiates missing cells and zero, and reads formatted values with the keyboard", async () => {
  await act(async () => root.render(createElement(MatrixPlot, props)));
  const rects = [...host.querySelectorAll(".matrix-column rect")];
  expect(rects).toHaveLength(6);
  expect(rects[1].getAttribute("fill")).toBe("none");
  expect(rects[2].getAttribute("fill")).toBe(props.colors[0]);
  expect(Number(rects[2].getAttribute("fill-opacity"))).toBeGreaterThan(
    Number(rects[0].getAttribute("fill-opacity")),
  );
  expect(host.querySelector(".matrix-scale")?.textContent).toBe("-30100");
  await key("ArrowRight");
  expect(tooltipText()).toContain("0 шт.");
  expect(host.querySelector(".matrix-focus")).toBeTruthy();
  expect(host.querySelector("svg")?.getAttribute("aria-describedby")).toBe(
    host.querySelector('[role="tooltip"]')?.id,
  );
  expect(host.querySelector(".matrix-plot mask")).toBeTruthy();
  await key("ArrowDown");
  expect(tooltipText()).toContain("Q2Юг100");
  await key("Home");
  expect(tooltipText()).toContain("Q1Юг—");
  await act(async () =>
    root.render(
      createElement(MatrixPlot, {
        ...props,
        spec: {
          ...props.spec,
          legend: false,
          showXAxis: false,
          showYAxis: false,
        },
      }),
    ),
  );
  expect(host.querySelector(".matrix-scale, .matrix-tick")).toBeNull();
});
it("renders independent trend rows and exposes formatted category and null values", async () => {
  await act(async () =>
    root.render(
      createElement(TrendPlot, {
        ...props,
        spec: { ...props.spec, kind: "sparkline" },
      }),
    ),
  );
  expect(host.querySelectorAll(".trend-line")).toHaveLength(2);
  expect(
    host.querySelectorAll(".trend-row")[1].querySelector("circle"),
  ).toBeTruthy();
  await key("End");
  expect(tooltipText()).toBe("IIIСеверпусто");
  await key("Home");
  expect(tooltipText()).toBe("IСевер−30 шт.");
  expect(host.querySelector("svg")?.getAttribute("aria-describedby")).toBe(
    host.querySelector('[role="tooltip"]')?.id,
  );
  expect(
    host.querySelector(".trend-row[data-active] .trend-marker"),
  ).toBeTruthy();
  expect(host.querySelector('.trend-scroll [role="tooltip"]')).toBeNull();
  await key("Escape");
  expect(tooltipText()).toBeUndefined();
  expect(host.querySelector(".trend-row[data-active]")).toBeNull();
});
it("centres flat curves, breaks the path at nulls and supports signed Float64 extrema", () => {
  expect(trendLine([Number.MAX_VALUE], 200, 60).points).toEqual([
    { x: 100, y: 30 },
  ]);
  const { points, path } = trendLine(
    [-Number.MAX_VALUE, 0, null, Number.MAX_VALUE],
    200,
    60,
  );
  expect(points.map((p) => p.y)).toEqual([55, 30, NaN, 5]);
  expect(path.match(/M/g)).toHaveLength(2);
});

it("keeps a densely populated row visible at subpixel column widths", async () => {
  const data: [string, number][] = Array.from({ length: 600 }, (_, i) => [
    String(i),
    i,
  ]);
  await act(async () =>
    root.render(
      createElement(MatrixPlot, {
        ...props,
        series: [{ name: "Измерение", data }],
      }),
    ),
  );
  const cell = host.querySelector(".matrix-column rect")!;
  expect(Number(cell.getAttribute("width"))).toBeLessThan(1);
  expect(Number(cell.getAttribute("height"))).toBeGreaterThan(12);
});
