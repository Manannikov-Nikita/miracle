import { scaleLinear } from "d3-scale";
import type { ChartSpec } from "../../../shared/types";
import type { HistogramBin } from "../histogram-bins";
import { formatChartNumber } from "../chart-number";
import type { ChartPlotProps } from "./plot-types";
import { unitPosition } from "./unit-position";

/** Keep the reference's 4px corners and flat crown as bins narrow on the board. */
export function binPath(
  x: number,
  y: number,
  width: number,
  height: number,
  outer = true,
) {
  const r = outer ? Math.min(4, width / 5, height) : 0;
  const right = x + width,
    bottom = y + height;
  if (!r) return `M${x},${bottom}V${y}H${right}V${bottom}Z`;
  return `M${x},${bottom}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${right - r}A${r},${r} 0 0 1 ${right},${y + r}V${bottom}Z`;
}

function boundaryLabels(values: number[], format: ChartSpec["numberFormat"]) {
  const text = values.map((v) => {
    if (
      (!format || format === "auto") &&
      v !== 0 &&
      (Math.abs(v) < 1e-6 || Math.abs(v) >= 1e12)
    )
      return v
        .toExponential(2)
        .replace(/\.?0+e/, "e")
        .replace("e+", "e");
    return formatChartNumber(v, format);
  });
  // A rounded label must not turn a nonzero measurement into zero, or
  // collapse two distinct edges into a single number in a range.
  if (
    new Set(text).size === values.length &&
    values.every(
      (v, i) =>
        !v ||
        (!/^[−-]?0(?:[,.]0+)?\s*%?$/.test(text[i]) && !text[i].includes("∞")),
    )
  )
    return text;
  return values.map((v) =>
    new Intl.NumberFormat("ru-RU", {
      style: format === "percent" ? "percent" : "decimal",
      maximumSignificantDigits: 17,
      notation:
        Math.abs(v) >= 1e12 || (v !== 0 && Math.abs(v) < 1e-6)
          ? "scientific"
          : "standard",
    }).format(v),
  );
}
export function histogramRange(
  bin: HistogramBin,
  last: boolean,
  format: ChartSpec["numberFormat"],
) {
  if (bin.lower === bin.upper)
    return `= ${boundaryLabels([bin.lower], format)[0]}`;
  const [low, high] = boundaryLabels([bin.lower, bin.upper], format);
  return `[${low}; ${high}${last ? "]" : ")"}`;
}

export function histogramGeometry(
  { spec, series }: Pick<ChartPlotProps, "spec" | "series">,
  width: number,
  height: number,
) {
  const bins = series[0]?.histogramBins ?? [];
  const showX = spec.showXAxis !== false,
    showY = spec.showYAxis !== false;
  const left = showY ? Math.min(62, width * 0.24) : 8,
    right = Math.max(left + 1, width - 12);
  const top = spec.showLabels ? 19 : 9,
    bottom = Math.max(top + 1, height - (showX ? 33 : 9));
  const min = bins[0]?.lower ?? 0,
    max = bins.at(-1)?.upper ?? 1;
  const constant = bins.length > 0 && max === min;
  const mid = (left + right) / 2,
    singleWidth = Math.min(90, (right - left) * 0.64);
  const atX = (value: number) =>
    left + (right - left) * unitPosition(value, min, max);
  const stacked = !!(spec.stacked && spec.series);
  const columns = bins.map((bin, i) => {
    const x0 = constant ? mid - singleWidth / 2 : atX(bin.lower),
      x1 = constant ? mid + singleWidth / 2 : atX(bin.upper);
    const counts = series.map((s) => s.data[i]?.[1] ?? 0);
    const total = counts.reduce((sum, v) => sum + v, 0),
      peak = stacked ? total : Math.max(0, ...counts);
    return { bin, x0, x1, center: (x0 + x1) / 2, counts, total, peak };
  });
  const maxY = Math.max(1, ...columns.map((c) => c.peak));
  const tickCount = Math.max(2, Math.min(7, Math.floor((bottom - top) / 35)));
  const y = scaleLinear()
    .domain([0, maxY])
    .nice(tickCount)
    .range([bottom, top]);
  const yTicks = y.ticks(tickCount).filter(Number.isInteger);
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  const unit =
    magnitude > 1e290 || (magnitude > 0 && magnitude < 1e-290) ? magnitude : 1;
  const rawTicks = constant
    ? [min]
    : scaleLinear()
        .domain([min / unit, max / unit])
        .ticks(Math.max(2, Math.min(8, Math.floor((right - left) / 78))))
        .map((v) => v * unit)
        .filter(Number.isFinite);
  const xValues = [...new Set(rawTicks.length ? rawTicks : [min, max])];
  const labels = boundaryLabels(xValues, spec.numberFormat);
  const xTicks = xValues.map((value, i) => ({
    value,
    label: labels[i],
    x: atX(value),
  }));
  function hit(x: number, py: number) {
    if (
      !columns.length ||
      py < top ||
      py > bottom ||
      x < columns[0].x0 ||
      x > columns[columns.length - 1].x1
    )
      return null;
    let lo = 0,
      hi = columns.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (x < columns[mid].x1) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }
  return {
    left,
    right,
    top,
    bottom,
    showX,
    showY,
    columns,
    stacked,
    xTicks,
    yTicks,
    y,
    hit,
  };
}
