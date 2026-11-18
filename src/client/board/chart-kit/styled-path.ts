import type { CurveFactory } from "d3-shape";
import type { ChartMarkStyle } from "../../../shared/types";

interface StyledPoint {
  value: number | null;
  style?: ChartMarkStyle;
  color: string;
}

interface StyledPathRun {
  stroke: string;
  fill?: string;
  style?: ChartMarkStyle;
  color: string;
}

function samePaint(a: StyledPoint, b: StyledPoint) {
  const left = a.style;
  const right = b.style;
  if (a.color === b.color && left === right) return true;
  return (
    (left?.color ?? a.color) === (right?.color ?? b.color) &&
    left?.opacity === right?.opacity &&
    left?.borderColor === right?.borderColor &&
    left?.borderWidth === right?.borderWidth &&
    left?.borderStyle === right?.borderStyle &&
    (left?.pattern ?? "none") === (right?.pattern ?? "none")
  );
}

const pair = (x: number, y: number) =>
  `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`;

/** Capture D3's original interpolating curve instead of recalculating tangents at style boundaries. */
function curveEdges<T>(
  points: readonly T[],
  curve: CurveFactory,
  x: (p: T) => number,
  y: (p: T) => number,
) {
  const edges = Array<string>(points.length).fill("");
  let index = 1;
  function append(endX: number, endY: number, command: string) {
    // MonotoneX can elide repeated coordinates. A skipped edge has zero length.
    while (
      index < points.length &&
      (x(points[index]) !== endX || y(points[index]) !== endY)
    )
      index++;
    if (index < points.length) edges[index++] = command;
  }
  const unsupported = () => {
    throw new Error("Unsupported chart curve");
  };
  const writer = {
    arc: unsupported,
    arcTo: unsupported,
    rect: unsupported,
    quadraticCurveTo: unsupported,
    moveTo() {},
    closePath() {},
    lineTo(a: number, b: number) {
      append(a, b, `L${pair(a, b)}`);
    },
    bezierCurveTo(
      ax: number,
      ay: number,
      bx: number,
      by: number,
      ex: number,
      ey: number,
    ) {
      append(ex, ey, `C${pair(ax, ay)},${pair(bx, by)},${pair(ex, ey)}`);
    },
  };
  // Linear, MonotoneX and BumpX use just these four CanvasPath operations.
  const draw = curve(writer);
  draw.lineStart();
  for (const point of points) draw.point(x(point), y(point));
  draw.lineEnd();
  return edges;
}

/** An observation styles its incoming edge. Nulls split both the stroke and the area. */
export function styledPathRuns<T extends StyledPoint>(
  points: readonly T[],
  curve: CurveFactory,
  x: (p: T) => number,
  y: (p: T) => number,
  y0?: (p: T) => number,
): StyledPathRun[] {
  const runs: StyledPathRun[] = [];
  let first = 0;
  while (first < points.length) {
    let next = first;
    while (next < points.length && points[next].value !== null) next++;
    if (next - first >= 2) {
      const block = points.slice(first, next);
      const length = block.length;
      const top = curveEdges(block, curve, x, y);
      // D3 traces a closed area's lower boundary in reverse order.
      const bottom = y0
        ? curveEdges([...block].reverse(), curve, x, y0)
        : undefined;
      for (let start = 1; start < length;) {
        let end = start;
        while (end + 1 < length && samePaint(block[start], block[end + 1]))
          end++;
        const upper = top.slice(start, end + 1).join("");
        const lower = bottom?.slice(length - end, length - start + 1).join("");
        if (upper || lower) {
          const stroke =
            "M" + pair(x(block[start - 1]), y(block[start - 1])) + upper;
          const fill = y0
            ? stroke + "L" + pair(x(block[end]), y0(block[end])) + lower + "Z"
            : undefined;
          runs.push({
            stroke,
            fill,
            style: block[start].style,
            color: block[start].color,
          });
        }
        start = end + 1;
      }
    }
    first = next + 1;
  }
  return runs;
}
