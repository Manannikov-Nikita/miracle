import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChartThumbnail from "../src/client/board/chart-kit/ChartThumbnail";
import { thumbnailGeometry } from "../src/client/board/chart-kit/thumbnail-geometry";
import type { ChartSeriesItem } from "../src/client/board/model";
import type { ChartKind, ChartSpec } from "../src/shared/types";

const blue = "#82aaff",
  green = "#8ec9b0";
const base: ChartSpec = { kind: "bar", x: "x", y: ["y"], legend: true };
function group(data: ChartSeriesItem["data"], metricId = "y"): ChartSeriesItem {
  return { name: metricId, metricId, data };
}
function geom(
  kind: ChartKind,
  series: ChartSeriesItem[],
  options: Partial<ChartSpec> = {},
) {
  return thumbnailGeometry({
    spec: { ...base, kind, ...options },
    series,
    colors: series.map((_, j) => [blue, green][j % 2]),
  });
}
function rectangles(d: string) {
  return [
    ...d.matchAll(/M([-\d.]+),([-\d.]+)h([-\d.]+)v([-\d.]+)h[-\d.]+Z/g),
  ].map((match) => match.slice(1).map(Number));
}
describe("chart overview silhouettes", () => {
  it.each([
    "bar",
    "histogram",
    "line",
    "area",
    "scatter",
    "sparkline",
    "composed",
    "heatmap",
  ] as const)("renders an accessible static %s with data marks", (kind) => {
    const item = group([
      [0, 1],
      [1, 2],
      [2, 0],
    ]);
    if (kind === "histogram")
      item.histogramBins = [
        { lower: 0, upper: 1 },
        { lower: 1, upper: 2 },
        { lower: 2, upper: 3 },
      ];
    const svg = renderToStaticMarkup(
      createElement(ChartThumbnail, {
        columns: [],
        spec: { ...base, kind },
        series: [item],
        colors: [blue],
        label: "Продажи",
      }),
    );
    expect(svg).toContain('role="img"');
    expect(svg).toContain("Продажи");
    expect(svg).toContain("data-mark=");
    expect(svg).not.toMatch(
      /<(?:text|circle|rect|button|animate)\b|tabindex=|NaN|Infinity/,
    );
  });
  it.each([1, -1])(
    "preserves both extrema of a dense all-one-sign line (%s)",
    (sign) => {
      const data: ChartSeriesItem["data"] = Array.from(
        { length: 5000 },
        (_, i) => [i, sign * (i === 17 ? 20 : i === 19 ? 100 : 80)],
      );
      const { paths } = geom("line", [group(data)]);
      expect(paths).toHaveLength(1);
      const coordinates = [
        ...paths[0].d.matchAll(/[ML]([\d.]+),([\d.]+)/g),
      ].map((p) => [+p[1], +p[2]]);
      expect(coordinates.length).toBeLessThan(80);
      expect(coordinates).toContainEqual([12.8, sign === 1 ? 91 : 28]);
      expect(coordinates).toContainEqual([12.9, sign === 1 ? 7 : 112]);
    },
  );
  it.each(["line", "area", "sparkline"] as const)(
    "keeps %s gaps and isolated observations separate",
    (kind) => {
      const data: ChartSeriesItem["data"] = [
        [0, 1],
        [1, 2],
        [2, null],
        [3, 3],
        [4, null],
        [5, 1],
        [6, 3],
      ];
      const { paths } = geom(kind, [group(data)]);
      expect(
        paths
          .filter((p) => p.mark === "line")
          .map((p) => p.d)
          .join("")
          .match(/M/g),
      ).toHaveLength(2);
      expect(
        paths
          .filter((p) => p.mark === "point")
          .map((p) => p.d)
          .join("")
          .match(/M/g),
      ).toHaveLength(1);
    },
  );
  it("uses bounded colored density cells for scatter, including mixed locations and extreme finite coordinates", () => {
    const edge = Number.MAX_VALUE;
    const red = group([
      [-edge, -edge],
      [edge, edge],
      ...Array.from({ length: 1200 }, (): [number, number] => [0, 0]),
    ]);
    const other = group(Array.from({ length: 800 }, () => [0, 0]));
    const { paths } = geom("scatter", [red, other]);
    expect(paths.every((p) => p.mark === "density")).toBe(true);
    expect(paths.map((p) => p.color)).toContain(green);
    const peak = paths.filter((p) => p.opacity === 1);
    const [a] = rectangles(peak.find((p) => p.color === blue)!.d),
      [b] = rectangles(peak.find((p) => p.color === green)!.d);
    expect(a[2] / b[2]).toBeCloseTo(1.5, 1);
    expect(a[0] + a[2]).toBeCloseTo(b[0], 1);
    expect(
      paths.filter((p) => p.opacity < 1).flatMap((p) => rectangles(p.d)),
    ).toHaveLength(2);
    expect(paths.map((p) => p.d).join("")).not.toMatch(/Infinity|NaN/);
  });
  it("shows signed stack extents for every breakdown even after merging its tiny bands", () => {
    const series = Array.from({ length: 96 }, () =>
      group([
        ["a", 1],
        ["b", -1],
      ]),
    );
    const options = { stacked: true, series: "category" };
    const bars = geom("bar", series, options).paths.flatMap((p) =>
      rectangles(p.d),
    );
    expect(bars.length).toBeLessThanOrEqual(24);
    expect(Math.min(...bars.map(([, y]) => y))).toBeCloseTo(7, 1);
    expect(Math.max(...bars.map(([, y, , h]) => y + h))).toBeCloseTo(112, 1);
    const horizontal = geom("bar", series, {
      ...options,
      orientation: "horizontal",
    }).paths.flatMap((p) => rectangles(p.d));
    expect(Math.min(...horizontal.map(([x]) => x))).toBe(12);
    expect(Math.max(...horizontal.map(([x, , w]) => x + w))).toBeCloseTo(
      234,
      1,
    );
  });
  it("preserves the physical histogram bin edges, frequencies and overlay versus stack", () => {
    const first = group([
        [0, 1],
        [1, 2],
      ]),
      second = group([
        [0, 1],
        [1, 2],
      ]);
    first.histogramBins = second.histogramBins = [
      { lower: 0, upper: 1 },
      { lower: 1, upper: 4 },
    ];
    const options = { series: "g" };
    const overlay = geom("histogram", [first, second], options).paths;
    expect(overlay.every((p) => p.opacity === 0.55)).toBe(true);
    const [thin, wide] = rectangles(overlay[0].d);
    expect(wide[2] / thin[2]).toBeCloseTo(3, 1);
    expect(wide[3] / thin[3]).toBeCloseTo(2, 1);
    const stack = geom("histogram", [first, second], {
      ...options,
      stacked: true,
    }).paths;
    expect(stack.every((p) => p.opacity === 1)).toBe(true);
    const [, lower] = rectangles(stack[0].d),
      [, upper] = rectangles(stack[1].d);
    expect(upper[1] + upper[3]).toBeCloseTo(lower[1], 1);
  });
  it("preserves mixed marks and conditional colors; missing heatmap cells stay empty", () => {
    const a = group([
        ["a", 0],
        ["b", 10],
        ["c", 4],
      ]),
      b = group(
        [
          ["a", 4],
          ["b", null],
          ["c", 6],
        ],
        "other",
      ),
      c = group(
        [
          ["a", 1],
          ["b", 4],
          ["c", 2],
        ],
        "band",
      );
    a.pointStyles = [undefined, { color: "#ffa500" }];
    const { paths } = geom("composed", [a, b, c], {
      y: ["y", "other", "band"],
      metricStyles: { other: "line", band: "area" },
    });
    expect(paths.map((p) => p.mark)).toEqual(
      expect.arrayContaining(["bar", "area", "point", "line"]),
    );
    expect(paths.some((p) => p.color === "#ffa500" && p.mark === "bar")).toBe(
      true,
    );
    const heat = geom("heatmap", [a, b]).paths;
    expect(heat.flatMap((p) => rectangles(p.d))).toHaveLength(5);
    expect(new Set(heat.map((p) => p.opacity)).size).toBeGreaterThan(2);
  });
  it("resolves the last value of a repeated heatmap cell before aggregation", () => {
    const item = group([
      ["A", 6],
      ["B", 4],
      ["A", null],
    ]);
    const result = geom("heatmap", [item]).paths;
    expect(result.flatMap((p) => rectangles(p.d))).toHaveLength(1);
  });
  it.each([
    "bar",
    "line",
    "area",
    "composed",
    "histogram",
    "sparkline",
    "scatter",
    "heatmap",
  ] as const)("honors zero series opacity in %s", (kind) => {
    const item = group([
      [0, 1],
      [1, 4],
      [2, -3],
    ]);
    item.seriesStyle = { opacity: 0, borderColor: "#ffffff" };
    expect(geom(kind, [item]).paths).toEqual([]);
  });
  it("retains invisible stack contributions and the opacity and border of visible bars", () => {
    const base = group([["A", 3]]),
      tip = group([["A", 1]]);
    base.pointStyles = [{ opacity: 0 }];
    tip.seriesStyle = { opacity: 0.5, borderColor: "#009900", borderWidth: 1 };
    const { paths } = geom("bar", [base, tip], { stacked: true, series: "g" });
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({
      opacity: 0.5,
      border: "#009900",
      color: green,
    });
    const [box] = rectangles(paths[0].d);
    expect(box[1]).toBe(7);
    expect(box[3]).toBeCloseTo(105 / 4, 0);
  });
  it.each(["line", "area", "sparkline"] as const)(
    "uses incoming segment opacity for %s and never paints the hidden segment",
    (kind) => {
      const item = group([
        [0, 2],
        [1, 4],
        [2, 3],
        [3, 3],
      ]);
      item.seriesStyle = { opacity: 0.6 };
      item.pointStyles = [undefined, { opacity: 0 }];
      const { paths } = geom(kind, [item]);
      const strokes = paths.filter((p) => p.mark === "line");
      expect(strokes).toHaveLength(1);
      expect(strokes[0].opacity).toBe(0.6);
      expect(strokes[0].d.match(/L/g)).toHaveLength(2);
      expect(
        paths.filter((p) => p.mark === "area").every((p) => p.opacity === 0.6),
      ).toBe(true);
    },
  );
  it("builds bounded heatmap and scatter paths from dense source data", () => {
    const data = Array.from({ length: 5000 }, (_, i): [number, number] => [
      i,
      Math.sin(i / 5),
    ]);
    for (const kind of ["heatmap", "scatter"] as const) {
      const { paths } = geom(kind, [group(data)]);
      expect(paths.length).toBeLessThanOrEqual(6);
      expect(paths.flatMap((p) => rectangles(p.d)).length).toBeLessThanOrEqual(
        kind === "scatter" ? 24 * 12 : 48,
      );
    }
  });
});
