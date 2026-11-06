import type { ChartSpec, Column } from "../../shared/types";
import type { chartSeries } from "./model";
import { chartPalette, chartSeriesColor } from "../../shared/chart-appearance";

function insideLabelColor(color: string) {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(color.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? "#111111" : "#ffffff";
}

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
  const showX = spec.showXAxis !== false;
  const showY = spec.showYAxis !== false;
  const showGrid = spec.showGrid !== false;
  const insideLabels =
    spec.kind === "bar" &&
    (spec.labelPosition === "inside" ||
      (stacked && spec.labelPosition !== "outside"));
  const formatter = (value: number) =>
    formatChartNumber(value, spec.numberFormat);
  const categoryLabels = new Map(
    series.flatMap((item) => Object.entries(item.categoryLabels ?? {})),
  );
  const categoryFormatter = categoryLabels.size
    ? (value: string | number) =>
        categoryLabels.get(String(value)) ?? String(value)
    : undefined;
  const escapeHtml = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  const nameCounts = new Map<string, number>();
  for (const item of series)
    nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1);
  let seriesNamePrefix = "table-series:";
  while (series.some((item) => item.name.startsWith(seriesNamePrefix)))
    seriesNamePrefix += ":";
  const seriesNames = series.map((item, index) =>
    item.displayData && nameCounts.get(item.name)! > 1
      ? `${seriesNamePrefix}${item.colorKey ?? index}`
      : item.name,
  );
  const legendDisplayNames = new Map(
    seriesNames.map((name, index) => [name, series[index].name]),
  );
  const tableTooltip = series.some((item) => item.displayData)
    ? (parameters: unknown): string => {
        const params = (
          Array.isArray(parameters) ? parameters : [parameters]
        ) as { seriesIndex?: number; dataIndex?: number }[];
        const points = params.flatMap((param) => {
          const item = series[param.seriesIndex ?? -1];
          const display = item?.displayData?.[param.dataIndex ?? -1];
          return display ? [{ item, display }] : [];
        });
        if (!points.length) return "";
        const category = points[0].display.x;
        return [
          escapeHtml(
            spec.kind === "scatter"
              ? `${categoryName ?? "X"}: ${category}`
              : category,
          ),
          ...points.map(
            ({ item, display }) =>
              `${escapeHtml(item.name)}: ${escapeHtml(display.value)}`,
          ),
        ].join("<br/>");
      }
    : undefined;
  // ECharts contains axis decorations, but not labels at the ends of bars or
  // above points. Reserve room even when axes (and their gutters) are hidden.
  const outsideLabels = spec.showLabels && !insideLabels;
  const labelWidth = outsideLabels
    ? series.reduce(
        (width, item) =>
          item.data.reduce(
            (max, point, index) =>
              typeof point[1] === "number" && Number.isFinite(point[1])
                ? Math.max(
                    max,
                    (item.displayData?.[index]?.value ?? formatter(point[1]))
                      .length *
                      7 +
                      10,
                  )
                : max,
            width,
          ),
        0,
      )
    : 0;
  const resolvedLabelWidth = (limit: number) =>
    Math.min(Math.max(0, labelWidth - 10), limit);
  const topLabelSpace = outsideLabels && !horizontalBar ? 20 : 0;
  const bottomLabelSpace =
    outsideLabels && spec.kind === "bar" && !horizontalBar ? 20 : 0;
  // Reserve a strip for the legend, outside the bounds containing BOTH axes,
  // their tick labels and names. ECharts 6 moves a middle axis name past ticks.
  const layout = (sideWidth: number, textWidth: number, labelLimit = 160) => {
    const width = resolvedLabelWidth(labelLimit);
    const gutter = outsideLabels ? width + 10 : 0;
    const sideLabelSpace = horizontalBar ? gutter : gutter / 2;
    return {
      // Long values truncate only on the canvas; tooltips retain the full value.
      ...(outsideLabels
        ? { series: series.map(() => ({ label: { width } })) }
        : {}),
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
        left:
          (spec.legend && position === "left" ? sideWidth + 24 : 8) +
          sideLabelSpace,
        right:
          (spec.legend && position === "right" ? sideWidth + 24 : 24) +
          sideLabelSpace,
        top: (spec.legend && position === "top" ? 42 : 12) + topLabelSpace,
        bottom:
          (spec.legend && position === "bottom" ? 42 : 8) + bottomLabelSpace,
      },
    };
  };
  const normalLayout = layout(180, vertical ? 150 : 160);
  const labelFormatter = ({ value }: { value?: unknown }) => {
    // Data always remains [category/X, metric] even for horizontal bars.
    const metric = Array.isArray(value) ? value[1] : undefined;
    return typeof metric === "number" && Number.isFinite(metric)
      ? formatter(metric)
      : "";
  };
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
    color: chartPalette(spec).colors,
    animation: false,
    tooltip: {
      trigger: spec.kind === "scatter" ? "item" : "axis",
      valueFormatter: tooltipValue,
      ...(tableTooltip ? { formatter: tableTooltip } : {}),
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
      tooltip: {
        show: true,
        formatter: (parameters: { name?: string }) =>
          escapeHtml(
            legendDisplayNames.get(parameters.name ?? "") ??
              parameters.name ??
              "",
          ),
      },
      formatter: (name: string) =>
        (legendDisplayNames.get(name) ?? name).replace(/\s+/g, " "),
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
      // axis.show also disables split lines in ECharts. Hide decorations
      // individually so axes and the grid can be controlled independently.
      name: showX ? (horizontalBar ? valueName : categoryName) : "",
      nameLocation: "middle",
      nameGap: 32,
      nameMoveOverlap: true,
      nameTruncate: { maxWidth: 180 },
      axisLabel: {
        show: showX,
        color: "#a9adb1",
        formatter:
          horizontalBar || spec.kind === "scatter"
            ? formatter
            : categoryFormatter,
        width: 90,
        overflow: "truncate",
        hideOverlap: true,
      },
      axisLine: {
        ...(!showX ? { show: false } : {}),
        lineStyle: { color: "#3b3e43" },
      },
      axisTick: !showX ? { show: false } : undefined,
      minorTick: { show: false },
      splitLine: {
        show: showGrid && (horizontalBar || spec.kind === "scatter"),
        lineStyle: { color: "#3b3e43" },
      },
      minorSplitLine: { show: false },
    },
    yAxis: {
      type: horizontalBar ? "category" : "value",
      data: horizontalBar && stacked ? series[0]?.xCategories : undefined,
      inverse: horizontalBar,
      name: showY ? (horizontalBar ? categoryName : valueName) : "",
      nameLocation: "middle",
      nameRotate: 90,
      nameGap: 20,
      nameMoveOverlap: true,
      nameTruncate: { maxWidth: 150 },
      axisLabel: {
        show: showY,
        color: "#a9adb1",
        formatter: horizontalBar ? categoryFormatter : formatter,
        ...(horizontalBar
          ? { width: 120, overflow: "truncate", hideOverlap: true }
          : {}),
      },
      axisLine: !showY
        ? { show: false }
        : horizontalBar
          ? { lineStyle: { color: "#3b3e43" } }
          : undefined,
      axisTick: !showY ? { show: false } : undefined,
      minorTick: { show: false },
      splitLine: {
        show: showGrid && !horizontalBar,
        lineStyle: { color: "#3b3e43" },
      },
      minorSplitLine: { show: false },
    },
    series: series.map(
      (
        {
          metricId,
          colorKey,
          xCategories: _xCategories,
          displayData,
          categoryLabels: _categoryLabels,
          ...item
        },
        index,
      ) => {
        const color = chartSeriesColor(spec, { colorKey }, index);
        return {
          ...item,
          name: seriesNames[index],
          ...(displayData?.some((display) => display.color)
            ? {
                data: item.data.map((value, pointIndex) =>
                  displayData[pointIndex]?.color
                    ? {
                        value,
                        itemStyle: { color: displayData[pointIndex].color },
                      }
                    : value,
                ),
              }
            : {}),
          type: spec.kind === "area" ? "line" : spec.kind,
          // Preserve the source dimension/metric data while moving them to the
          // physical axes. ECharts uses the same mapping for stacks and tooltips.
          encode: horizontalBar ? { x: 1, y: 0 } : undefined,
          // A breakdown stacks within each selected metric, never across metrics
          // that happen to share the same display name.
          stack: stacked && metricId ? `metric:${metricId}` : undefined,
          itemStyle: { color },
          lineStyle: { color },
          areaStyle: spec.kind === "area" ? { opacity: 0.2, color } : undefined,
          label: {
            show: spec.showLabels ?? false,
            position:
              spec.kind === "bar"
                ? insideLabels
                  ? "inside"
                  : "outside"
                : "top",
            formatter: (params: { value?: unknown; dataIndex?: number }) =>
              displayData?.[params.dataIndex ?? -1]?.value ??
              labelFormatter(params),
            color: insideLabels ? insideLabelColor(color) : "#eeeff0",
            fontSize: 11,
            distance: 5,
            width: outsideLabels ? resolvedLabelWidth(160) : undefined,
            overflow: "truncate",
          },
          labelLayout: { hideOverlap: true },
          showAllSymbol: spec.showLabels ? true : undefined,
          symbolSize: spec.kind === "scatter" ? 7 : 4,
          connectNulls: false,
        };
      },
    ),
    // Media options are recalculated on chart.resize(), including when a board
    // card is resized. The explicit wide query restores the full legend gutter.
    media: [
      { query: { minWidth: 650 }, option: normalLayout },
      {
        query: { minWidth: 450, maxWidth: 649 },
        option: layout(140, vertical ? 110 : 160, 100),
      },
      {
        query: { maxWidth: 449 },
        option: {
          ...layout(86, vertical ? 56 : 80, vertical && spec.legend ? 40 : 72),
          xAxis: {
            nameTruncate: { maxWidth: vertical && spec.legend ? 50 : 110 },
          },
        },
      },
      {
        query: { maxWidth: 299 },
        option: {
          ...layout(72, vertical ? 42 : 80, vertical && spec.legend ? 32 : 64),
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
