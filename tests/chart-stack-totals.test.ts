// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chartSeries } from "../src/client/board/model";
import { formatChartNumber } from "../src/client/board/chart-number";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";
import { mountBoardChart, textNodes } from "./helpers/chart-render";
import type { Cell, ChartSpec } from "../src/shared/types";
const columns = [
  { id: "x", name: "Категория", type: "String" },
  { id: "revenue", name: "Выручка", type: "Float64" },
  { id: "visits", name: "Посещения", type: "Float64" },
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
  ["positive", 12, 120, "one"],
  ["positive", 18, 180, "two"],
  ["negative", -6, -60, "one"],
  ["negative", -9, -90, "two"],
  ["mixed", 7, -70, "one"],
  ["mixed", -2, 20, "two"],
  ["zero", 0, 0, "one"],
  ["cancelled", 5, 50, "one"],
  ["cancelled", -5, -50, "two"],
  ["sparse", null, 3, "one"],
  ["sparse", 4, null, "two"],
  ["missing", null, null, "one"],
];

describe("stack totals", () => {
  const chart = mountBoardChart();
  const props = (saved = spec, data = rows) => ({
    spec: saved,
    columns,
    series: chartSeries(columns, data, saved),
  });
  it("shows one net per metric/category, distinguishing zero, cancellation and all-null data", async () => {
    await chart.render(props());
    const values = [...chart.host.querySelectorAll(".bk-stack-category")].map(
      (el) => textNodes(el, ".bk-stack-total"),
    );
    expect(values).toEqual([
      ["30", "300"],
      ["-15", "-150"],
      ["5", "-50"],
      ["0", "0"],
      ["0", "0"],
      ["4", "3"],
      [],
    ]);
    expect(chart.host.querySelectorAll(".bk-legend button")).toHaveLength(4);
  });
  it.each([
    { ...spec, showTotals: false },
    { ...spec, stacked: false },
    { ...spec, series: undefined },
    { ...spec, kind: "line" as const },
    { ...spec, kind: "area" as const },
  ])("omits totals when disabled or unsupported: %j", async (saved) => {
    await chart.render(props(saved));
    expect(chart.host.querySelectorAll(".bk-stack-total")).toHaveLength(0);
  });
  it.each(["vertical", "horizontal"] as const)(
    "places %s net labels outside the visible signed extent and on the metric lane",
    async (orientation) => {
      const p = props({ ...spec, orientation });
      await chart.render(p);
      const g = cartesianGeometry(
        { ...p, colors: p.series.map(() => "#aabbcc") },
        700,
        360,
      );
      for (const total of g.stackTotals) {
        const slot =
          chart.host.querySelectorAll(".bk-stack-category")[total.category];
        const label = [...slot.querySelectorAll(".bk-stack-total")].find(
          (el) =>
            el.textContent === formatChartNumber(total.value) &&
            Math.abs(
              Number(
                el.getAttribute(orientation === "horizontal" ? "y" : "x"),
              ) - (orientation === "horizontal" ? total.y : total.x),
            ) < 0.001,
        );
        expect(label).toBeDefined();
        const x = Number(label!.getAttribute("x")),
          y = Number(label!.getAttribute("y"));
        if (orientation === "horizontal") {
          expect(y).toBeCloseTo(total.y, 4);
          if (total.value < 0) expect(x).toBeLessThan(total.x);
          else expect(x).toBeGreaterThan(total.x);
        } else {
          expect(x).toBeCloseTo(total.x, 4);
          if (total.value < 0) expect(y).toBeGreaterThan(total.y);
          else expect(y).toBeLessThan(total.y);
        }
      }
    },
  );
  it("formats stack totals independently of individual segment labels and preserves large signed totals", async () => {
    const data: Cell[][] = [
      ["A", 12, 0, "one"],
      ["A", 26, 0, "two"],
      ["B", 123456789, 0, "one"],
      ["B", 222222222, 0, "two"],
    ];
    const saved: ChartSpec = {
      ...spec,
      y: ["revenue"],
      orientation: "horizontal",
    };
    await chart.render(props(saved, data));
    expect(textNodes(chart.host, ".bk-stack-total")).toEqual([
      "38",
      formatChartNumber(345679011),
    ]);
    await chart.render(
      props({ ...saved, numberFormat: "compact", showLabels: true }, data),
    );
    expect(textNodes(chart.host, ".bk-stack-total")).toEqual(["38", "345.7M"]);
    expect(textNodes(chart.host, ".bk-stack-value")).toContain("222.2M");
  });
});
