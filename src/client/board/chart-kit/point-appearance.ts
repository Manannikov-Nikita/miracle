import type { ChartSeriesItem } from "../model";

/** Point rules are resolved over series defaults before the chart is rendered. */
export function pointAppearance(
  item: ChartSeriesItem,
  index: number,
  base: string,
) {
  const style = item.pointStyles?.[index] ?? item.seriesStyle;
  return {
    style,
    color: style?.color ?? item.displayData?.[index]?.color ?? base,
  };
}
