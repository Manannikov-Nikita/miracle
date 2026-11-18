import type {
  Cell,
  ChartKind,
  ChartMarkRule,
  ChartMetricStyle,
  ChartSpec,
} from "./types.js";

export const CHART_SERIES_COLOR_KEY_LIMIT = 10000;
export const CHART_SERIES_COLOR_LIMIT = 5000;
export const CHART_METRIC_LIMIT = 20;
export const CHART_POINT_LIMIT = 5000;
export const HISTOGRAM_BIN_LIMIT = 100;
export const CHART_MARK_RULE_LIMIT = 32;
export const unfinishedPeriodRule: ChartMarkRule = {
  when: { field: "position", op: "last" },
  style: {
    color: "#9299A4",
    opacity: 0.78,
    borderColor: "#BEC5D0",
    borderStyle: "dashed",
    borderWidth: 1.5,
    pattern: "diagonal",
  },
};

export function supportsChartStacking(kind: ChartKind) {
  return kind === "bar" || kind === "line" || kind === "area";
}

export function composedMetricStyle(
  spec: Pick<ChartSpec, "metricStyles" | "y">,
  metricId: string,
): ChartMetricStyle {
  const styles = spec.metricStyles;
  if (styles && Object.hasOwn(styles, metricId)) return styles[metricId];
  return metricId === spec.y[0] ? "bar" : "line";
}

export const CHART_PALETTES: {
  id: NonNullable<ChartSpec["palette"]>;
  name: string;
  colors: string[];
}[] = [
  {
    id: "default",
    name: "Стандартная",
    colors: ["#82aaff", "#8ec9b0", "#dfb986", "#c99bd8", "#ef9292"],
  },
  {
    id: "cool",
    name: "Холодная",
    colors: ["#75b9f2", "#72d4cc", "#a4b4ff", "#9ad9a9", "#bfa8ef"],
  },
  {
    id: "warm",
    name: "Тёплая",
    colors: ["#f0ad72", "#eb8c87", "#e5c76b", "#d99dc4", "#b9c87f"],
  },
  {
    id: "vivid",
    name: "Яркая",
    colors: ["#55a8ff", "#ff8473", "#5fd4a7", "#c28bff", "#f4cf5b"],
  },
];

// The shadcn.io histogram examples use five blue chart tokens in both themes.
// A single distribution starts at chart-1, an overlay at chart-3, and a stack at chart-2.
const histogramPalette = {
  ...CHART_PALETTES[0],
  colors: ["#8ec5ff", "#2b7fff", "#155dfc", "#1447e6", "#193cb8"],
};
const [chart1, chart2, chart3, ...otherBlues] = histogramPalette.colors;
const histogramOverlayPalette = {
  ...histogramPalette,
  colors: [chart3, chart1, chart2, ...otherBlues],
};
const histogramStackedPalette = {
  ...histogramPalette,
  colors: [chart2, chart1, chart3, ...otherBlues],
};

type PaletteSpec = Pick<ChartSpec, "palette" | "series" | "stacked"> & {
  kind?: ChartKind;
};

/** A type-aware identity; neither display names nor row positions are unique. */
export function chartSeriesColorKey(
  metricId: string,
  seriesId: string | undefined,
  rawGroup: Cell | undefined,
) {
  return JSON.stringify([metricId, seriesId ?? null, rawGroup ?? null]);
}

export function chartPalette(spec: PaletteSpec) {
  const palette =
    CHART_PALETTES.find((palette) => palette.id === spec.palette) ??
    CHART_PALETTES[0];
  if (spec.kind !== "histogram" || palette.id !== "default") return palette;
  if (!spec.series) return histogramPalette;
  return spec.stacked ? histogramStackedPalette : histogramOverlayPalette;
}

export function chartSeriesColor(
  spec: PaletteSpec & Pick<ChartSpec, "seriesColors" | "seriesStyles">,
  series: { colorKey?: string },
  index: number,
) {
  const custom = series.colorKey
    ? (spec.seriesStyles?.[series.colorKey]?.color ??
      spec.seriesColors?.[series.colorKey])
    : undefined;
  if (typeof custom === "string" && /^#[0-9a-f]{6}$/i.test(custom))
    return custom;
  const colors = chartPalette(spec).colors;
  return colors[index % colors.length];
}
