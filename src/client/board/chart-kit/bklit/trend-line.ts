// Line-only adaptation of Bklit UI's sparkline-geometry.ts (MIT, © 2026 uixmat).
// Source: bklit/bklit-ui@76299da, packages/ui/src/charts/sparkline-geometry.ts.
import { curveMonotoneX, line } from "d3-shape";
import { unitPosition } from "../unit-position";

interface SparklinePoint {
  x: number;
  y: number;
}

export function trendLine(
  values: readonly (number | null)[],
  width: number,
  height: number,
) {
  const finite = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 0;
  const inset = 5;
  const innerWidth = Math.max(0, width - inset * 2);
  const innerHeight = Math.max(0, height - inset * 2);
  const points = values.map((value, index) => ({
    x:
      inset +
      innerWidth * (values.length > 1 ? index / (values.length - 1) : 0.5),
    y:
      value === null
        ? NaN
        : inset + innerHeight - unitPosition(value, low, high) * innerHeight,
  }));
  const path =
    line<SparklinePoint>()
      .defined((point) => Number.isFinite(point.y))
      .x((point) => point.x)
      .y((point) => point.y)
      .curve(curveMonotoneX)(points) ?? "";
  return { points, path };
}
