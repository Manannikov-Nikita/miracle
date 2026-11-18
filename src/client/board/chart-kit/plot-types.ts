import type { ChartSpec, Column } from "../../../shared/types";
import type { ChartSeriesItem } from "../model";

export interface ChartPlotProps {
  columns: Column[];
  spec: ChartSpec;
  series: ChartSeriesItem[];
  colors: string[];
  label: string;
  presentationBackground?: string;
}
