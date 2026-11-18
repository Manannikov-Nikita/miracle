import type { chartSeries } from "./model";

export interface StackTotal {
  category: string | number | null;
  value: number;
  extent: number;
}

/** Totals belong to a visible series' slot. Values and extents are in units of `unit`. */
export function chartStackTotals(
  series: ReturnType<typeof chartSeries>,
  names: string[],
  selected: Record<string, boolean>,
  unit = 1,
): Map<number, StackTotal[]> {
  const metrics = new Map<
    string,
    {
      owner: number;
      categories: Map<
        StackTotal["category"],
        { value: number; positive: number; negative: number }
      >;
    }
  >();
  series.forEach((item, index) => {
    if (!item.metricId || selected[names[index]] === false) return;
    let metric = metrics.get(item.metricId);
    if (!metric) {
      metric = { owner: index, categories: new Map() };
      metrics.set(item.metricId, metric);
    }
    for (const [category, value] of item.data) {
      // A missing value is not a zero and must not invent an empty total label.
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const total = metric.categories.get(category) ?? {
        value: 0,
        positive: 0,
        negative: 0,
      };
      const amount = value / unit;
      total.value += amount;
      if (value < 0) total.negative += amount;
      else total.positive += amount;
      metric.categories.set(category, total);
    }
  });
  const result = new Map<number, StackTotal[]>();
  for (const { owner, categories } of metrics.values()) {
    const totals = [...categories].flatMap(([category, total]) => {
      const extent = total.value < 0 ? total.negative : total.positive;
      return Number.isFinite(total.value) && Number.isFinite(extent)
        ? [{ category, value: total.value, extent }]
        : [];
    });
    if (totals.length) result.set(owner, totals);
  }
  return result;
}
