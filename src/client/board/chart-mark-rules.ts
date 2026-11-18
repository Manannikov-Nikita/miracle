import { isDateColumn, isNumericColumn } from "../../shared/column-types";
import { dateValue } from "../../shared/date-values";
import { decimal } from "../../shared/tableModel";
import type {
  Cell,
  ChartMarkCondition,
  ChartMarkStyle,
  ChartSpec,
  Column,
} from "../../shared/types";
import type { ChartSeriesItem } from "./model";

type Datum = ChartSeriesItem["data"][number];
export type ChartSourceRows = WeakMap<Datum, Cell[]>;

function compareCondition(
  when: Exclude<ChartMarkCondition, { field: "position" }>,
  column?: Column,
) {
  const { value: expected, op } = when;
  const numeric = when.field === "value" || (column && isNumericColumn(column));
  const threshold = numeric ? decimal(expected) : null;
  const date = column && isDateColumn(column) ? dateValue(expected) : undefined;
  return (actual: Cell | undefined) => {
    if (actual === undefined || (actual !== null && typeof actual === "object"))
      return false;
    if (actual === null || expected === null) {
      return op === "eq"
        ? actual === expected
        : op === "ne" && actual !== expected;
    }
    let order: number;
    if (numeric) {
      if (!threshold) return false;
      if (typeof actual === "number" && typeof expected === "number") {
        order = Math.sign(actual - expected);
      } else {
        const value = decimal(actual);
        if (!value) return false;
        order = value.cmp(threshold);
      }
    } else if (date !== undefined) {
      const value = dateValue(actual);
      if (value === undefined) return false;
      order = value < date ? -1 : value > date ? 1 : 0;
    } else if (typeof actual === "string" && typeof expected === "string") {
      order = actual < expected ? -1 : actual > expected ? 1 : 0;
    } else {
      return op === "eq"
        ? actual === expected
        : op === "ne" && actual !== expected;
    }
    switch (op) {
      case "eq":
        return order === 0;
      case "ne":
        return order !== 0;
      case "gt":
        return order > 0;
      case "gte":
        return order >= 0;
      case "lt":
        return order < 0;
      case "lte":
        return order <= 0;
    }
  };
}

/** Evaluate against displayed data after table transforms, chart sorting and
 * binning. Original row references are temporary and never saved in board JSON. */
export function applyChartMarkRules(
  series: ChartSeriesItem[],
  spec: ChartSpec,
  columns: Column[],
  source?: ChartSourceRows,
) {
  if (!spec.seriesStyles && !spec.markRules?.length) return series;
  const histogram = spec.kind === "histogram";
  const rules = spec.markRules
    ?.filter(({ style }) => Object.keys(style).length > 0)
    .map(({ seriesKey, style, when }) => {
      const index = columns.findIndex(
        (c) => c.id === (when.field === "column" ? when.columnId : spec.x),
      );
      const compare =
        when.field !== "position"
          ? compareCondition(when, columns[index])
          : undefined;
      function matches(datum: Datum, first: boolean, last: boolean) {
        switch (when.field) {
          case "position":
            return when.op === "first" ? first : last;
          case "value":
            return compare!(datum[1]);
          case "x":
            return compare!(histogram ? datum[0] : source?.get(datum)?.[index]);
          case "column":
            return !histogram && compare!(source?.get(datum)?.[index]);
        }
      }
      return { seriesKey, style, matches };
    });
  for (const item of series) {
    const base = item.colorKey ? spec.seriesStyles?.[item.colorKey] : undefined;
    if (base && Object.keys(base).length) item.seriesStyle = base;
    const selected = rules?.filter(
      (rule) => !rule.seriesKey || rule.seriesKey === item.colorKey,
    );
    if (!selected?.length) continue;
    let firstX: Datum[0] | undefined, lastX: Datum[0] | undefined;
    if (spec.kind === "scatter") {
      for (const [x, y] of item.data) {
        if (typeof x !== "number" || y === null) continue;
        if (typeof firstX !== "number" || x < firstX) firstX = x;
        if (typeof lastX !== "number" || x > lastX) lastX = x;
      }
    } else if (spec.kind !== "sparkline") {
      firstX = item.xCategories?.[0] ?? item.data[0]?.[0];
      lastX = item.xCategories?.at(-1) ?? item.data.at(-1)?.[0];
    }
    item.data.forEach((datum, i) => {
      if (datum[1] === null) return;
      const first = spec.kind === "sparkline" ? i === 0 : datum[0] === firstX;
      const last =
        spec.kind === "sparkline"
          ? i === item.data.length - 1
          : datum[0] === lastX;
      let style: ChartMarkStyle | undefined;
      for (const rule of selected) {
        if (rule.matches(datum, first, last)) {
          style ??= { ...base };
          Object.assign(style, rule.style);
        }
      }
      if (style) (item.pointStyles ??= [])[i] = style;
    });
  }
  return series;
}
