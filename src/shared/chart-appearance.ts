import type { Cell, ChartSpec } from "./types.js";

export const CHART_SERIES_COLOR_KEY_LIMIT = 10000;
export const CHART_SERIES_COLOR_LIMIT = 5000;

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

/** A type-aware identity; neither display names nor row positions are unique. */
export function chartSeriesColorKey(
  metricId: string,
  seriesId: string | undefined,
  rawGroup: Cell | undefined,
) {
  return JSON.stringify([metricId, seriesId ?? null, rawGroup ?? null]);
}

export function chartPalette(spec: Pick<ChartSpec, "palette">) {
  return (
    CHART_PALETTES.find((palette) => palette.id === spec.palette) ??
    CHART_PALETTES[0]
  );
}

export function chartSeriesColor(
  spec: Pick<ChartSpec, "palette" | "seriesColors">,
  series: { colorKey?: string },
  index: number,
) {
  const custom = series.colorKey
    ? spec.seriesColors?.[series.colorKey]
    : undefined;
  if (typeof custom === "string" && /^#[0-9a-f]{6}$/i.test(custom))
    return custom;
  const colors = chartPalette(spec).colors;
  return colors[index % colors.length];
}
