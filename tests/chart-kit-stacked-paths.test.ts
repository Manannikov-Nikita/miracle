// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chartSeries } from "../src/client/board/model";
import { cartesianGeometry } from "../src/client/board/chart-kit/cartesian-geometry";
import {
  focusColumns,
  pointerFocus,
} from "../src/client/board/chart-kit/cartesian-focus";
import CartesianPlot from "../src/client/board/chart-kit/CartesianPlot";
import type { ChartPlotProps } from "../src/client/board/chart-kit/plot-types";
import type { Cell, ChartSpec } from "../src/shared/types";

const columns = ["x", "sales", "visits", "region"].map((id) => ({
  id,
  name: id,
  type: id === "x" || id === "region" ? "String" : "Float64",
}));
const rows: Cell[][] = [
  ["A", 3, 30, "North"],
  ["C", -4, 40, "North"],
  ["B", null, 20, "North"],
  ["C", -8, -5, "South"],
  ["A", 5, 55, "South"],
  ["D", 9, 60, "South"],
];
function inputs(kind: "line" | "area"): ChartPlotProps {
  const spec: ChartSpec = {
    kind,
    x: "x",
    y: ["sales", "visits"],
    series: "region",
    stacked: true,
    sort: "asc",
    legend: true,
    showLabels: true,
  };
  const series = chartSeries(columns, rows, spec, (v, c) => ({
    text: c.type === "String" ? String(v) : v === null ? "—" : `€${v}`,
    color: v === 5 ? "#d981a8" : undefined,
  }));
  return {
    columns,
    spec,
    series,
    colors: series.map(
      (_, i) => ["#397480", "#777777", "#84a941", "#228899"][i],
    ),
    label: "Выручка и посещения",
  };
}
let host: HTMLDivElement;
let root: Root;
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
function render(props: ChartPlotProps) {
  return act(async () => root.render(createElement(CartesianPlot, props)));
}

it.each(["line", "area"] as const)(
  "uses signed cumulative %s boundaries in category order without bridging sparse/null samples",
  async (kind) => {
    const props = inputs(kind);
    const g = cartesianGeometry(props, 460, 240);
    expect(g.categories).toEqual(["A", "B", "C", "D"]);
    expect(g.stackTotals).toEqual([]);
    const upper = g.marks.find((m) => m.name === "sales · South")!;
    const other = g.marks.find((m) => m.name === "visits · South")!;
    expect(upper.points.map((p) => p.value)).toEqual([5, null, -8, 9]);
    expect(upper.points.map((p) => p.basePx)).toEqual(
      [3, 0, -4, 0].map(g.scale),
    );
    expect(upper.points.map((p) => p.endPx)).toEqual(
      [8, 0, -12, 9].map(g.scale),
    );
    expect(other.points[0].basePx).toBe(g.scale(30));
    expect(other.points[0].endPx).toBe(g.scale(85));
    expect(other.points[2].basePx).toBe(g.zero);
    expect(upper.stroke.match(/M/g)).toHaveLength(kind === "area" ? 3 : 2);
    if (kind === "area") {
      expect(upper.fill.match(/Z/g)).toHaveLength(3);
      expect(upper.fill).toContain(
        `${Number(g.center(0).toFixed(3))},${Number(g.scale(3).toFixed(3))}`,
      );
      const samples = focusColumns(g);
      const selected = pointerFocus(g, samples, g.center(0), g.scale(4.8))!;
      expect(samples[0][selected.sample].mark.name).toBe("sales · South");
    } else expect(upper.fill).toBe("");
    await render(props);
    const layer = host.querySelectorAll(`[data-series-style="${kind}"]`)[
      upper.seriesIndex
    ];
    expect(layer.querySelector(".bk-line")?.getAttribute("d")).toBe(
      upper.stroke,
    );
    expect(
      layer.querySelector('circle[fill="#d981a8"]')?.getAttribute("cy"),
    ).toBe(String(g.scale(8)));
    expect(layer.textContent).toContain("€5");
    expect(host.querySelector(".bk-bar")).toBeNull();
    const svg = host.querySelector<SVGSVGElement>("svg[role=img]")!;
    await act(async () => svg.focus());
    await act(async () => {
      svg.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
      svg.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    const active = host.querySelector('[role="tooltip"] [data-active="true"]');
    expect(active?.textContent).toContain("sales · South");
    expect(active?.textContent).toContain("€5");
    expect(
      host.querySelector<SVGCircleElement>(".bk-focus-dot")?.style.transform,
    ).toContain(`${g.scale(8)}px`);
    await render({ ...props, loading: true });
    expect(host.querySelector(".bk-line")).toBeNull();
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
    expect(
      host.querySelectorAll(`[data-skeleton-mark="${kind}"][data-stacked]`),
    ).toHaveLength(4);
    expect(
      host.querySelector(
        kind === "area" ? ".chart-skeleton-sweep" : ".chart-skeleton-glint",
      ),
    ).not.toBeNull();
    const visible = props.series.filter((s) => s.name !== "sales · North");
    const next = { ...props, series: visible };
    await render(next);
    expect(host.querySelector(".chart-skeleton")).toBeNull();
    expect(host.querySelector(".bk-reveal")).not.toBeNull();
    const updated = cartesianGeometry(next, 460, 240);
    const remaining = updated.marks.find((m) => m.name === "sales · South")!;
    expect(remaining.points[0].basePx).toBe(updated.zero);
    expect(remaining.points[0].endPx).toBe(updated.scale(5));
    expect(updated.categories).toEqual(g.categories);
  },
);

it("keeps cumulative Float64 curves and both band edges finite for opposite extremes", () => {
  const props = inputs("area");
  props.series = [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE].map(
    (value, index) => ({
      name: String(index),
      metricId: "sales",
      xCategories: ["A", "B"],
      data: [
        ["A", value],
        ["B", -value],
      ],
    }),
  );
  const g = cartesianGeometry(props, 460, 240);
  for (const m of g.marks) {
    expect(m.stroke + m.fill).not.toMatch(/Infinity|NaN/);
    expect(
      m.points.every(
        (p) => Number.isFinite(p.basePx) && Number.isFinite(p.endPx),
      ),
    ).toBe(true);
  }
  expect(g.marks[1].points[0].basePx).toBe(g.marks[0].points[0].endPx);
  expect(g.marks[1].points[1].basePx).toBe(g.marks[0].points[1].endPx);
});

it.each(["#ffffff", "#202124"])(
  "closes each signed area lobe on its own stack without painting across zero on %s",
  async (background) => {
    const props = inputs("area");
    props.spec = { ...props.spec, y: ["sales"] };
    props.series = [
      {
        name: "lower positive",
        metricId: "sales",
        data: [
          ["A", 10],
          ["B", 4],
        ],
      },
      {
        name: "lower negative",
        metricId: "sales",
        data: [
          ["A", -9],
          ["B", -3],
        ],
      },
      {
        name: "changes sign",
        metricId: "sales",
        data: [
          ["A", 8],
          ["B", -4],
        ],
      },
    ];
    props.presentationBackground = background;
    const g = cartesianGeometry(props, 460, 240);
    const upper = g.marks[2];
    expect(upper.points.map((p) => p.value)).toEqual([8, -4]);
    const lobes = upper.fill.match(/M[^M]*Z/g)!;
    expect(lobes).toHaveLength(2);
    const coordinates = (path: string) =>
      Array.from(path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g), (match) => ({
        x: Number(match[1]),
        y: Number(match[2]),
      }));
    const pos = coordinates(lobes[0]),
      neg = coordinates(lobes[1]);
    expect(pos.every((p) => p.y <= g.zero)).toBe(true);
    expect(neg.every((p) => p.y >= g.zero)).toBe(true);
    const crossing = g.center(0) + (2 / 3) * g.slot;
    for (const [points, extent] of [
      [pos, 6],
      [neg, -5],
    ] as const) {
      const pinches = points.filter((p) => Math.abs(p.x - crossing) < 0.001);
      expect(pinches.length).toBeGreaterThan(0);
      expect(
        pinches.every((p) => Math.abs(p.y - g.scale(extent)) < 0.001),
      ).toBe(true);
    }
    await render(props);
    const fill = host
      .querySelectorAll('[data-series-style="area"]')[2]
      .querySelector("path");
    expect(fill?.getAttribute("d")).toBe(upper.fill);
    expect(fill?.getAttribute("fill")).toBe(props.colors[2]);
    expect(fill?.getAttribute("fill-opacity")).toBe("0.38");
  },
);
