import {
  composedMetricStyle,
  supportsChartStacking,
} from "../../../shared/chart-appearance";
import type { ChartMarkStyle, ChartMetricStyle } from "../../../shared/types";
import type { ChartSeriesItem } from "../model";
import type { ChartPlotProps } from "./plot-types";
import { pointAppearance } from "./point-appearance";
import { splitSignedArea, type BandPoint } from "./stacked-area";
import { unitPosition } from "./unit-position";

type Input = Pick<ChartPlotProps, "series" | "colors" | "spec">;
type Mark = ChartMetricStyle | "point" | "cell" | "density";
type Path = {
  mark: Mark;
  color: string;
  opacity: number;
  d: string;
  border?: string;
};
function borderColor(style: ChartMarkStyle | undefined, color: string) {
  return style &&
    style.borderWidth !== 0 &&
    (style.borderColor || style.borderWidth || style.borderStyle)
    ? (style.borderColor ?? color)
    : undefined;
}
const left = 12,
  top = 7,
  right = 234,
  bottom = 112;
const width = right - left,
  height = bottom - top;
const seriesBudget = 12;
const round = (n: number) => Math.round(n * 10) / 10;
const xy = (x: number, y: number) => `${round(x)},${round(y)}`;
function rect(x: number, y: number, w: number, h: number) {
  const roundedWidth = round(round(x + w) - round(x));
  return `M${xy(x, y)}h${roundedWidth}v${round(round(y + h) - round(y))}h${-roundedWidth}Z`;
}

// A path contains all the independent marks sharing a paint. Limit novel conditional
// colors as well, since a source table can assign a different color to every cell.
function pathBatch(seriesColors: string[]) {
  const paints = new Set<string>();
  for (const color of seriesColors) {
    paints.add(color);
    if (paints.size === 32) break;
  }
  const paths = new Map<string, Path>();
  function add(
    mark: Mark,
    color: string,
    opacity: number,
    d: string,
    fallback = color,
    border?: string,
  ) {
    if (!d || opacity <= 0) return;
    if (paints.size >= 32 && !paints.has(color)) color = fallback;
    if (paints.size >= 32 && !paints.has(color))
      color = paints.values().next().value!;
    paints.add(color);
    const key = `${mark}:${color}:${opacity}:${border ?? ""}`;
    const existing = paths.get(key);
    if (existing) existing.d += d;
    else paths.set(key, { mark, color, opacity, d, border });
  }
  return { add, paths };
}
type Batch = ReturnType<typeof pathBatch>;

function categoryIndex(series: ChartSeriesItem[]) {
  const order = new Map<string, number>();
  function add(name: string) {
    if (!order.has(name)) order.set(name, order.size);
  }
  for (const list of new Set(series.map((s) => s.xCategories)))
    for (const x of list ?? []) add(x);
  for (const item of series) for (const [x] of item.data) add(String(x));
  return order;
}

// Bucket boundaries, extrema and a gap survive simplification. A spike in a
// long, otherwise flat series must still reach its original height in the overview.
function sampleColumns(
  low: Float64Array,
  high: Float64Array,
  gaps: Uint8Array,
) {
  const n = low.length;
  if (n <= 72) return Array.from({ length: n }, (_, i) => i);
  const keep = new Set<number>([0, n - 1]);
  for (let b = 0; b < 18; b++) {
    const start = Math.floor((b * n) / 18),
      end = Math.floor(((b + 1) * n) / 18);
    let min = start,
      max = start,
      gap = -1;
    for (let i = start; i < end; i++) {
      if (low[i] < low[min]) min = i;
      if (high[i] > high[max]) max = i;
      if (gap < 0 && gaps[i]) gap = i;
    }
    keep.add(start);
    if (Number.isFinite(low[min])) keep.add(min);
    if (Number.isFinite(high[max])) keep.add(max);
    if (gap >= 0) keep.add(gap);
  }
  return [...keep].sort((a, b) => a - b);
}

function scatter({ series, colors }: Input, batch: Batch) {
  let xmin = 0,
    xmax = 0,
    ymin = 0,
    ymax = 0;
  for (const s of series)
    for (const [x, y] of s.data)
      if (
        typeof x === "number" &&
        Number.isFinite(x) &&
        y !== null &&
        Number.isFinite(y)
      ) {
        xmin = Math.min(xmin, x);
        xmax = Math.max(xmax, x);
        ymin = Math.min(ymin, y);
        ymax = Math.max(ymax, y);
      }
  const cols = 24,
    rows = 12,
    dx = width / cols,
    dy = height / rows;
  const cells = new Map<
    number,
    { count: number; weight: number; colors: Map<string, number> }
  >();
  let peak = 1;
  for (const [j, item] of series.entries()) {
    item.data.forEach(([x, y], i) => {
      if (
        typeof x !== "number" ||
        !Number.isFinite(x) ||
        y === null ||
        !Number.isFinite(y)
      )
        return;
      const col = Math.min(
        cols - 1,
        Math.floor(unitPosition(x, xmin, xmax) * cols),
      );
      const row = Math.min(
        rows - 1,
        Math.floor((1 - unitPosition(y, ymin, ymax)) * rows),
      );
      const key = row * cols + col;
      const cell = cells.get(key) ?? {
        count: 0,
        weight: 0,
        colors: new Map<string, number>(),
      };
      const { color, style } = pointAppearance(item, i, colors[j]);
      const alpha = style?.opacity ?? 1;
      if (!alpha) return;
      cell.weight += alpha;
      cell.colors.set(color, (cell.colors.get(color) ?? 0) + alpha);
      peak = Math.max(peak, ++cell.count);
      cells.set(key, cell);
    });
  }
  for (const [key, cell] of cells) {
    const x = left + (key % cols) * dx,
      y = top + Math.floor(key / cols) * dy;
    const opacity =
      ((0.2 + 0.16 * Math.round(5 * Math.sqrt(cell.count / peak))) *
        cell.weight) /
      cell.count;
    // Split mixed tiles proportionally between their two principal series.
    // This keeps identifiable series colors without masking points plotted first.
    let main = "",
      second = "",
      firstCount = 0,
      secondCount = 0;
    for (const [color, n] of cell.colors) {
      if (n > firstCount) {
        second = main;
        secondCount = firstCount;
        main = color;
        firstCount = n;
      } else if (n > secondCount) {
        second = color;
        secondCount = n;
      }
    }
    const firstWidth = (dx * firstCount) / (firstCount + secondCount);
    batch.add("density", main, opacity, rect(x, y, firstWidth, dy));
    if (secondCount)
      batch.add(
        "density",
        second,
        opacity,
        rect(x + firstWidth, y, dx - firstWidth, dy),
      );
  }
}

function heatmap({ series, colors }: Input, batch: Batch) {
  const order = categoryIndex(series);
  const cols = Math.min(48, order.size),
    rows = Math.min(12, series.length);
  if (!cols || !rows) return;
  let min = Infinity,
    max = -Infinity;
  for (const item of series)
    for (const [, v] of item.data)
      if (v !== null && Number.isFinite(v)) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
  const cells = new Map<
    number,
    {
      sum: number;
      count: number;
      color: string;
      base: string;
      alpha: number;
      border?: string;
    }
  >();
  series.forEach((item, j) => {
    const row = Math.floor((j * rows) / series.length);
    // Resolve physical cells before merging adjacent screen pixels. Like the
    // full matrix, the final observation (including NULL) owns a repeated key.
    const last = new Map<string, number>();
    item.data.forEach(([x], i) => last.set(String(x), i));
    for (const [x, i] of last) {
      const v = item.data[i][1];
      if (v === null || !Number.isFinite(v)) continue;
      const col = Math.floor((order.get(x)! * cols) / order.size),
        key = row * cols + col;
      const amount = min === max ? 0.75 : unitPosition(v, min, max);
      const { color, style } = pointAppearance(item, i, colors[j]);
      const alpha = style?.opacity ?? 1;
      const cell = cells.get(key);
      if (cell) {
        if (!cell.alpha && alpha) {
          cell.color = color;
          cell.border = borderColor(style, color);
        }
        cell.sum += amount * alpha;
        cell.alpha += alpha;
        cell.count++;
      } else
        cells.set(key, {
          sum: amount * alpha,
          count: 1,
          color,
          base: colors[j],
          alpha,
          border: borderColor(style, color),
        });
    }
  });
  const sx = width / cols,
    sy = height / rows;
  const step = Math.max(4, Math.min(sx, sy)),
    dx = Math.min(sx, step),
    dy = Math.min(sy, step);
  const x0 = left + (width - cols * dx) / 2,
    y0 = top + (height - rows * dy) / 2,
    gap = Math.min(1, dx / 8, dy / 8);
  for (const [key, c] of cells) {
    if (!c.alpha) continue;
    const opacity =
      ((0.2 + Math.round((5 * c.sum) / c.alpha) * 0.16) * c.alpha) / c.count;
    batch.add(
      "cell",
      c.color,
      opacity,
      rect(
        x0 + (key % cols) * dx + gap / 2,
        y0 + Math.floor(key / cols) * dy + gap / 2,
        dx - gap,
        dy - gap,
      ),
      c.base,
      c.border,
    );
  }
}

type Point = BandPoint & {
  color: string;
  style?: ChartMarkStyle;
  gapBefore?: boolean;
};
function drawTrend(
  batch: Batch,
  points: Point[],
  mark: "line" | "area",
  color: string,
  atX: (i: number) => number,
  atY: (v: number) => number,
  stacked: boolean,
) {
  const data =
    stacked && mark === "area"
      ? splitSignedArea(
          points.flatMap((point) =>
            point.gapBefore ? [{ ...point, value: null }, point] : [point],
          ),
        )
      : points;
  let run: Point[] = [],
    previous: Point | undefined,
    ink: Point | undefined;
  function flush() {
    if (ink && run.length > 1) {
      const top = run.map((p) => xy(atX(p.category), atY(p.end))).join("L"),
        style = ink.style;
      if (mark === "area") {
        const bottom = run
          .slice()
          .reverse()
          .map((p) => xy(atX(p.category), atY(p.base)))
          .join("L");
        batch.add(
          "area",
          ink.color,
          style?.opacity ?? (stacked ? 0.65 : 0.35),
          `M${top}L${bottom}Z`,
          color,
        );
      }
      batch.add(
        "line",
        ink.color,
        style?.opacity ?? 1,
        "M" + top,
        color,
        borderColor(style, ink.color),
      );
    } else if (previous)
      batch.add(
        "point",
        previous.color,
        previous.style?.opacity ?? 1,
        `M${xy(atX(previous.category), atY(previous.end))}h0.1`,
        color,
        borderColor(previous.style, previous.color),
      );
    run = [];
    ink = undefined;
  }
  for (const p of data) {
    if (p.value === null || p.gapBefore) {
      flush();
      previous = undefined;
      if (p.value === null) continue;
    }
    if (previous) {
      if (
        ink &&
        (ink.color !== p.color ||
          ink.style?.opacity !== p.style?.opacity ||
          borderColor(ink.style, ink.color) !== borderColor(p.style, p.color))
      )
        flush();
      if (!run.length) {
        run.push(previous);
        ink = p;
      }
      run.push(p);
    }
    previous = p;
  }
  flush();
}

function sparkline({ series, colors }: Input, batch: Batch) {
  const rows = Math.min(series.length, seriesBudget);
  for (let row = 0; row < rows; row++) {
    const j =
      rows === 1 ? 0 : Math.round((row * (series.length - 1)) / (rows - 1));
    const item = series[j],
      n = item.data.length;
    const low = new Float64Array(n),
      high = new Float64Array(n),
      gap = new Uint8Array(n);
    let min = Infinity,
      max = -Infinity;
    item.data.forEach(([, v], i) => {
      if (v === null || !Number.isFinite(v)) {
        gap[i] = 1;
        low[i] = Infinity;
        high[i] = -Infinity;
      } else {
        low[i] = high[i] = v;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    });
    const points: Point[] = [];
    let last = -1;
    for (const idx of sampleColumns(low, high, gap)) {
      let gapBefore = false;
      for (let k = last + 1; k < idx; k++)
        if (gap[k]) {
          gapBefore = true;
          break;
        }
      const value = gap[idx] ? null : low[idx];
      points.push({
        category: idx,
        style: item.pointStyles?.[idx] ?? item.seriesStyle,
        value,
        base: 0,
        end: value ?? 0,
        oppositeBase: 0,
        color:
          item.seriesStyle || item.pointStyles
            ? pointAppearance(item, idx, colors[j]).color
            : colors[j],
        gapBefore,
      });
      last = idx;
    }
    const rowHeight = height / rows;
    drawTrend(
      batch,
      points,
      "line",
      colors[j],
      (i) => left + width * (n > 1 ? i / (n - 1) : 0.5),
      (v) => top + rowHeight * (row + 0.87 - 0.74 * unitPosition(v, min, max)),
      false,
    );
  }
}

function cartesian({ series, colors, spec }: Input, batch: Batch) {
  const histogram = spec.kind === "histogram",
    horizontal = spec.kind === "bar" && spec.orientation === "horizontal";
  const stacked = Boolean(
    spec.stacked &&
    spec.series &&
    (histogram || supportsChartStacking(spec.kind)),
  );
  const order = categoryIndex(series),
    n = order.size;
  if (!n) return undefined;
  const low = new Float64Array(n).fill(Infinity),
    high = new Float64Array(n).fill(-Infinity),
    gaps = new Uint8Array(n);
  let magnitude = 0;
  for (const s of series)
    for (const [, v] of s.data)
      if (v !== null && Number.isFinite(v))
        magnitude = Math.max(magnitude, Math.abs(v));
  const unit = magnitude || 1;
  const byMetric = new Map<string, number[]>();
  series.forEach((s, j) => {
    const metric = s.metricId ?? (spec.y.length === 1 ? spec.y[0] : s.name);
    const group = byMetric.get(metric);
    if (group) group.push(j);
    else byMetric.set(metric, [j]);
  });
  let min = 0,
    max = 0;
  for (const members of byMetric.values()) {
    // Exact extrema are inexpensive to obtain in one linear pass, including a
    // peak formed by many small contributions rather than one large sample.
    const totals = new Map<number, [number, number]>();
    for (const j of members)
      for (const [x, v] of series[j].data) {
        const c = order.get(String(x))!;
        if (v === null || !Number.isFinite(v)) {
          gaps[c] = 1;
          continue;
        }
        let end = v / unit;
        if (stacked) {
          const pair = totals.get(c) ?? [0, 0];
          const sign = v < 0 ? 0 : 1;
          end = pair[sign] += end;
          totals.set(c, pair);
        }
        low[c] = Math.min(low[c], end);
        high[c] = Math.max(high[c], end);
        min = Math.min(min, end);
        max = Math.max(max, end);
      }
  }
  const columns = histogram
    ? Array.from({ length: n }, (_, i) => i)
    : sampleColumns(low, high, gaps);
  const next = new Int32Array(n);
  for (let c = 0, k = 0; c < n; c++) {
    while (k + 1 < columns.length && columns[k] < c) k++;
    next[c] = k;
  }
  const axis = (v: number) => unitPosition(v, min, max === min ? 1 : max);
  const scale = (v: number) =>
    horizontal ? left + width * axis(v) : bottom - height * axis(v);
  const center = (c: number) =>
    (horizontal ? top : left) + ((horizontal ? height : width) * (c + 0.5)) / n;
  const bins = series[0]?.histogramBins;
  const first = bins?.[0]?.lower,
    final = bins?.at(-1)?.upper;
  const histX = (v: number) => left + width * unitPosition(v, first!, final!);
  const groups: {
    metric: string;
    mark: ChartMetricStyle;
    members: number[];
    lane: number;
  }[] = [];
  const perMetric = Math.max(1, Math.floor(seriesBudget / byMetric.size));
  let lanes = 0;
  for (const [metric, indices] of byMetric) {
    const mark = histogram
      ? "bar"
      : spec.kind === "composed"
        ? composedMetricStyle(spec, metric)
        : (spec.kind as ChartMetricStyle);
    const count = Math.min(perMetric, indices.length);
    const metricLane = lanes;
    for (let p = 0; p < count; p++) {
      const members = indices.slice(
        Math.floor((p * indices.length) / count),
        Math.floor(((p + 1) * indices.length) / count),
      );
      groups.push({
        metric,
        mark,
        members,
        lane: stacked ? metricLane : lanes,
      });
      if (mark === "bar" && !stacked && !histogram) lanes++;
    }
    if (mark === "bar" && stacked && !histogram) lanes++;
  }
  const accumulators = new Map<string, [number[], number[]]>();
  for (const { metric, mark, members, lane } of groups) {
    const grouped = members.length > 1;
    // At very high breakdown cardinality sample actual line series. Stacked
    // series and columns instead combine their contributions in each pixel band.
    const selected =
      grouped && !stacked && mark !== "bar"
        ? [
            members.reduce((best, j) =>
              series[j].data.length > series[best].data.length ? j : best,
            ),
          ]
        : members;
    const index = selected[0],
      color = series[index].seriesStyle?.color ?? colors[index];
    const pos = new Map<number, Point>(),
      neg = new Map<number, Point>(),
      breaks = new Set<number>();
    const combine = selected.length > 1;
    const duplicateRange = new Map<number, [number, number]>();
    for (const j of selected) {
      const item = series[j];
      item.data.forEach(([x, v], i) => {
        const c = order.get(String(x))!,
          k = next[c];
        if (v === null || !Number.isFinite(v)) {
          if (!combine) breaks.add(k);
          return;
        }
        if (columns[k] !== c) return;
        const target = (combine || mark === "bar") && v < 0 ? neg : pos;
        const normalized = v / unit,
          existing = target.get(k);
        const style = item.pointStyles?.[i] ?? item.seriesStyle;
        const pointColor =
          mark === "bar" || item.seriesStyle || item.pointStyles
            ? pointAppearance(item, i, colors[j]).color
            : colors[j];
        if (
          existing &&
          !combine &&
          !stacked &&
          !item.pointStyles &&
          mark !== "bar"
        ) {
          // Repeated categories can form a vertical run even in a single series.
          const range = duplicateRange.get(c) ?? [existing.end, existing.end];
          range[0] = Math.min(range[0], normalized);
          range[1] = Math.max(range[1], normalized);
          duplicateRange.set(c, range);
        }
        if (!stacked && mark === "bar" && style?.opacity === 0) return;
        if (existing && (combine || mark === "bar")) {
          if (stacked) {
            const total = existing.end + normalized;
            if (
              total &&
              (existing.style?.opacity !== undefined ||
                style?.opacity !== undefined)
            ) {
              const opacity =
                (existing.end * (existing.style?.opacity ?? 1) +
                  normalized * (style?.opacity ?? 1)) /
                total;
              if (existing.style?.opacity === 0 && opacity > 0)
                existing.color = pointColor;
              existing.style = { ...existing.style, opacity };
            }
            existing.end = total;
          } else if (Math.abs(normalized) > Math.abs(existing.end)) {
            existing.end = normalized;
            existing.color = pointColor;
            existing.style = style;
          }
          existing.value = existing.end;
        } else {
          target.set(k, {
            category: c,
            style,
            value: normalized,
            end: normalized,
            base: 0,
            oppositeBase: 0,
            color: combine && stacked ? color : pointColor,
          });
        }
      });
    }
    const stack = accumulators.get(metric) ?? [
      Array(columns.length).fill(0),
      Array(columns.length).fill(0),
    ];
    if (stacked) accumulators.set(metric, stack);
    for (const values of [pos, neg]) {
      if (!values.size) continue;
      const points: Point[] = [];
      let afterGap = false;
      for (let k = 0; k < columns.length; k++) {
        const p = values.get(k),
          c = columns[k];
        if (!p) {
          if (breaks.has(k) || stacked) afterGap = true;
          continue;
        }
        p.gapBefore = afterGap || breaks.has(k);
        afterGap = false;
        if (stacked) {
          const side = p.end < 0 ? 0 : 1;
          p.oppositeBase = stack[1 - side][k];
          p.base = stack[side][k];
          p.end = stack[side][k] += p.end;
        }
        if (mark !== "bar") {
          points.push(p);
          continue;
        }
        if (p.end === p.base) continue;
        const prev = c - (columns[k - 1] ?? -1),
          after = (columns[k + 1] ?? n) - c;
        const slot =
          (Math.min(prev, after) * (horizontal ? height : width)) / n;
        let size = (0.82 * slot) / Math.max(1, lanes);
        let start = center(c) - 0.41 * slot + lane * size;
        if (
          histogram &&
          bins?.[c] &&
          first !== undefined &&
          final !== undefined
        ) {
          const bin = bins[c];
          start = first === final ? left + width * 0.32 : histX(bin.lower);
          size = first === final ? width * 0.36 : histX(bin.upper) - start;
        }
        const x = Math.min(scale(p.end), scale(p.base)),
          extent = Math.abs(scale(p.end) - scale(p.base));
        const d = horizontal
          ? rect(x, start, extent, size * 0.95)
          : rect(start, x, size * (histogram ? 0.99 : 0.95), extent);
        batch.add(
          "bar",
          p.color,
          p.style?.opacity ?? (histogram && spec.series && !stacked ? 0.55 : 1),
          d,
          color,
          borderColor(p.style, p.color),
        );
      }
      if (mark !== "bar")
        drawTrend(batch, points, mark, color, center, scale, stacked);
    }
    for (const [category, [lo, hi]] of duplicateRange) {
      if (lo !== hi)
        batch.add(
          "line",
          color,
          series[index].seriesStyle?.opacity ?? 1,
          `M${xy(center(category), scale(lo))}V${round(scale(hi))}`,
        );
    }
  }
  return scale(0);
}

/** Work is linear in the chart model's capped input. SVG work is bounded by
 * the display grid, paint palette, and number of visible metric bands. */
export function thumbnailGeometry(input: Input) {
  const batch = pathBatch(input.colors);
  let zero: number | undefined;
  switch (input.spec.kind) {
    case "scatter":
      scatter(input, batch);
      break;
    case "heatmap":
      heatmap(input, batch);
      break;
    case "sparkline":
      sparkline(input, batch);
      break;
    default:
      zero = cartesian(input, batch);
  }
  const order: Record<Mark, number> = {
    area: 0,
    bar: 1,
    cell: 1,
    density: 1,
    line: 2,
    point: 3,
  };
  const paths = [...batch.paths.values()].sort(
    (a, b) => order[a.mark] - order[b.mark],
  );
  const horizontal =
    input.spec.kind === "bar" && input.spec.orientation === "horizontal";
  const axes = input.spec.kind !== "heatmap" && input.spec.kind !== "sparkline";
  const guides =
    input.spec.showGrid !== false && axes
      ? [0.25, 0.5, 0.75]
          .map((f) =>
            horizontal
              ? `M${xy(left + width * f, top)}V${bottom}`
              : `M${xy(left, top + height * f)}H${right}`,
          )
          .join("")
      : "";
  const baseline = axes
    ? [
        input.spec.showYAxis !== false
          ? `M${xy(horizontal ? (zero ?? left) : left, top)}V${bottom}`
          : "",
        input.spec.showXAxis !== false
          ? `M${xy(left, horizontal ? bottom : (zero ?? bottom))}H${right}`
          : "",
      ].join("")
    : "";
  return { paths, guides, baseline };
}
