import type { ChartSpec } from "../../../shared/types";
import type { ChartSeriesItem } from "../model";

interface Segment {
  base: number;
  end: number;
  outer: boolean;
  oppositeBase: number;
}

/** Sparse accumulators, one per visible metric/category and independent per sign. */
export function cartesianStacks(
  series: ChartSeriesItem[],
  spec: ChartSpec,
  unit: number,
) {
  const metricIds = series.map(
    (s) => s.metricId ?? (spec.y.length === 1 ? spec.y[0] : s.name),
  );
  const visible = new Set(metricIds);
  const ordered = new Set([
    ...spec.y.filter((id) => visible.has(id)),
    ...metricIds,
  ]);
  const laneByMetric = new Map([...ordered].map((id, lane) => [id, lane]));
  const columnsByMetric = new Map<
    string,
    Map<string, { net: number; positive?: Segment; negative?: Segment }>
  >();
  const segments = series.map((item, index) => {
    const id = metricIds[index];
    let columns = columnsByMetric.get(id);
    if (!columns) {
      columns = new Map();
      columnsByMetric.set(id, columns);
    }
    return item.data.map(([category, value]) => {
      const key = String(category);
      const segment: Segment = {
        base: 0,
        end: 0,
        outer: false,
        oppositeBase: 0,
      };
      if (value === null) return segment;
      let column = columns.get(key);
      if (!column) {
        column = { net: 0 };
        columns.set(key, column);
      }
      const sign = value < 0 ? "negative" : "positive";
      const previous = column[sign];
      const amount = value / unit;
      column.net += amount;
      segment.base = previous?.end ?? 0;
      segment.end = segment.base + amount;
      segment.oppositeBase =
        column[value < 0 ? "positive" : "negative"]?.end ?? 0;
      if (value !== 0) {
        if (previous) previous.outer = false;
        segment.outer = true;
        column[sign] = segment;
      }
      return segment;
    });
  });

  const totals = [];
  if (spec.kind === "bar" && spec.showTotals !== false) {
    for (const [metricId, columns] of columnsByMetric) {
      for (const [category, column] of columns) {
        const value = column.net * unit;
        // The label must fit Float64; its signed extent can stay in normalized units.
        if (Number.isFinite(value))
          totals.push({
            metricId,
            category,
            value,
            extent: column[column.net < 0 ? "negative" : "positive"]?.end ?? 0,
          });
      }
    }
  }
  return { segments, laneByMetric, metricIds, totals };
}
