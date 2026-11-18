import type { ChartSpec, Column } from "../../../shared/types";
import type { ChartSeriesItem } from "../model";

export interface ChartPlotProps {
  columns: Column[];
  spec: ChartSpec;
  series: ChartSeriesItem[];
  colors: string[];
  label: string;
  presentationBackground?: string;
  loading?: boolean;
}

/** A loading preview needs the visible series' identities and colors, never their sampled values. */
export function plotLoadingSeries(series: ChartSeriesItem[], colors: string[]) {
  return series.map(({ metricId }, index) => ({
    metricId,
    color: colors[index],
    index,
  }));
}
