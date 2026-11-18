import { describe, expect, it } from "vitest";
import type { Cell, ChartSpec } from "../src/shared/types";
import { chartSeries } from "../src/client/board/model";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";

const columns = [
  { id: "x", name: "Категория", type: "String" },
  { id: "revenue", name: "Показатель", type: "Float64" },
  // Repeated display names must not merge separate metrics into one stack.
  { id: "visits", name: "Показатель", type: "Float64" },
  { id: "group", name: "Разбивка", type: "String" },
];
const spec: ChartSpec = {
  kind: "bar",
  x: "x",
  y: ["revenue", "visits"],
  series: "group",
  legend: true,
  stacked: true,
};
const rows: Cell[][] = [
  ["A", 2, 20, "one"],
  ["B", 4, 40, "one"],
  ["C", null, 100, "one"],
  ["B", 3, 30, "two"],
  ["A", 5, 50, "two"],
  ["D", 7, 70, "two"],
  ["C", 8, null, "two"],
  ["A", -3, -30, "negative"],
  ["A", -4, -40, "negative2"],
];

function plot(settings: ChartSpec, data: Cell[][] = rows) {
  const series = chartSeries(columns, data, settings);
  return cartesianGeometry(
    { spec: settings, series, colors: series.map(() => "#aabbcc") },
    700,
    360,
  );
}
describe("stacked breakdown charts", () => {
  it.each(["bar", "line", "area"] as const)(
    "groups %s by metric ID and splits positive and negative breakdowns at zero",
    (kind) => {
      const g = plot({ ...spec, kind });
      const at = (id: string, group: string) => {
        const mark = g.marks.find(
          (m) => m.metricId === id && m.name.endsWith(" · " + group),
        )!;
        return mark.points.find(
          (p) => p.category === g.categories.indexOf("A"),
        )!;
      };
      for (const [metric, mul] of [
        ["revenue", 1],
        ["visits", 10],
      ] as const) {
        const a = at(metric, "one"),
          b = at(metric, "two"),
          n = at(metric, "negative"),
          n2 = at(metric, "negative2");
        expect([a.basePx, a.endPx, b.basePx, b.endPx]).toEqual([
          g.zero,
          g.scale(2 * mul),
          g.scale(2 * mul),
          g.scale(7 * mul),
        ]);
        expect([n.basePx, n.endPx, n2.basePx, n2.endPx]).toEqual([
          g.zero,
          g.scale(-3 * mul),
          g.scale(-3 * mul),
          g.scale(-7 * mul),
        ]);
        expect(b.value).toBe(5 * mul);
      }
    },
  );
  it.each([
    { ...spec, stacked: undefined },
    { ...spec, stacked: false },
    { ...spec, series: undefined },
    { ...spec, kind: "line" as const, stacked: false },
    { ...spec, kind: "area" as const, stacked: false },
  ])(
    "plots ordinary values for a disabled stack or absent breakdown: %j",
    (settings) => {
      const g = plot(settings);
      expect(g.stacked).toBe(false);
      for (const mark of g.marks)
        for (const point of mark.points) {
          expect(point.basePx).toBe(g.zero);
          if (point.value !== null)
            expect(point.endPx).toBe(g.scale(point.value));
        }
    },
  );
  it.each([
    ["none", ["10", "2", "30", "1"]],
    ["asc", ["1", "2", "10", "30"]],
    ["desc", ["30", "10", "2", "1"]],
  ] as const)(
    "keeps a global sparse-category order for %s",
    (sort, expected) => {
      const sparse: Cell[][] = [
        ["10", 1, 10, "one"],
        ["2", 2, 20, "two"],
        ["30", 3, 30, "one"],
        ["1", 4, 40, "two"],
      ];
      for (const kind of ["bar", "line", "area"] as const) {
        const result = plot({ ...spec, sort, kind }, sparse);
        expect(result.categories).toEqual(expected);
        if (kind !== "bar")
          expect(
            result.marks[0].points.map((p) => result.categories[p.category]),
          ).toEqual(expected);
      }
    },
  );

  it("rejects duplicate X/breakdown rows only for active stacked charts", () => {
    const duplicate: Cell[][] = [
      ["A", 1, 10, "one"],
      ["A", 2, 20, "one"],
    ];
    for (const kind of ["bar", "line", "area"] as const)
      expect(() => chartSeries(columns, duplicate, { ...spec, kind })).toThrow(
        /SQL \(GROUP BY\)/,
      );
    for (const next of [
      { ...spec, stacked: false },
      { ...spec, series: undefined },
      { ...spec, kind: "line" as const, stacked: false },
      { ...spec, kind: "area" as const, stacked: false },
      { ...spec, kind: "scatter" as const, x: "visits" },
    ])
      expect(() => chartSeries(columns, duplicate, next)).not.toThrow();
  });

  it.each(["line", "area"] as const)(
    "breaks %s paths at missing and null categories, keeping each band's own baseline",
    (kind) => {
      const data: Cell[][] = [
        ["A", 2, 20, "one"],
        ["B", null, 40, "one"],
        ["C", 4, 40, "one"],
        ["C", 6, 60, "two"],
        ["A", 3, 30, "two"],
        ["D", 8, 80, "two"],
      ];
      const g = plot({ ...spec, kind }, data);
      const second = g.marks.find(
        (m) => m.metricId === "revenue" && m.name.endsWith(" · two"),
      )!;
      expect(second.points.map((p) => p.value)).toEqual([3, null, 6, 8]);
      expect(
        second.points.filter((p) => p.value !== null).map((p) => p.endPx),
      ).toEqual([g.scale(5), g.scale(10), g.scale(8)]);
      expect(
        second.points.filter((p) => p.value !== null).map((p) => p.basePx),
      ).toEqual([g.scale(2), g.scale(4), g.zero]);
      expect(second.stroke.match(/M/g)).toHaveLength(2);
      if (kind === "area") expect(second.fill.match(/Z/g)).toHaveLength(2);
      else expect(second.fill).toBe("");
    },
  );
  it.each(["line", "area"] as const)(
    "limits sparse %s expansion before allocating gaps",
    (kind) => {
      const sparse: Cell[][] = Array.from({ length: 51 }, (_, index) => [
        String(index),
        index,
        index,
        `group-${index}`,
      ]);
      expect(() => chartSeries(columns, sparse, { ...spec, kind })).toThrow(
        /5 000/,
      );
      expect(() => chartSeries(columns, sparse, spec)).not.toThrow();
      expect(() =>
        chartSeries(columns, sparse, { ...spec, kind, stacked: false }),
      ).not.toThrow();
    },
  );

  it("preserves source rows and null values when preparing and rendering stacks", () => {
    const original = structuredClone(rows);
    plot({ ...spec, sort: "asc" });
    expect(rows).toEqual(original);
    expect(chartSeries(columns, rows, spec)[0].data[2]).toEqual(["C", null]);
  });
});
