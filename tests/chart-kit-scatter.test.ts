// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ScatterPlot from "../src/client/board/chart-kit/ScatterPlot";
import { scatterGeometry } from "../src/client/board/chart-kit/scatter-geometry";
import type { ChartPlotProps } from "../src/client/board/chart-kit/plot-types";

const props: ChartPlotProps = {
  columns: [
    { id: "x", name: "Время", type: "Float64" },
    { id: "v", name: "Выручка", type: "Float64" },
  ],
  spec: { kind: "scatter", x: "x", y: ["v"], legend: true, showLabels: true },
  label: "Результат",
  colors: ["#81d98b", "#ab7319"],
  series: [
    {
      name: "Север",
      colorKey: "north",
      data: [
        [1, 2],
        [2, 9],
        [22, 9],
        [null, 1],
        [4, null],
      ],
      displayData: [
        { x: "X:1", value: "2 шт.", color: "#cc0077" },
        { x: "X:2", value: "9 шт." },
        { x: "X:22", value: "Девять" },
      ],
    },
    {
      name: "Юг",
      colorKey: "south",
      data: [
        [2, 9],
        [2, -12],
      ],
      displayData: [
        { x: "Сервис", value: "Дубликат" },
        { x: "Второй", value: "Минус" },
      ],
    },
  ],
};
it("projects numeric axes independently and finds the nearest real 2D point including signed and duplicate coordinates", () => {
  const g = scatterGeometry(props, 540, 350),
    [a, b, c, duplicate, negative] = g.points;
  expect(g.points).toHaveLength(5);
  expect((c.cx - b.cx) / (b.cx - a.cx)).toBeCloseTo(20);
  expect(b.cy).toBe(c.cy);
  expect(negative.cy).toBeGreaterThan(b.cy);
  expect(g.hit(negative.cx + 1, negative.cy + 2)).toBe(negative);
  expect(g.hit(b.cx, b.cy)).toBe(duplicate);
  expect(g.hit(-100, -100)).toBeNull();
  expect(g.order.map((p) => p.key)).toEqual([
    a.key,
    negative.key,
    b.key,
    duplicate.key,
    c.key,
  ]);
});
it("keeps points, scales and ticks finite for opposing Float64 limits, subnormal and all-zero coordinates", () => {
  const extreme = {
    ...props,
    series: [
      {
        name: "Края",
        data: [
          [-Number.MAX_VALUE, -Number.MIN_VALUE],
          [0, 0],
          [Number.MAX_VALUE, Number.MIN_VALUE],
        ] as [number, number][],
      },
    ],
  };
  const g = scatterGeometry(extreme, 540, 350);
  expect(
    g.points.every((p) => Number.isFinite(p.cx) && Number.isFinite(p.cy)),
  ).toBe(true);
  expect(g.points[0].cx).toBeLessThan(g.points[1].cx);
  expect(g.points[1].cy).toBeGreaterThan(g.points[2].cy);
  for (const a of [g.xAxis, g.yAxis])
    expect(a.ticks.every(Number.isFinite)).toBe(true);
  const flat = scatterGeometry(
    { ...props, series: [{ name: "Ноль", data: [[0, 0]] }] },
    540,
    350,
  );
  expect(flat.points[0].cx).toBeCloseTo((flat.left + flat.right) / 2);
  expect(flat.points[0].cy).toBeCloseTo((flat.top + flat.bottom) / 2);
});
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
const render = (p: ChartPlotProps = props) =>
  act(async () => root.render(createElement(ScatterPlot, p)));
const key = (key: string) =>
  act(async () => {
    host
      .querySelector('svg[role="img"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }),
      );
  });
const tip = () => host.querySelector('[role="tooltip"]');
it("preserves table-formatted labels, point colors, accessible keyboard inspection and both numeric-axis controls", async () => {
  await render();
  const first = host.querySelector(".bk-scatter-point");
  expect(first?.getAttribute("fill")).toBe("#cc0077");
  expect(host.querySelectorAll(".bk-scatter-point")).toHaveLength(5);
  await key("Home");
  expect(tip()?.textContent).toContain("X:1");
  expect(tip()?.textContent).toContain("2 шт.");
  expect(host.querySelector("svg")?.getAttribute("aria-describedby")).toBe(
    tip()?.id,
  );
  for (const value of ["Минус", "9 шт.", "Дубликат", "Девять"]) {
    await key("ArrowRight");
    expect(tip()?.textContent).toContain(value);
  }
  expect(host.querySelector(".bk-scatter-point")).toBe(first);
  await key("Escape");
  expect(tip()).toBeNull();
  await render({
    ...props,
    spec: {
      ...props.spec,
      showXAxis: false,
      showYAxis: false,
      showGrid: true,
      showLabels: false,
    },
  });
  expect(
    host.querySelector(
      ".bk-scatter-tick-x,.bk-scatter-tick-y,.bk-scatter-label",
    ),
  ).toBeNull();
  expect(host.querySelector(".bk-scatter-grid-x")).toBeTruthy();
  expect(host.querySelector(".bk-scatter-grid-y")).toBeTruthy();
});
it("keeps numeric axes while loading a point-cloud silhouette and restores only the visible series", async () => {
  await render();
  await key("Home");
  const tick = host.querySelector(".bk-scatter-tick-x");
  await render({ ...props, loading: true });
  expect(tip()).toBeNull();
  expect(host.querySelector(".bk-scatter-cloud")).toBeNull();
  expect(host.querySelector('[data-skeleton-mark="point"]')).toBeTruthy();
  expect(host.querySelector(".bk-scatter-tick-x")).toBe(tick);
  await render({
    ...props,
    series: [props.series[1]],
    colors: [props.colors[1]],
  });
  expect(host.querySelector("[data-skeleton-mark]")).toBeNull();
  expect(host.querySelectorAll(".bk-scatter-point")).toHaveLength(2);
  expect(host.querySelector(".bk-scatter-point")?.getAttribute("fill")).toBe(
    props.colors[1],
  );
});
it("does not claim nulls as zero or place 5000 overlapping text labels and animations in a dense cloud", async () => {
  await render({
    ...props,
    series: [
      {
        name: "Пусто",
        data: [
          [null, 3],
          [1, null],
        ],
      },
    ],
  });
  expect(host.querySelector(".bk-scatter-point")).toBeNull();
  expect(host.textContent).toContain("Нет числовых пар");
  const dense: ChartPlotProps = {
    ...props,
    series: [
      {
        name: "Замеры",
        data: Array.from({ length: 5000 }, (_, i) => [i, (i * 17) % 83]),
      },
    ],
  };
  await render(dense);
  expect(host.querySelectorAll(".bk-scatter-point")).toHaveLength(5000);
  expect(host.querySelectorAll(".bk-scatter-enter").length).toBeLessThanOrEqual(
    12,
  );
  expect(host.querySelectorAll(".bk-scatter-label").length).toBeLessThan(400);
});

it("paints matched dots and their keyboard focus with the same pattern, border and color", async () => {
  await render({
    ...props,
    series: [
      {
        ...props.series[0],
        seriesStyle: { color: "#665544", opacity: 0.7 },
        pointStyles: [
          {
            color: "#ee9933",
            pattern: "dots",
            borderColor: "#3300aa",
            borderWidth: 3,
            borderStyle: "dotted",
            opacity: 0.4,
          },
        ],
      },
    ],
  });
  const [first, next] = host.querySelectorAll(".bk-scatter-point");
  const pattern = host.querySelector("pattern")!;
  const fill = `url(#${pattern.id})`;
  expect(first.getAttribute("fill")).toBe(fill);
  expect(pattern.querySelector("rect")?.getAttribute("fill")).toBe("#ee9933");
  expect(first.getAttribute("stroke")).toBe("#3300aa");
  expect(first.getAttribute("stroke-dasharray")).toBe("1 3");
  expect(next.getAttribute("fill")).toBe("#665544");
  await key("Home");
  const focusDot = host.querySelector(".bk-scatter-focus circle:last-child")!;
  expect(focusDot.getAttribute("fill")).toBe(fill);
  expect(focusDot.getAttribute("stroke-width")).toBe("3");
  expect(focusDot.getAttribute("fill-opacity")).toBe("0.4");
  expect(
    tip()?.querySelector<HTMLElement>(".chart-tooltip-swatch")?.style
      .backgroundColor,
  ).toBe("rgb(238, 153, 51)");
});
