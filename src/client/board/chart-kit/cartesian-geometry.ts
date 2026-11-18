import { scaleLinear } from "d3-scale";
import { curveMonotoneX } from "d3-shape";
import { linePathD, areaClosedD } from "./bklit/line-path";
import { computeSeriesBarWidth } from "./bklit/series-bar-layout";
import { formatChartNumber } from "../chartOptions";
import { composedMetricStyle } from "../../../shared/chart-appearance";
import type { ChartPlotProps } from "./plot-types";

/** Adapted from Bklit UI's series-bar-layout.ts. Allow subpixel bins on dense boards. */
function seriesBarLayout(slot: number, count: number) {
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

interface Point {
  category: number;
  value: number | null;
  display?: string;
  color?: string;
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
  for (const x of series[0]?.xCategories ?? [])
    categories.set(x, categories.size);
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
      if (value !== null) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return {
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
      color: colors[i],
    };
  });
  const outside =
    spec.showLabels &&
    !(spec.kind === "bar" && spec.labelPosition === "inside");
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
  const axisLeft = showY ? Math.min(horizontal ? 98 : 58, width * 0.24) : 8;
  const left = axisLeft + before;
  const right = Math.max(left + 1, width - 12 - after);
  const top = spec.showLabels ? 20 : 10;
  const bottomGutter = !horizontal && outside && min < 0 ? 14 : 0;
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
  // D3 computes tick steps from the span. Normalize extreme finite Float64s
  // before subtracting or rounding so that both coordinates and ticks stay finite.
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  const unit =
    magnitude > 1e290 || (magnitude > 0 && magnitude < 1e-290) ? magnitude : 1;
  const axis = scaleLinear()
    .domain([min / unit, max === min ? 1 : max / unit])
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
    Math.max(1, marks.filter((m) => m.style === "bar").length),
  );
  const zero = scale(0);
  const plotted = marks
    .map((m) => {
      const offset =
        m.style === "bar"
          ? barIndex++ * (bars.width + bars.gap) - bars.groupWidth / 2
          : 0;
      const path = {
        x: (point: Point) => center(point.category),
        y: (point: Point) => scale(point.value!),
        defined: (point: Point) => point.value !== null,
        curve: curveMonotoneX,
      };
      const stroke = m.style === "bar" ? "" : linePathD(m.points, path);
      const fill =
        m.style === "area" ? areaClosedD(m.points, { ...path, y0: zero }) : "";
      return { ...m, stroke, fill, offset };
    })
    .sort((a, b) => styles.indexOf(a.style) - styles.indexOf(b.style));
  return {
    horizontal,
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
    categories: [...categories.keys()].map((x) => labels.get(x) ?? x),
  };
}

export function truncateTick(text: string, pixels: number) {
  const limit = Math.max(2, Math.floor(pixels / 6.4));
  return text.length <= limit ? text : text.slice(0, limit - 1) + "…";
}
