import type { cartesianGeometry } from "./cartesian-geometry";

export type Geometry = ReturnType<typeof cartesianGeometry>;
type Mark = Geometry["marks"][number];
type Point = Mark["points"][number];

export interface Sample {
  key: string;
  mark: Mark;
  point: Point;
  x: number;
  y: number;
  color: string;
}

export interface PlotFocus {
  category: number;
  sample: number;
}

export function focusColumns(g: Geometry) {
  const columns = g.categories.map((): Sample[] => []);
  // Tooltips and keyboard navigation follow the legend even when SVG layers paint in a different order.
  const seriesOrder = [...g.marks].sort(
    (a, b) => a.seriesIndex - b.seriesIndex,
  );
  for (const mark of seriesOrder) {
    const occurrences = new Map<number, number>();
    for (const point of mark.points) {
      const occurrence = occurrences.get(point.category) ?? 0;
      occurrences.set(point.category, occurrence + 1);
      const center = g.center(point.category);
      const at =
        mark.style === "bar" ? center + mark.offset + g.barWidth / 2 : center;
      const value = point.endPx;
      columns[point.category].push({
        key: `${occurrence}/${mark.key}`,
        mark,
        point,
        x: g.horizontal ? value : at,
        y: g.horizontal ? at : value,
        color: point.color ?? mark.color,
      });
    }
  }
  return columns;
}

function distanceToInterval(value: number, start: number, end: number) {
  return Math.max(
    Math.min(start, end) - value,
    value - Math.max(start, end),
    0,
  );
}

export function pointerFocus(
  g: Geometry,
  columns: Sample[][],
  x: number,
  y: number,
): PlotFocus | null {
  if (!columns.length || x < g.left || x > g.right || y < g.top || y > g.bottom)
    return null;
  const coordinate = g.horizontal ? y - g.top : x - g.left;
  const category = Math.min(
    columns.length - 1,
    Math.floor(coordinate / g.slot),
  );
  let sample = 0;
  let best = Infinity;
  columns[category].forEach((s, index) => {
    if (s.point.value === null) return;
    const endDistance = Math.hypot(x - s.x, y - s.y);
    // A line drawn over a column remains selectable at their intersection.
    let distance = endDistance < 7 ? endDistance / 8 : endDistance;
    if (s.mark.style === "bar") {
      const middle = g.horizontal ? s.y : s.x;
      const side = distanceToInterval(
        g.horizontal ? y : x,
        middle - g.barWidth / 2,
        middle + g.barWidth / 2,
      );
      const end = distanceToInterval(
        g.horizontal ? x : y,
        s.point.basePx,
        g.horizontal ? s.x : s.y,
      );
      distance = Math.hypot(side, end) + 1;
    } else if (g.stacked && s.mark.style === "area") {
      // Prefer the band under the pointer. Where different metrics overlap,
      // the distance to their cumulative line breaks the tie.
      distance =
        distanceToInterval(y, s.point.basePx, s.point.endPx) +
        Math.min(0.5, Math.abs(y - s.y) / Math.max(1, g.bottom - g.top));
    }
    if (distance < best) {
      best = distance;
      sample = index;
    }
  });
  return { category, sample };
}

export function keyboardFocus(
  key: string,
  g: Geometry,
  columns: Sample[][],
  previous: PlotFocus | null,
): PlotFocus | null {
  if (!columns.length || key === "Escape") return null;
  const current =
    previous && columns[previous.category]
      ? previous
      : { category: 0, sample: 0 };
  const items = columns[current.category];
  const crossAxis = g.horizontal
    ? ["ArrowLeft", "ArrowRight"]
    : ["ArrowUp", "ArrowDown"];
  const backwards = key === "ArrowLeft" || key === "ArrowUp";
  if (items.length > 1 && crossAxis.includes(key)) {
    return {
      category: current.category,
      sample:
        (current.sample + (backwards ? -1 : 1) + items.length) % items.length,
    };
  }
  const category =
    key === "Home"
      ? 0
      : key === "End"
        ? columns.length - 1
        : Math.max(
            0,
            Math.min(
              columns.length - 1,
              current.category + (backwards ? -1 : 1),
            ),
          );
  const seriesKey = items[current.sample]?.mark.key;
  const matching = columns[category].findIndex((s) => s.mark.key === seriesKey);
  const firstValue = columns[category].findIndex((s) => s.point.value !== null);
  return {
    category,
    sample: matching >= 0 ? matching : Math.max(0, firstValue),
  };
}

export function barRect(
  g: Geometry,
  start: number,
  end: number,
  base = g.zero,
) {
  const length = Math.abs(end - base);
  return {
    x: g.horizontal ? Math.min(base, end) : start,
    y: g.horizontal ? start : Math.min(base, end),
    width: g.horizontal ? length : g.barWidth,
    height: g.horizontal ? g.barWidth : length,
    rx: Math.min(4, g.barWidth / 3, length / 2),
  };
}
