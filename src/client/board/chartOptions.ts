import type { ChartSpec, Column } from "../../shared/types";
import type { chartSeries } from "./model";

export function formatChartNumber(
  value: number,
  format: ChartSpec["numberFormat"] = "auto",
) {
  if (format === "compact") {
    if (value === 0) return "0";
    if (!Number.isFinite(value)) return String(value);
    const magnitude = Math.abs(value);
    // Keep small nonzero values visible instead of rounding them to zero.
    if (magnitude < 1)
      return value.toLocaleString("en-US", {
        maximumSignificantDigits: 4,
        useGrouping: false,
      });
    const units = ["", "k", "M", "G", "T", "P", "E", "Z", "Y"];
    let unit = Math.min(
      Math.floor(Math.log10(magnitude) / 3),
      units.length - 1,
    );
    let rounded = Math.round((magnitude / 1000 ** unit) * 10) / 10;
    // Promote after rounding as well: 999.95k is 1M, never 1000k.
    if (rounded >= 1000 && unit < units.length - 1) {
      rounded /= 1000;
      unit += 1;
    }
    return `${value < 0 ? "-" : ""}${rounded}${units[unit]}`;
  }
  if (format === "percent")
    return `${(value * 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString("ru-RU", {
    maximumFractionDigits:
      format === "integer" ? 0 : format === "decimal" ? 2 : 6,
  });
}

export function chartOptions(
  columns: Column[],
  spec: ChartSpec,
  series: ReturnType<typeof chartSeries>,
) {
  const position = spec.legendPosition ?? "top";
  const align = spec.legendAlign ?? "center";
  const vertical = position === "left" || position === "right";
  const horizontalBar =
    spec.kind === "bar" && spec.orientation === "horizontal";
  const categoryName = columns.find((c) => c.id === spec.x)?.name;
  const valueName = spec.y
    .map((id) => columns.find((c) => c.id === id)?.name)
    .filter(Boolean)
    .join(", ");
  const stacked =
    spec.kind !== "scatter" && spec.stacked && Boolean(spec.series);
  // Reserve a strip for the legend, outside the bounds containing BOTH axes,
  // their tick labels and names. ECharts 6 moves a middle axis name past ticks.
  const layout = (sideWidth: number, textWidth: number) => ({
    legend: {
      left: vertical
        ? position === "left"
          ? 8
          : "auto"
        : align === "start"
          ? 8
          : align === "center"
            ? "center"
            : "auto",
      right: vertical
        ? position === "right"
          ? 8
          : "auto"
        : align === "end"
          ? 8
          : "auto",
      top: vertical
        ? align === "start"
          ? 8
          : align === "center"
            ? "middle"
            : "auto"
        : position === "top"
          ? 6
          : "auto",
      bottom: vertical
        ? align === "end"
          ? 8
          : "auto"
        : position === "bottom"
          ? 6
          : "auto",
      width: vertical ? sideWidth : "94%",
      height: vertical ? "90%" : "auto",
      textStyle: { width: textWidth },
    },
    grid: {
      left: spec.legend && position === "left" ? sideWidth + 24 : 8,
      right: spec.legend && position === "right" ? sideWidth + 24 : 24,
      top: spec.legend && position === "top" ? 42 : 12,
      bottom: spec.legend && position === "bottom" ? 42 : 8,
    },
  });
  const normalLayout = layout(180, vertical ? 150 : 160);
  const formatter = (value: number) =>
    formatChartNumber(value, spec.numberFormat);
  const tooltipValue = (value: unknown): string =>
    Array.isArray(value)
      ? value.map(tooltipValue).join(", ")
      : typeof value === "number"
        ? formatter(value)
        : value === null || value === undefined
          ? "—"
          : String(value);
  return {
    backgroundColor: "transparent",
    color: ["#82aaff", "#8ec9b0", "#dfb986", "#c99bd8", "#ef9292"],
    animation: false,
    tooltip: {
      trigger: spec.kind === "scatter" ? "item" : "axis",
      valueFormatter: tooltipValue,
      backgroundColor: "#303338",
      borderColor: "#3b3e43",
      textStyle: { color: "#eeeff0" },
    },
    legend: {
      ...normalLayout.legend,
      show: spec.legend,
      type: "scroll",
      orient: vertical ? "vertical" : "horizontal",
      padding: 0,
      itemWidth: 14,
      itemHeight: 10,
      pageIconSize: 10,
      pageButtonItemGap: 4,
      pageTextStyle: { color: "#a9adb1" },
      tooltip: { show: true },
      formatter: (name: string) => name.replace(/\s+/g, " "),
      textStyle: {
        ...normalLayout.legend.textStyle,
        color: "#a9adb1",
        overflow: "truncate",
      },
    },
    grid: {
      ...normalLayout.grid,
      outerBoundsMode: "same",
      outerBoundsContain: "all",
    },
    xAxis: {
      type: horizontalBar || spec.kind === "scatter" ? "value" : "category",
      data: !horizontalBar && stacked ? series[0]?.xCategories : undefined,
      name: horizontalBar ? valueName : categoryName,
      nameLocation: "middle",
      nameGap: 32,
      nameMoveOverlap: true,
      nameTruncate: { maxWidth: 180 },
      axisLabel: {
        color: "#a9adb1",
        formatter:
          horizontalBar || spec.kind === "scatter" ? formatter : undefined,
        width: 90,
        overflow: "truncate",
        hideOverlap: true,
      },
      axisLine: { lineStyle: { color: "#3b3e43" } },
      splitLine: horizontalBar
        ? { lineStyle: { color: "#3b3e43" } }
        : undefined,
    },
    yAxis: {
      type: horizontalBar ? "category" : "value",
      data: horizontalBar && stacked ? series[0]?.xCategories : undefined,
      inverse: horizontalBar,
      name: horizontalBar ? categoryName : valueName,
      nameLocation: "middle",
      nameRotate: 90,
      nameGap: 20,
      nameMoveOverlap: true,
      nameTruncate: { maxWidth: 150 },
      axisLabel: {
        color: "#a9adb1",
        formatter: horizontalBar ? undefined : formatter,
        ...(horizontalBar
          ? { width: 120, overflow: "truncate", hideOverlap: true }
          : {}),
      },
      axisLine: horizontalBar ? { lineStyle: { color: "#3b3e43" } } : undefined,
      splitLine: horizontalBar
        ? undefined
        : { lineStyle: { color: "#3b3e43" } },
    },
    series: series.map(({ metricId, xCategories: _xCategories, ...item }) => ({
      ...item,
      type: spec.kind === "area" ? "line" : spec.kind,
      // Preserve the source dimension/metric data while moving them to the
      // physical axes. ECharts uses the same mapping for stacks and tooltips.
      encode: horizontalBar ? { x: 1, y: 0 } : undefined,
      // A breakdown stacks within each selected metric, never across metrics
      // that happen to share the same display name.
      stack: stacked && metricId ? `metric:${metricId}` : undefined,
      areaStyle: spec.kind === "area" ? { opacity: 0.2 } : undefined,
      symbolSize: spec.kind === "scatter" ? 7 : 4,
      connectNulls: false,
    })),
    // Media options are recalculated on chart.resize(), including when a board
    // card is resized. The explicit wide query restores the full legend gutter.
    media: [
      { query: { minWidth: 650 }, option: normalLayout },
      {
        query: { minWidth: 450, maxWidth: 649 },
        option: layout(140, vertical ? 110 : 160),
      },
      {
        query: { maxWidth: 449 },
        option: {
          ...layout(86, vertical ? 56 : 80),
          xAxis: {
            nameTruncate: { maxWidth: vertical && spec.legend ? 50 : 110 },
          },
        },
      },
      {
        query: { maxWidth: 299 },
        option: {
          ...layout(72, vertical ? 42 : 80),
          xAxis: {
            nameTruncate: { maxWidth: vertical && spec.legend ? 30 : 110 },
          },
        },
      },
      {
        query: { minWidth: 450 },
        option: { xAxis: { nameTruncate: { maxWidth: 180 } } },
      },
      {
        query: { maxHeight: 180 },
        option: { yAxis: { nameTruncate: { maxWidth: 40 } } },
      },
      {
        query: { minHeight: 181, maxHeight: 220 },
        option: { yAxis: { nameTruncate: { maxWidth: 70 } } },
      },
      {
        query: { minHeight: 221, maxHeight: 259 },
        option: { yAxis: { nameTruncate: { maxWidth: 110 } } },
      },
      {
        query: { minHeight: 260 },
        option: { yAxis: { nameTruncate: { maxWidth: 150 } } },
      },
    ],
  };
}
