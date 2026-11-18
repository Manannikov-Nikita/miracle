import { area, curveBumpX, curveLinear, curveMonotoneX, line } from "d3-shape";
import { expect, it } from "vitest";
import { styledPathRuns } from "../src/client/board/chart-kit/styled-path";

const points = [2, 5, 3, 9, 1].map((value, x) => ({
  value,
  x,
  y0: [2, 0, 1, 3, 0][x],
  color: "#123456",
}));
const x = (p: (typeof points)[number]) => p.x;
const y = (p: (typeof points)[number]) => p.value;
const y0 = (p: (typeof points)[number]) => p.y0;

it.each([curveLinear, curveBumpX, curveMonotoneX])(
  "retains the same D3 upper and reversed lower interpolations across style changes",
  (curve) => {
    const strokes = styledPathRuns(points, curve, x, y, y0);
    expect(strokes).toHaveLength(1);
    const reference = area<(typeof points)[number]>()
      .x(x)
      .y1(y)
      .y0(y0)
      .curve(curve)(points);
    expect(strokes[0].fill).toBe(reference);
    const varied = points.map((p, i) => ({
      ...p,
      style: i === 1 || i === 2 ? { opacity: 0.5 } : undefined,
    }));
    const runs = styledPathRuns(varied, curve, x, y, y0);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.style?.opacity)).toEqual([0.5, undefined]);
    expect(runs[0].stroke + runs[1].stroke.replace(/^M[^MLCZ]+/, "")).toBe(
      strokes[0].stroke,
    );
    // The split closes both bands at the same x, on the original varying baseline.
    const boundary = runs[1].fill!.slice(runs[1].stroke.length).slice(1, -1);
    const previous = runs[0]
      .fill!.slice(runs[0].stroke.length)
      .replace(/^L[^MLCZ]+/, "")
      .slice(0, -1);
    expect(strokes[0].fill!.slice(strokes[0].stroke.length)).toBe(
      "L" + boundary + previous + "Z",
    );
  },
);

it("respects gaps, skipped duplicate points, and distinct measurements at the same x", () => {
  const data = [
    [0, 1],
    [0, 1],
    [1, 5],
    [1, 2],
    [2, 1],
    [3, null],
    [4, 2],
    [5, 1],
  ].map(([x, value]) => ({ x: x!, value, color: "#112233" }));
  const runs = styledPathRuns(
    data,
    curveMonotoneX,
    (p) => p.x,
    (p) => p.value!,
  );
  expect(runs).toHaveLength(2);
  const d = line<(typeof data)[number]>()
    .defined((p) => p.value !== null)
    .x((p) => p.x)
    .y((p) => p.value!)
    .curve(curveMonotoneX)(data);
  expect(runs.map((r) => r.stroke).join("")).toBe(d);
});
