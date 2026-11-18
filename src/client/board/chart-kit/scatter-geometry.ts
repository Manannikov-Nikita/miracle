import { scaleLinear } from "d3-scale";
import type { ChartPlotProps } from "./plot-types";
import { formatChartNumber } from "../chart-number";
import type { ChartSpec } from "../../../shared/types";

// Adapted from Bklit UI's scatter-svg.ts and use-scatter-chart-interaction.ts
// (MIT, bklit/bklit-ui@76299da). Miracle plots numeric X as well as numeric Y.
export function scatterLocalPoint(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  width: number,
  height: number,
) {
  const matrix = svg.getScreenCTM?.();
  if (
    matrix &&
    svg.createSVGPoint &&
    matrix.a * matrix.d !== matrix.b * matrix.c
  ) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(matrix.inverse());
  }
  const rect = svg.getBoundingClientRect();
  return rect.width && rect.height
    ? {
        x: ((clientX - rect.left) * width) / rect.width,
        y: ((clientY - rect.top) * height) / rect.height,
      }
    : null;
}

function numericAxis(
  min: number,
  max: number,
  pixels: [number, number],
  count: number,
) {
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  // Normalize only extremes to avoid overflow in D3's ticks and subtraction.
  const unit =
    magnitude > 1e290 || (magnitude > 0 && magnitude < 1e-290) ? magnitude : 1;
  const axis = scaleLinear()
    .domain(magnitude ? [min / unit, max / unit] : [-1, 1])
    .nice(count)
    .range(pixels);
  const ticks = [
    ...new Set(
      axis
        .ticks(count)
        .map((t) => t * unit)
        .filter(Number.isFinite),
    ),
  ];
  return { at: (value: number) => axis(value / unit), ticks };
}

export function scatterTick(value: number, format: ChartSpec["numberFormat"]) {
  if (
    (!format || format === "auto") &&
    value !== 0 &&
    (Math.abs(value) < 1e-6 || Math.abs(value) >= 1e12)
  ) {
    return value.toExponential(1).replace(".0e", "e").replace("e+", "e");
  }
  return formatChartNumber(value, format);
}

export type ScatterDatum = {
  key: string;
  x: number;
  y: number;
  cx: number;
  cy: number;
  color: string;
  series: number;
  index: number;
};
export const scatterRadius = 5;
const hitRadius = 14;
const tile = (value: number) => Math.floor(value / hitRadius);
const tileKey = (col: number, row: number) => `${col},${row}`;

export function scatterGeometry(
  { spec, series, colors }: Pick<ChartPlotProps, "spec" | "series" | "colors">,
  width: number,
  height: number,
) {
  const showX = spec.showXAxis !== false,
    showY = spec.showYAxis !== false;
  const left = showY ? Math.min(70, width * 0.25) : 8;
  const right = Math.max(left + 1, width - (showX ? 19 : 8));
  const top = spec.showLabels ? 21 : 10;
  const bottom = Math.max(top + 1, height - (showX ? 32 : 10));
  let xmin = 0,
    xmax = 0,
    ymin = 0,
    ymax = 0;
  const points: ScatterDatum[] = [];
  for (const [s, item] of series.entries()) {
    for (const [i, [x, y]] of item.data.entries()) {
      if (
        typeof x !== "number" ||
        y === null ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      )
        continue;
      xmin = Math.min(xmin, x);
      xmax = Math.max(xmax, x);
      ymin = Math.min(ymin, y);
      ymax = Math.max(ymax, y);
      points.push({
        key: `${item.colorKey ?? s}:${i}`,
        x,
        y,
        cx: 0,
        cy: 0,
        color: item.displayData?.[i]?.color ?? colors[s],
        series: s,
        index: i,
      });
    }
  }
  const xAxis = numericAxis(
    xmin,
    xmax,
    [left, right],
    Math.max(2, Math.min(8, Math.floor((right - left) / 75))),
  );
  const yAxis = numericAxis(
    ymin,
    ymax,
    [bottom, top],
    Math.max(2, Math.min(7, Math.floor((bottom - top) / 36))),
  );
  const index = new Map<string, ScatterDatum>();
  const tiles = new Map<string, ScatterDatum[]>();
  const bands = Array.from({ length: 12 }, (): ScatterDatum[] => []);
  for (const point of points) {
    point.cx = xAxis.at(point.x);
    point.cy = yAxis.at(point.y);
    index.set(point.key, point);
    const key = tileKey(tile(point.cx), tile(point.cy));
    const cell = tiles.get(key);
    if (cell) cell.push(point);
    else tiles.set(key, [point]);
    const band = Math.max(
      0,
      Math.min(
        bands.length - 1,
        Math.floor(((point.cx - left) / (right - left)) * bands.length),
      ),
    );
    bands[band].push(point);
  }
  const order = [...points].sort(
    (a, b) =>
      a.x - b.x || a.y - b.y || a.series - b.series || a.index - b.index,
  );
  const ranks = new Map(order.map((p, i) => [p.key, i]));
  function hit(x: number, y: number) {
    if (
      x < left - hitRadius ||
      x > right + hitRadius ||
      y < top - hitRadius ||
      y > bottom + hitRadius
    )
      return null;
    let nearest: ScatterDatum | null = null,
      best = hitRadius * hitRadius;
    const col = tile(x),
      row = tile(y);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const items = tiles.get(tileKey(col + dx, row + dy));
        if (!items) continue;
        for (const p of items) {
          const dist = (p.cx - x) ** 2 + (p.cy - y) ** 2;
          if (dist <= best) {
            best = dist;
            nearest = p;
          }
        }
      }
    return nearest;
  }
  return {
    points,
    bands,
    index,
    order,
    ranks,
    hit,
    xAxis,
    yAxis,
    left,
    right,
    top,
    bottom,
    showX,
    showY,
  };
}
