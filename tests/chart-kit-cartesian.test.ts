import { expect, it } from "vitest";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";
import { chartSeries } from "../src/client/board/model";
import type { Cell, ChartSpec } from "../src/shared/types";

const columns = [
  { id: "x", name: "Месяц", type: "String" },
  { id: "n", name: "Продажи", type: "Float64" },
  { id: "m", name: "План", type: "Float64" },
  { id: "group", name: "Регион", type: "String" },
];
const spec: ChartSpec = {
  kind: "composed",
  x: "x",
  y: ["n", "m"],
  legend: true,
};
function geometry(rows: Cell[][], saved = spec) {
  const series = chartSeries(columns, rows, saved);
  return cartesianGeometry(
    { series, spec: saved, colors: series.map(() => "#aaa") },
    420,
    220,
  );
}
it("draws area, bar and line layers in order and splits paths on nulls", () => {
  const rows = [
    ["A", 1, 10],
    ["B", 2, null],
    ["C", 3, 30],
  ];
  const mixed = geometry(rows);
  expect(mixed.marks.map((s) => s.style)).toEqual(["bar", "line"]);
  expect(mixed.marks[1].stroke.match(/M/g)).toHaveLength(2);
  const changed = geometry(rows, {
    ...spec,
    metricStyles: { n: "bar", m: "area" },
  });
  expect(changed.marks.map((s) => s.style)).toEqual(["area", "bar"]);
  expect(changed.marks[0].fill).toContain("Z");
});
it("keeps sparse breakdown paths in shared axis order and preserves coincident observations", () => {
  const rows = [
    ["May", 1, 1, "a"],
    ["June", 2, 1, "a"],
    ["June", 3, 1, "b"],
    ["May", 4, 1, "b"],
    ["May", 5, 1, "b"],
  ];
  const g = geometry(rows, {
    ...spec,
    kind: "line",
    y: ["n"],
    series: "group",
  });
  expect(g.categories).toEqual(["May", "June"]);
  expect(g.marks[1].points.map((p) => p.value)).toEqual([4, 5, 3]);
});
it.each([
  [-8e15, 8e15],
  [0, Number.MIN_VALUE],
])("keeps finite scales for %s to %s", (a, b) => {
  const g = geometry(
    [
      ["A", a],
      ["B", b],
    ],
    { ...spec, kind: "line", y: ["n"] },
  );
  expect(g.scale(a)).toBeGreaterThan(g.scale(b));
  expect(g.ticks.length).toBeGreaterThan(0);
  expect(g.ticks.every(Number.isFinite)).toBe(true);
});
it("reserves room on both ends for signed horizontal value labels even without axes", () => {
  const g = geometry(
    [
      ["A", -100, 1],
      ["B", 100, 1],
    ],
    {
      ...spec,
      kind: "bar",
      orientation: "horizontal",
      showLabels: true,
      showXAxis: false,
      showYAxis: false,
    },
  );
  expect(g.scale(-100)).toBeGreaterThan(28);
  expect(g.scale(100)).toBeLessThan(420 - 21);
});
