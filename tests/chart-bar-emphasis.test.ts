// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useChartPaint } from "../src/client/board/chart-kit/mark-paint";
import CartesianMarks from "../src/client/board/chart-kit/CartesianMarks";
import {
  focusColumns,
  type Sample,
} from "../src/client/board/chart-kit/cartesian-focus";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";
import type { ChartSeriesItem } from "../src/client/board/model";
import type { ChartSpec } from "../src/shared/types";

const spec: ChartSpec = {
  kind: "composed",
  x: "period",
  y: ["current", "plan", "trend"],
  legend: true,
  showLabels: true,
  metricStyles: { current: "bar", plan: "bar", trend: "line" },
};
const series: ChartSeriesItem[] = [
  {
    metricId: "current",
    name: "Продажи",
    data: [
      ["Янв", 9],
      ["Фев", -4],
    ],
    displayData: [
      { x: "Янв", value: "9 шт.", color: "#f6a081" },
      { x: "Фев", value: "−4 шт." },
    ],
  },
  {
    metricId: "plan",
    name: "План",
    data: [
      ["Янв", 6],
      ["Фев", 8],
    ],
  },
  {
    metricId: "trend",
    name: "Тренд",
    data: [
      ["Янв", 5],
      ["Фев", 8],
    ],
  },
];
let host: HTMLElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function setupMarks(items: ChartSeriesItem[], colors: string[]) {
  const geometry = cartesianGeometry({ series: items, spec, colors }, 480, 240);
  function Marks({ emphasizedBars }: { emphasizedBars: readonly Sample[] }) {
    const paint = useChartPaint(items, colors);
    return createElement(
      "svg",
      null,
      paint.defs,
      createElement(CartesianMarks, {
        spec,
        geometry,
        paint,
        width: 480,
        emphasizedBars,
      }),
    );
  }
  return {
    geometry,
    draw: (emphasizedBars: readonly Sample[]) =>
      act(async () => root.render(createElement(Marks, { emphasizedBars }))),
  };
}
const activeRects = () => [...host.querySelectorAll(".bk-active-bar")];
it("crossfades original bars by sample or entire category without replacing any rectangle/label or rewriting its geometry", async () => {
  const { geometry: g, draw } = setupMarks(series, ["#666", "#999", "#ccc"]);
  const samples = focusColumns(g);
  await draw([]);
  const bars = [...host.querySelectorAll(".bk-bar")];
  const labels = [...host.querySelectorAll('[data-series-style="bar"] text')];
  const mutations: MutationRecord[] = [];
  const observer = new MutationObserver((records) =>
    mutations.push(...records),
  );
  observer.observe(host, { childList: true, attributes: true, subtree: true });
  await draw([samples[0][1]]);
  expect(activeRects()).toEqual([bars[2]]);
  await draw(samples[1]);
  expect(activeRects()).toEqual([bars[1], bars[3]]);
  await draw(samples[0]);
  expect(activeRects()).toEqual([bars[0], bars[2]]);
  await draw([]);
  expect(activeRects()).toHaveLength(0);
  expect(host.querySelector(".bk-bar")).toBe(bars[0]);
  expect(bars[0].getAttribute("fill")).toBe("#f6a081");
  expect(labels[0].textContent).toBe("9 шт.");
  expect(host.contains(labels[0])).toBe(true);
  mutations.push(...observer.takeRecords());
  observer.disconnect();
  expect(mutations.length).toBeGreaterThan(0);
  expect(
    mutations.every(
      (change) =>
        change.type === "attributes" && change.attributeName === "class",
    ),
  ).toBe(true);
});
it("does not traverse plotted marks on subsequent inspections and differentiates duplicate observations at the same category", async () => {
  const many: ChartSeriesItem = {
    metricId: "current",
    name: "Продажи",
    data: Array.from({ length: 128 }, (_, i) => ["Один период", i + 1]),
  };
  const { geometry: g, draw } = setupMarks([many], ["#934"]);
  const samples = focusColumns(g)[0];
  await draw([]);
  const bars = host.querySelectorAll(".bk-bar");
  const map = vi.spyOn(g.marks, "map");
  await draw([samples[0]]);
  await draw([samples[83]]);
  expect(activeRects()).toEqual([bars[83]]);
  expect(map).not.toHaveBeenCalled();
  map.mockRestore();
});
