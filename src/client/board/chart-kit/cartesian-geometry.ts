import { scaleLinear } from "d3-scale";
import { curveBumpX, curveMonotoneX } from "d3-shape";
import { linePathD, areaClosedD } from "./bklit/line-path";
import { computeSeriesBarWidth } from "./bklit/series-bar-layout";
import { splitSignedArea, type BandPoint } from "./stacked-area";
import { cartesianStacks } from "./cartesian-stacks";
import { formatChartNumber } from "../chart-number";
import {
  composedMetricStyle,
  supportsChartStacking,
} from "../../../shared/chart-appearance";
import type { ChartPlotProps } from "./plot-types";

/** Adapted from Bklit UI's series-bar-layout.ts. Allow subpixel bins on dense boards. */
export function seriesBarLayout(slot: number, count: number) {
  const gap = Math.min(4, (slot * 0.1) / count);
  const upstreamWidth = computeSeriesBarWidth({
    innerWidth: slot,
    columnWidth: slot,
    dataLength: 1,
    seriesCount: count,
    composedMaxBarSize: 38,
    composedBarGap: gap,
  });
  const width = Math.min(
    upstreamWidth,
    (slot * 0.92 - (count - 1) * gap) / count,
  );
  return { gap, width, groupWidth: count * width + (count - 1) * gap };
}

interface Point extends BandPoint {
  display?: string;
  color?: string;
  outer: boolean;
}

export function cartesianGeometry(
  { series, spec, colors }: Pick<ChartPlotProps, "series" | "spec" | "colors">,
  width: number,
  height: number,
) {
  const horizontal = spec.kind === "bar" && spec.orientation === "horizontal";
  const showX = spec.showXAxis !== false;
  const showY = spec.showYAxis !== false;
  const labels = new Map<string, string>();
  const categories = new Map<string, number>();
  const categoryLists = new Set(series.map((item) => item.xCategories));
  for (const list of categoryLists)
    for (const x of list ?? [])
      if (!categories.has(x)) categories.set(x, categories.size);
  // Normalize before summing: even two finite same-sign Float64 values can overflow.
  let magnitude = 0;
  for (const item of series)
    for (const [, value] of item.data)
      if (value !== null) magnitude = Math.max(magnitude, Math.abs(value));
  const unit =
    magnitude > 1e290 || (magnitude > 0 && magnitude < 1e-290) ? magnitude : 1;
  const stacked =
    supportsChartStacking(spec.kind) && Boolean(spec.stacked && spec.series);
  const stacks = stacked ? cartesianStacks(series, spec, unit) : undefined;
  let min = 0,
    max = 0;
  const marks = series.map((s, i) => {
    const style =
      spec.kind === "composed"
        ? composedMetricStyle(spec, s.metricId ?? spec.y[0])
        : spec.kind;
    const points: Point[] = s.data.map(([raw, value], index) => {
      const key = String(raw);
      if (!categories.has(key)) categories.set(key, categories.size);
      const display = s.displayData?.[index];
      labels.set(key, display?.x ?? s.categoryLabels?.[key] ?? key);
      const segment = stacks?.segments[i][index];
      const end = segment?.end ?? (value ?? 0) / unit;
      min = Math.min(min, end);
      max = Math.max(max, end);
      return {
        base: segment?.base ?? 0,
        oppositeBase: segment?.oppositeBase ?? 0,
        end,
        outer: segment?.outer ?? (value !== null && value !== 0),
        category: categories.get(key)!,
        value,
        display: display?.value,
        color: display?.color,
      };
    });
    if (style !== "bar") points.sort((a, b) => a.category - b.category);
    return {
      points,
      style,
      name: s.name,
      key: s.colorKey ?? String(i),
      seriesIndex: i,
      metricId: stacks?.metricIds[i] ?? s.metricId,
      color: colors[i],
    };
  });
  const outside =
    spec.showLabels &&
    !(
      spec.kind === "bar" &&
      (spec.labelPosition === "inside" ||
        (stacked && spec.labelPosition !== "outside"))
    );
  let before = 0;
  let after = 0;
  if (horizontal && outside) {
    for (const mark of marks) {
      for (const point of mark.points) {
        if (point.value === null) continue;
        const text =
          point.display ?? formatChartNumber(point.value, spec.numberFormat);
        const space = Math.min(width * 0.14, text.length * 7) + 6;
        if (point.value < 0) before = Math.max(before, space);
        else after = Math.max(after, space);
      }
    }
  }
  const totals = stacks?.totals ?? [];
  const hasTopTotal = totals.some((t) => t.value >= 0);
  const hasBottomTotal = totals.some((t) => t.value < 0);
  if (horizontal) {
    for (const t of totals) {
      const text = formatChartNumber(t.value, spec.numberFormat);
      const space = Math.min(width * 0.14, text.length * 7) + 6;
      if (t.value < 0) before = Math.max(before, space);
      else after = Math.max(after, space);
    }
  }
  const axisLeft = showY ? Math.min(horizontal ? 98 : 58, width * 0.24) : 8;
  const left = axisLeft + before;
  const right = Math.max(left + 1, width - 12 - after);
  const twoLabels = Boolean(outside && totals.length);
  const horizontalPadding = horizontal && twoLabels ? 12 : 0;
  const top =
    (spec.showLabels || (!horizontal && hasTopTotal) ? 20 : 10) +
    (!horizontal && outside && hasTopTotal ? 14 : horizontalPadding);
  const bottomGutter = horizontal
    ? horizontalPadding
    : (outside && min < 0 ? 14 : 0) + (hasBottomTotal ? 14 : 0);
  const bottom = Math.max(top + 1, height - (showX ? 32 : 10) - bottomGutter);
  const tickCount = Math.max(
    2,
    Math.min(
      7,
      Math.floor(
        (horizontal ? right - left : bottom - top) / (horizontal ? 66 : 45),
      ),
    ),
  );
  const axis = scaleLinear()
    .domain([min, max === min ? 1 : max])
    .nice(tickCount)
    .range(horizontal ? [left, right] : [bottom, top]);
  const scale = (value: number) => axis(value / unit);
  const ticks = [
    ...new Set(
      axis
        .ticks(tickCount)
        .map((t) => t * unit)
        .filter(Number.isFinite),
    ),
  ];
  const slot =
    Math.max(1, horizontal ? bottom - top : right - left) /
    Math.max(1, categories.size);
  const center = (index: number) =>
    (horizontal ? top : left) + slot * (index + 0.5);
  const styles = ["area", "bar", "line"];
  let barIndex = 0;
  const bars = seriesBarLayout(
    slot,
    Math.max(
      1,
      stacks?.laneByMetric.size ??
        marks.filter((m) => m.style === "bar").length,
    ),
  );
  const laneOffset = (lane: number) =>
    lane * (bars.width + bars.gap) - bars.groupWidth / 2;
  const zero = scale(0);
  const plotted = marks
    .map((m) => {
      const offset =
        m.style === "bar"
          ? laneOffset(
              stacks ? stacks.laneByMetric.get(m.metricId!)! : barIndex++,
            )
          : 0;
      const path = {
        x: (point: Point) => center(point.category),
        y: (point: Point) => axis(point.end),
        defined: (point: Point) => point.value !== null,
        // Shared interpolation keeps neighbouring bands flush, including at the ends of null runs.
        curve: stacked ? curveBumpX : curveMonotoneX,
      };
      const pathPoints =
        stacked && m.style === "area" ? splitSignedArea(m.points) : m.points;
      const stroke = m.style === "bar" ? "" : linePathD(pathPoints, path);
      const fill =
        m.style === "area"
          ? areaClosedD(pathPoints, {
              ...path,
              y0: (point) => axis(point.base),
            })
          : "";
      const points = m.points.map(({ base, end, ...point }) => ({
        ...point,
        basePx: axis(base),
        endPx: axis(end),
      }));
      return { ...m, points, stroke, fill, offset };
    })
    .sort((a, b) => styles.indexOf(a.style) - styles.indexOf(b.style));
  return {
    horizontal,
    stacked,
    stackTotals: totals.map((t) => {
      const category = categories.get(t.category)!;
      const cross =
        center(category) +
        laneOffset(stacks!.laneByMetric.get(t.metricId)!) +
        bars.width / 2;
      const end = axis(t.extent);
      return {
        metricId: t.metricId,
        category,
        value: t.value,
        x: horizontal ? end : cross,
        y: horizontal ? cross : end,
      };
    }),
    showX,
    showY,
    left,
    right,
    top,
    bottom,
    scale,
    ticks,
    axisLeft,
    bottomGutter,
    zero,
    slot,
    center,
    marks: plotted,
    barWidth: bars.width,
    categories: [...categories.keys()].map(
      (x) => labels.get(x) ?? series[0]?.categoryLabels?.[x] ?? x,
    ),
  };
}

export function truncateTick(text: string, pixels: number) {
  const limit = Math.max(2, Math.floor(pixels / 6.4));
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}
