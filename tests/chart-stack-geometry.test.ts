import { expect, it } from "vitest";
import { chartSeries, type ChartSeriesItem } from "../src/client/board/model";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";
import {
  barRect,
  focusColumns,
  pointerFocus,
} from "../src/client/board/chart-kit/cartesian-focus";
import type { Cell, ChartSpec } from "../src/shared/types";

const spec: ChartSpec = {
  kind: "bar",
  x: "period",
  y: ["sales", "visits"],
  series: "division",
  stacked: true,
  legend: true,
};
const columns = [
  { id: "period", name: "Период", type: "String" },
  { id: "sales", name: "Выручка", type: "Float64" },
  { id: "visits", name: "Посещения", type: "Float64" },
  { id: "division", name: "Филиал", type: "String" },
];
const rows: Cell[][] = [
  ["Q1", 8, 10, "a"],
  ["Q1", -7, 50, "b"],
  ["Q1", 5, -40, "c"],
  ["Q2", -2, 3, "a"],
  ["Q2", -3, null, "b"],
  ["Q3", null, 1, "c"],
  ["Q4", null, null, "d"],
  ["Q5", 4, 0, "a"],
  ["Q5", -4, null, "b"],
];
const all = chartSeries(columns, rows, spec);
function geometry(series = all, config = spec) {
  return cartesianGeometry(
    { series, spec: config, colors: series.map(() => "#abc") },
    460,
    250,
  );
}

it.each(["vertical", "horizontal"] as const)(
  "lays out %s sparse signed stacks, grouped by metric, and hit-tests each actual segment",
  (orientation) => {
    const g = geometry(all, { ...spec, orientation });
    expect(g.stacked).toBe(true);
    expect(g.categories).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    const at = (name: string, category: number) => {
      const m = g.marks.find((m) => m.name === name)!;
      return { m, p: m.points.find((p) => p.category === category)! };
    };
    const { m: a, p: bottom } = at("Выручка · a", 0);
    const { m: b, p: negative } = at("Выручка · b", 0);
    const { m: c, p: top } = at("Выручка · c", 0);
    const { m: visits, p: independent } = at("Посещения · b", 0);
    expect(a.offset).toBe(b.offset);
    expect(a.offset).toBe(c.offset);
    expect(visits.offset).toBeGreaterThan(c.offset);
    expect([bottom.basePx, bottom.endPx, bottom.outer]).toEqual([
      g.zero,
      g.scale(8),
      false,
    ]);
    expect([top.basePx, top.endPx, top.outer]).toEqual([
      g.scale(8),
      g.scale(13),
      true,
    ]);
    expect([negative.basePx, negative.endPx, negative.outer]).toEqual([
      g.zero,
      g.scale(-7),
      true,
    ]);
    expect([independent.basePx, independent.endPx]).toEqual([
      g.scale(10),
      g.scale(60),
    ]);
    expect(
      g.stackTotals.filter((t) => t.category === 0).map((t) => t.value),
    ).toEqual([6, 20]);
    expect(g.stackTotals.some((t) => t.category === 3)).toBe(false);
    const cancelled = g.stackTotals.find(
      (t) => t.category === 4 && t.metricId === "sales",
    )!;
    expect(cancelled.value).toBe(0);
    expect(g.horizontal ? cancelled.x : cancelled.y).toBe(g.scale(4));

    const samples = focusColumns(g);
    for (const { m, p } of [
      { m: a, p: bottom },
      { m: c, p: top },
      { m: b, p: negative },
      { m: visits, p: independent },
    ]) {
      const cross = g.center(0) + m.offset;
      const rect = barRect(g, cross, p.endPx, p.basePx);
      const selected = pointerFocus(
        g,
        samples,
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      )!;
      const sample = samples[selected.category][selected.sample];
      expect(sample.mark).toBe(m);
      expect(sample.point.value).toBe(p.value);
      expect(g.horizontal ? sample.x : sample.y).toBe(p.endPx);
    }
  },
);

it("recomputes lanes, net labels and the outer segment from visible data without losing explicit categories", () => {
  const bars = all.filter(
    (s) => s.name === "Выручка · b" || s.name === "Выручка · c",
  );
  const g = geometry(bars);
  expect(new Set(g.marks.map((m) => m.offset)).size).toBe(1);
  expect(g.categories).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
  expect(
    g.stackTotals.filter((t) => t.category === 0).map((t) => t.value),
  ).toEqual([-2]);
  expect(g.stackTotals.find((t) => t.category === 0)?.y).toBe(g.scale(-7));
  expect(g.marks.find((m) => m.name === "Выручка · c")!.points[0].outer).toBe(
    true,
  );
  const withoutTotals = geometry(bars, { ...spec, showTotals: false });
  expect(withoutTotals.stackTotals).toEqual([]);
});

it("keeps extreme segment coordinates finite, including cancellation of otherwise unrepresentable extents", () => {
  const m = Number.MAX_VALUE;
  const series: ChartSeriesItem[] = [m, m, -m].map((value, i) => ({
    name: String(i),
    data: [
      ["A", value],
      ["null", null],
    ],
  }));
  const g = geometry(series, { ...spec, y: ["sales"] });
  expect(g.stackTotals).toHaveLength(1);
  expect(g.stackTotals[0].value).toBe(m);
  expect(g.stackTotals[0].y).toBe(g.marks[1].points[0].endPx);
  for (const mark of g.marks)
    for (const p of mark.points) {
      expect(Number.isFinite(p.basePx)).toBe(true);
      expect(Number.isFinite(p.endPx)).toBe(true);
    }
  expect(g.ticks.length).toBeGreaterThan(0);
  expect(g.ticks.every(Number.isFinite)).toBe(true);
  const zero = geometry(
    [m, m, -m, -m].map((value, i) => ({
      name: String(i),
      data: [["A", value]],
    })),
    { ...spec, y: ["sales"] },
  );
  expect(zero.stackTotals[0].value).toBe(0);
  expect(zero.stackTotals[0].y).toBe(zero.marks[1].points[0].endPx);
  const overflow = geometry(series.slice(0, 2), { ...spec, y: ["sales"] });
  expect(overflow.stackTotals).toHaveLength(0);
  expect(Number.isFinite(overflow.marks[1].points[0].endPx)).toBe(true);
});

it("reserves outside room for signed net labels even when segment labels and axes are hidden", () => {
  const series: ChartSeriesItem[] = [
    {
      name: "Данные",
      metricId: "sales",
      data: [
        ["A", -1234567],
        ["B", 3456789],
      ],
    },
  ];
  const config: ChartSpec = {
    ...spec,
    orientation: "horizontal",
    showLabels: false,
    showXAxis: false,
    showYAxis: false,
  };
  const visible = geometry(series, config),
    hidden = geometry(series, { ...config, showTotals: false });
  expect(visible.left).toBeGreaterThan(hidden.left + 30);
  expect(hidden.right).toBeGreaterThan(visible.right + 30);
});
