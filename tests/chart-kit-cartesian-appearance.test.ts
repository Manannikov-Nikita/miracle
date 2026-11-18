// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it } from "vitest";
import { chartSeries } from "../src/client/board/model";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";
import { chartSeriesColorKey } from "../src/shared/chart-appearance";
import type { Cell, ChartMarkStyle, ChartSpec } from "../src/shared/types";
import { mountBoardChart } from "./helpers/chart-render";

const columns = [
  { id: "x", name: "День", type: "String" },
  { id: "n", name: "Замер", type: "Nullable(Float64)" },
  { id: "q", name: "План", type: "Nullable(Float64)" },
  { id: "g", name: "Группа", type: "String" },
];
const special: ChartMarkStyle = {
  color: "#bb2255",
  opacity: 0.65,
  pattern: "diagonal",
  borderColor: "#391c2d",
  borderWidth: 3,
  borderStyle: "dashed",
};
const base: ChartSpec = { kind: "bar", x: "x", y: ["n"], legend: true };
const chart = mountBoardChart();
async function render(spec: ChartSpec, rows: Cell[][]) {
  const series = chartSeries(columns, rows, spec);
  await chart.render({ columns, spec, series });
  return series;
}
function pathPaint(el: Element, attr = "fill") {
  const value = el.getAttribute(attr)!;
  const pattern = Array.from(chart.host.querySelectorAll("pattern")).find(
    (p) => value === "url(#" + p.id + ")",
  );
  return pattern?.querySelector("rect")?.getAttribute("fill") ?? value;
}
function press(key: string) {
  return act(async () => {
    chart.host
      .querySelector('svg[role="img"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("cartesian conditional mark appearance", () => {
  it.each([
    { orientation: "horizontal", stacked: false },
    { orientation: "vertical", stacked: false },
    { orientation: "horizontal", stacked: true },
    { orientation: "vertical", stacked: true },
  ] as const)(
    "formats the real $orientation bar and its focus marker with stacked=$stacked",
    async ({ orientation, stacked }) => {
      const seriesKey = chartSeriesColorKey("n", "g", "А");
      const saved: ChartSpec = {
        ...base,
        series: "g",
        orientation,
        stacked,
        seriesStyles: { [seriesKey]: { color: "#223344", opacity: 0.85 } },
        markRules: [
          {
            seriesKey,
            when: { field: "x", op: "eq", value: "II" },
            style: special,
          },
        ],
      };
      await render(saved, [
        ["I", 6, null, "А"],
        ["I", 3, null, "Б"],
        ["II", -8, null, "А"],
        ["II", -3, null, "Б"],
      ]);
      const marks = Array.from(chart.host.querySelectorAll(".bk-bar"));
      expect(marks).toHaveLength(4);
      const affected = marks.filter((el) =>
        el.getAttribute("fill")?.startsWith("url("),
      );
      expect(affected).toHaveLength(1);
      expect(pathPaint(affected[0])).toBe(special.color);
      expect(affected[0].getAttribute("stroke")).toBe(special.borderColor);
      expect(affected[0].getAttribute("stroke-width")).toBe("3");
      expect(affected[0].getAttribute("stroke-dasharray")).toBe("5 3");
      expect(affected[0].getAttribute("fill-opacity")).toBe("0.65");
      expect(
        marks
          .find((m) => m.getAttribute("fill") === "#223344")
          ?.getAttribute("fill-opacity"),
      ).toBe("0.85");
      await press("Home");
      await press("End");
      const selected = chart.host.querySelector(".bk-active-bar")!;
      expect(selected).toBe(affected[0]);
      expect(pathPaint(chart.host.querySelector(".bk-focus-dot")!)).toBe(
        special.color,
      );
    },
  );

  it.each(["line", "area", "composed"] as const)(
    "styles each incoming %s curve, keeps null gaps and preserves paints while inspecting",
    async (kind) => {
      const saved: ChartSpec = {
        ...base,
        kind,
        y: kind === "composed" ? ["q", "n"] : ["n"],
        metricStyles: kind === "composed" ? { q: "bar", n: "area" } : undefined,
        seriesStyles: {
          [chartSeriesColorKey("n", undefined, undefined)]: {
            color: "#226655",
          },
        },
        markRules: [
          {
            seriesKey: chartSeriesColorKey("n", undefined, undefined),
            when: { field: "x", op: "eq", value: "B" },
            style: special,
          },
        ],
      };
      await render(saved, [
        ["A", 2, 4],
        ["B", 7, 3],
        ["C", 4, 4],
        ["D", null, 3],
        ["E", 6, 4],
        ["F", 1, 2],
      ]);
      const group = chart.host.querySelector(
        '[data-series-style="' + (kind === "line" ? "line" : "area") + '"]',
      )!;
      const paths = Array.from(group.querySelectorAll(".bk-line"));
      expect(paths.map((p) => pathPaint(p, "stroke"))).toEqual([
        "#bb2255",
        "#226655",
        "#226655",
      ]);
      const outline = group.querySelector(".bk-line-outline")!;
      expect(outline.getAttribute("d")).toBe(paths[0].getAttribute("d"));
      expect(outline.getAttribute("stroke-dasharray")).toBe("5 3");
      expect(Number(outline.getAttribute("stroke-width"))).toBeGreaterThan(
        Number(paths[0].getAttribute("stroke-width")),
      );
      expect(group.querySelectorAll("circle")).toHaveLength(5);
      if (kind !== "line") {
        const fills = Array.from(group.querySelectorAll(".bk-area-fill"));
        expect(fills.map((p) => pathPaint(p))).toEqual([
          "#bb2255",
          "#226655",
          "#226655",
        ]);
        expect(fills[0].getAttribute("fill-opacity")).toBe("0.65");
        expect(fills.every((p) => p.getAttribute("d")?.endsWith("Z"))).toBe(
          true,
        );
      }
      await press("Home");
      await press("ArrowRight");
      expect(chart.host.querySelectorAll(".bk-focus path")).toHaveLength(0);
      expect(
        Array.from(chart.host.querySelectorAll(".bk-focus-dot")).map((m) =>
          pathPaint(m),
        ),
      ).toContain(special.color);
      expect(group.querySelector(".bk-line")).toBe(paths[0]);
      expect(group.classList.contains("bk-active-series")).toBe(
        kind !== "composed",
      );
      expect(chart.host.querySelector("[role=tooltip]")?.textContent).toContain(
        "7",
      );
    },
  );

  it.each(["line", "area"] as const)(
    "preserves legacy table colors on %s markers and only restyles the requested incoming edge",
    async (kind) => {
      const saved: ChartSpec = {
        ...base,
        kind,
        seriesColors: {
          [chartSeriesColorKey("n", undefined, undefined)]: "#446699",
        },
      };
      const rows: Cell[][] = [
        ["A", 2],
        ["B", 6],
        ["C", 3],
        ["D", 8],
      ];
      const draw = (spec: ChartSpec) =>
        chart.render({
          columns,
          spec,
          series: chartSeries(columns, rows, spec, (v, _c, role) => ({
            text: String(v),
            color: role === "metric" ? "#991122" : undefined,
          })),
        });
      await draw(saved);
      const strokes = () =>
        Array.from(chart.host.querySelectorAll(".bk-line"), (p) =>
          p.getAttribute("stroke"),
        );
      expect(strokes()).toEqual(["#446699"]);
      if (kind === "area")
        expect(
          chart.host.querySelector(".bk-area-fill")?.getAttribute("fill"),
        ).toBe("#446699");
      expect(
        Array.from(chart.host.querySelectorAll(".bk-marks circle"), (p) =>
          p.getAttribute("fill"),
        ),
      ).toEqual(Array(4).fill("#991122"));
      await press("Home");
      expect(
        chart.host.querySelector(".bk-focus-dot")?.getAttribute("fill"),
      ).toBe("#991122");
      await draw({
        ...saved,
        markRules: [
          {
            when: { field: "x", op: "eq", value: "C" },
            style: { color: "#cc4422" },
          },
        ],
      });
      expect(strokes()).toEqual(["#446699", "#cc4422", "#446699"]);
    },
  );

  it("keeps both signed lobes of an incoming stacked-area edge in the same conditional paint", () => {
    const saved: ChartSpec = {
      ...base,
      kind: "area",
      series: "g",
      stacked: true,
      markRules: [
        { when: { field: "value", op: "lt", value: 0 }, style: special },
      ],
    };
    const series = chartSeries(
      columns,
      [
        ["A", 10, null, "Г"],
        ["B", -8, null, "Г"],
      ],
      saved,
    );
    const g = cartesianGeometry(
      { spec: saved, series, colors: ["#002266"] },
      702,
      455,
    );
    expect(g.marks[0].parts).toHaveLength(2);
    expect(g.marks[0].parts?.map((p) => p.color)).toEqual([
      special.color,
      special.color,
    ]);
    expect(g.marks[0].parts?.every((p) => p.fill?.endsWith("Z"))).toBe(true);
  });
});
