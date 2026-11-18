import type { ChartSpec } from "../../../shared/types";
import { chartStackTotals } from "../chart-stack-totals";
import type { ChartSeriesItem } from "../model";

interface Segment {
  base: number;
  end: number;
  outer: boolean;
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
    Map<string, { positive?: Segment; negative?: Segment }>
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
      const segment: Segment = { base: 0, end: 0, outer: false };
      if (value === null) return segment;
      let column = columns.get(key);
      if (!column) {
        column = {};
        columns.set(key, column);
      }
      const sign = value < 0 ? "negative" : "positive";
      const previous = column[sign];
      segment.base = previous?.end ?? 0;
      segment.end = segment.base + value / unit;
      if (value !== 0) {
        if (previous) previous.outer = false;
        segment.outer = true;
        column[sign] = segment;
      }
      return segment;
    });
  });

  const totals = [];
  if (spec.showTotals !== false) {
    const withMetrics = series.map((s, i) =>
      s.metricId ? s : { ...s, metricId: metricIds[i] },
    );
    const byOwner = chartStackTotals(
      withMetrics,
      series.map((s) => s.name),
      {},
      unit,
    );
    for (const [owner, labels] of byOwner) {
      for (const label of labels) {
        const value = label.value * unit;
        // An extent may exceed Float64 in raw units while its signed net still fits.
        if (Number.isFinite(value))
          totals.push({
            metricId: metricIds[owner],
            category: String(label.category),
            value,
            extent: label.extent,
          });
      }
    }
  }
  return { segments, laneByMetric, metricIds, totals };
}
