// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { chartSeries } from "../src/client/board/model";
import type { ChartPlotProps } from "../src/client/board/chart-kit/plot-types";
import HistogramPlot from "../src/client/board/chart-kit/HistogramPlot";
import ChartSkeleton from "../src/client/board/ChartSkeleton";
import {
  histogramGeometry,
  histogramRange,
} from "../src/client/board/chart-kit/histogram-display";

const columns = [
  { id: "delay", name: "Задержка, мс", type: "Float64" },
  { id: "place", name: "Регион", type: "String" },
];
const spec: ChartPlotProps["spec"] = {
  kind: "histogram",
  x: "delay",
  y: [],
  legend: true,
  series: "place",
  binCount: 4,
  showLabels: true,
};
const props: ChartPlotProps = {
  columns,
  spec,
  colors: ["#f3dfb0", "#283044"],
  label: "Распределение",
  series: chartSeries(
    columns,
    [
      [0, "Север"],
      [0, "Север"],
      [0, "Юг"],
      [1, "Юг"],
      [1, "Юг"],
      [4, "Север"],
      [null, "Север"],
    ],
    spec,
  ),
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(540);
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(350);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = (p = props) =>
  act(async () => root.render(createElement(HistogramPlot, p)));
const marks = () =>
  Array.from(host.querySelectorAll<SVGPathElement>(".bk-histogram-bar"));
const svg = () => host.querySelector<SVGSVGElement>('svg[role="img"]')!;
const key = (key: string) =>
  act(async () => {
    svg().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
const values = () =>
  Array.from(
    host.querySelectorAll(".chart-tooltip-value"),
    (e) => e.textContent,
  );
const title = () =>
  host.querySelector(".chart-tooltip-heading strong")?.textContent;

it("counts each observation once and distinguishes overlaid from stacked intervals", async () => {
  await render();
  expect(host.querySelectorAll(".bk-histogram-bin")).toHaveLength(4);
  expect(marks().map((m) => Number(m.dataset.count))).toEqual([2, 1, 2, 1]);
  expect(marks().every((m) => m.getAttribute("fill-opacity") === "0.55")).toBe(
    true,
  );
  expect(host.querySelector('[data-bin="2"] path')).toBeNull();
  const overlay = histogramGeometry(props, 540, 350);
  expect(overlay.y.domain()).toEqual([0, 2]);
  const stacked = { ...props, spec: { ...spec, stacked: true } };
  const g = histogramGeometry(stacked, 540, 350);
  expect(g.y.domain()).toEqual([0, 3]);
  expect(g.columns[0].peak).toBe(3);
  await render(stacked);
  expect(marks().every((m) => m.getAttribute("fill-opacity") === "1")).toBe(
    true,
  );
  const labelInk = Array.from(
    host.querySelectorAll<SVGTextElement>(
      ".bk-histogram-bin[data-bin='0'] .bk-histogram-label",
    ),
    (n) => n.style.fill,
  );
  expect(labelInk).toEqual(["rgb(32, 37, 43)", "rgb(238, 239, 240)"]);
  const stackedPaths = marks()
    .slice(0, 2)
    .map((m) => m.getAttribute("d"));
  expect(stackedPaths[0]).toContain("V" + g.y(2) + "Q"); // Joined edge is square
  expect(stackedPaths[1]).toContain("," + g.y(2) + "V"); // Upper segment starts at that exact height
  const one = {
    ...stacked,
    series: [props.series[1]],
    colors: [props.colors[1]],
  };
  await render(one);
  expect(marks().map((m) => m.getAttribute("fill"))).toEqual([
    props.colors[1],
    props.colors[1],
  ]);
  expect(histogramGeometry(one, 540, 350).y.domain()).toEqual([0, 2]);
  expect(histogramGeometry(one, 540, 350).columns.map((c) => c.bin)).toEqual(
    g.columns.map((c) => c.bin),
  );
});

it("inspects all groups and empty bins by pointer or keyboard, including the closed upper endpoint", async () => {
  await render();
  await key("Home");
  expect(title()).toBe("[0; 1)");
  expect(values()).toEqual(["2", "1"]);
  expect(svg().getAttribute("aria-describedby")).toBe(
    host.querySelector('[role="tooltip"]')?.id,
  );
  const bins = host.querySelectorAll(".bk-histogram-bin");
  expect(bins[0].getAttribute("data-active")).toBe("true");
  await key("ArrowRight");
  await key("ArrowRight");
  expect(title()).toBe("[2; 3)");
  expect(values()).toEqual(["0", "0"]);
  await key("End");
  expect(title()).toBe("[3; 4]");
  expect(values()).toEqual(["1", "0"]);
  expect(bins[0]).toBe(host.querySelector(".bk-histogram-bin"));
  await key("Escape");
  expect(title()).toBeUndefined();
  const g = histogramGeometry(props, 540, 350);
  vi.spyOn(svg(), "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 15, 540, 350),
  );
  await act(async () => {
    svg().dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 10 + g.columns[0].x1,
        clientY: 15 + g.top,
      }),
    );
  });
  expect(title()).toBe("[1; 2)");
  await act(async () => {
    svg().dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: 10 + g.right + 1,
        clientY: 15 + g.top,
      }),
    );
  });
  expect(title()).toBeUndefined();
});

it("uses whole counts independently of the X format and exposes the distribution for an empty or constant sample", async () => {
  await render({
    ...props,
    spec: {
      ...spec,
      numberFormat: "percent",
      showXAxis: false,
      showGrid: false,
    },
  });
  expect(host.querySelector(".bk-grid,.bk-histogram-tick-x")).toBeNull();
  expect(
    Array.from(
      host.querySelectorAll(".bk-histogram-tick-y"),
      (e) => e.textContent,
    ),
  ).toEqual(["0", "1", "2"]);
  await key("Home");
  expect(title()).toBe("[0%; 100%)");
  expect(values()).toEqual(["2", "1"]);
  const flat = {
    ...props,
    series: chartSeries(
      columns,
      [
        [1.5, "Север"],
        [1.5, "Север"],
      ],
      spec,
    ),
  };
  const g = histogramGeometry(flat, 540, 350);
  expect(g.columns[0].center).toBe((g.left + g.right) / 2);
  expect(g.columns[0].x1 - g.columns[0].x0).toBeLessThan(g.right - g.left);
  await render(flat);
  await key("Home");
  expect(title()).toBe("= 1,5");
  await render({
    ...props,
    series: chartSeries(columns, [[null, "Север"]], spec),
  });
  expect(host.textContent).toContain("Нет числовых значений для гистограммы");
  expect(marks()).toHaveLength(0);
  expect(title()).toBeUndefined();
});

it("represents extreme and closely spaced edges without reporting distinct values as one", () => {
  expect(histogramRange({ lower: 0.301, upper: 0.302 }, false, "integer")).toBe(
    "[0,301; 0,302)",
  );
  expect(histogramRange({ lower: 1e-100, upper: 1e-100 }, true, "auto")).toBe(
    "= 1e-100",
  );
  const bins = [
    { lower: -Number.MAX_VALUE, upper: 0 },
    { lower: 0, upper: Number.MAX_VALUE },
  ];
  const g = histogramGeometry(
    {
      ...props,
      series: [
        {
          name: "Край",
          histogramBins: bins,
          data: [
            [-Number.MAX_VALUE, 1],
            [0, 1],
          ],
        },
      ],
    },
    540,
    350,
  );
  expect(g.columns[0].x0).toBe(g.left);
  expect(g.columns[1].x1).toBe(g.right);
  expect(g.xTicks.every((t) => Number.isFinite(t.x))).toBe(true);
  expect(g.hit(g.columns[1].x0, g.top)).toBe(1);
});

it("keeps axes on refresh, replaces old samples with the matching skeleton, and restores the real marks", async () => {
  await render();
  await key("Home");
  const before = host.querySelector(".bk-histogram-tick-x");
  await render({ ...props, loading: true });
  expect(host.querySelector(".bk-histogram-distribution")).toBeNull();
  expect(title()).toBeUndefined();
  expect(host.querySelector(".bk-histogram-tick-x")).toBe(before);
  expect(
    host.querySelectorAll('[data-skeleton-mark="histogram"] path'),
  ).toHaveLength(8);
  expect(host.querySelector('[data-skeleton-mark="bar"]')).toBeNull();
  await render();
  expect(host.querySelector("[data-skeleton-mark]")).toBeNull();
  expect(marks()).toHaveLength(4);
  await act(async () =>
    root.render(createElement(ChartSkeleton, { spec, count: 6 })),
  );
  expect(
    host.querySelectorAll('[data-skeleton-mark="histogram"] path'),
  ).toHaveLength(8);
});
