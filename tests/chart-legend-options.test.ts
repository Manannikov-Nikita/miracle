// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import type { Cell, ChartSpec } from "../src/shared/types";
import { chartSeries } from "../src/client/board/model";
import { mountBoardChart, textNodes } from "./helpers/chart-render";

const columns = [
  { id: "period", name: "Период", type: "String" },
  { id: "value", name: "Значение", type: "Float64" },
  { id: "group", name: "Группа", type: "String" },
];
const spec: ChartSpec = {
  kind: "bar",
  x: "period",
  y: ["value"],
  series: "group",
  stacked: true,
  legend: true,
};
const chart = mountBoardChart();
const before: Cell[][] = [
  ["A", 12, "one"],
  ["A", 3, "two"],
];
function render(rows: Cell[][], saved = spec, loading = false) {
  return chart.render({
    columns,
    spec: saved,
    series: chartSeries(columns, rows, saved),
    loading,
  });
}
function button(name: string) {
  const found = [
    ...chart.host.querySelectorAll<HTMLButtonElement>(".bk-legend button"),
  ].find((b) => b.title === name);
  if (!found) throw Error("Missing legend button: " + name);
  return found;
}
const toggle = (name: string) => act(async () => button(name).click());
const totals = () => textNodes(chart.host, ".bk-stack-total");

it("shows every histogram group and its tooltip after a saved chart had filtered matching series", async () => {
  await render(before);
  await toggle("Значение · two");
  expect(totals()).toEqual(["12"]);
  const histogram: ChartSpec = {
    kind: "histogram",
    x: "value",
    y: [],
    series: "group",
    legend: true,
    binCount: 1,
  };
  await render(before, histogram);
  expect(chart.host.querySelector(".bk-legend")).toBeNull();
  const counts = [
    ...chart.host.querySelectorAll<SVGPathElement>(".bk-histogram-bar"),
  ].map((mark) => mark.dataset.count);
  expect(counts).toEqual(["1", "1"]);
  const svg = chart.host.querySelector('svg[role="img"]')!;
  await act(async () =>
    svg.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    ),
  );
  expect(textNodes(chart.host, ".chart-tooltip-name")).toEqual(["one", "two"]);
  expect(textNodes(chart.host, ".chart-tooltip-value")).toEqual(["1", "1"]);
});

it("keeps selection across resize and refresh while showing new series and recalculating visible totals", async () => {
  await render(before);
  expect(totals()).toEqual(["15"]);
  await toggle("Значение · one");
  expect(totals()).toEqual(["3"]);
  const selected = button("Значение · one");
  await chart.resize(300, 180);
  expect(button("Значение · one")).toBe(selected);
  expect(selected.getAttribute("aria-pressed")).toBe("false");
  await render(before, spec, true);
  expect(chart.host.querySelector(".chart-skeleton")).not.toBeNull();
  expect(chart.host.querySelector(".bk-bar")).toBeNull();
  await render([
    ["A", 800, "three"],
    ["A", 50, "one"],
  ]);
  expect(chart.host.querySelector(".chart-skeleton")).toBeNull();
  expect(selected.getAttribute("aria-pressed")).toBe("false");
  expect(button("Значение · three").getAttribute("aria-pressed")).toBe("true");
  expect(chart.host.querySelector('[title="Значение · two"]')).toBeNull();
  expect(totals()).toEqual(["800"]);
  await toggle("Значение · one");
  expect(totals()).toEqual(["850"]);
});
it("keeps typed groups with identical labels independently selectable", async () => {
  await render([
    ["A", 8, 1],
    ["A", 5, "1"],
  ]);
  const keys = [
    ...chart.host.querySelectorAll<HTMLButtonElement>(".bk-legend button"),
  ];
  expect(keys.map((b) => b.title)).toEqual(["Значение · 1", "Значение · 1"]);
  await act(async () => keys[0].click());
  expect(keys.map((b) => b.getAttribute("aria-pressed"))).toEqual([
    "false",
    "true",
  ]);
  expect(totals()).toEqual(["5"]);
});
it("restores all data while the legend is off and respects the prior selection when it returns", async () => {
  await render(before);
  await toggle("Значение · one");
  await toggle("Значение · two");
  expect(chart.host.querySelector(".bk-no-series")).not.toBeNull();
  expect(totals()).toEqual([]);
  await render(before, { ...spec, legend: false });
  expect(chart.host.querySelector(".bk-legend")).toBeNull();
  expect(totals()).toEqual(["15"]);
  await render(before);
  expect(chart.host.querySelector(".bk-no-series")).not.toBeNull();
  await toggle("Значение · one");
  expect(totals()).toEqual(["12"]);
});
it.each(["vertical", "horizontal"] as const)(
  "anchors %s loading stacks to the zero of the visible data",
  async (orientation) => {
    const rows: Cell[][] = [
      ["A", 10, "gain"],
      ["A", -10, "loss"],
      ["B", 2, "gain"],
      ["B", -4, "loss"],
    ];
    const saved = { ...spec, orientation };
    const bounds = async () => {
      await render(rows, saved, true);
      const shapes = [
        ...chart.host.querySelectorAll('[data-skeleton-mark="bar"] rect'),
      ];
      expect(shapes.length).toBeGreaterThan(0);
      return shapes.map((rect) => {
        const start = parseFloat(
          rect.getAttribute(orientation === "horizontal" ? "x" : "y")!,
        );
        const length = parseFloat(
          rect.getAttribute(orientation === "horizontal" ? "width" : "height")!,
        );
        return { start, end: start + length };
      });
    };
    await render(rows, saved);
    const mixed = await bounds();
    expect(mixed.some((b) => Math.abs(b.start - 50) < 0.001)).toBe(true);
    expect(mixed.some((b) => Math.abs(b.end - 50) < 0.001)).toBe(true);
    await render(rows, saved);
    await toggle("Значение · gain");
    const negatives = await bounds();
    await render(rows, saved);
    await toggle("Значение · gain");
    await toggle("Значение · loss");
    const positives = await bounds();
    for (const b of orientation === "horizontal" ? positives : negatives)
      expect(b.start).toBeCloseTo(0);
    for (const b of orientation === "horizontal" ? negatives : positives)
      expect(b.end).toBeCloseTo(100);
  },
);

it("forgets a hidden series after a completed result removes it", async () => {
  await render(before);
  await toggle("Значение · two");
  await render([before[0]]);
  await render(before);
  expect(button("Значение · two").getAttribute("aria-pressed")).toBe("true");
  expect(totals()).toEqual(["15"]);
});
