import { isDateColumn, isNumericColumn } from "../../shared/column-types";
import { compareDateValues } from "../../shared/date-values";
import { applyChartMarkRules, type ChartSourceRows } from "./chart-mark-rules";
import { DEFAULT_RESULT_SIZE } from "../../shared/chart-size";
import {
  autoHistogramBins,
  histogramBins,
  histogramBinIndex,
  type HistogramBin,
} from "./histogram-bins";
export type { HistogramBin } from "./histogram-bins";
import type { TableColumnOptions } from "../../shared/tableTypes";
export { isNumericColumn } from "../../shared/column-types";
import type {
  BoardDocument,
  BoardNode,
  Cell,
  ChartMarkStyle,
  ChartSpec,
  Column,
  ResultSet,
} from "../../shared/types";
import {
  chartSeriesColorKey,
  HISTOGRAM_BIN_LIMIT,
  CHART_POINT_LIMIT,
  supportsChartStacking,
} from "../../shared/chart-appearance";

export const emptyDocument = (): BoardDocument => ({
  schemaVersion: 1,
  nodes: [],
  edges: [],
});
export function createResultNode(
  result: ResultSet,
  position = { x: 80, y: 80 },
  existingNodes: readonly BoardNode[] = [],
): BoardNode {
  const titles = new Set(existingNodes.map((node) => node.data.title));
  let number = 1;
  while (titles.has(`Результат запроса (${number})`)) number += 1;
  return {
    id: crypto.randomUUID(),
    type: "artifact",
    position,
    ...DEFAULT_RESULT_SIZE,
    data: {
      title: `Результат запроса (${number})`,
      kind: "result",
      resultSetId: result.id,
      source: { ...result.source },
      sourceRevision: 1,
      view: "table",
    },
  };
}
export function removeNode(document: BoardDocument, id: string): BoardDocument {
  return {
    ...document,
    nodes: document.nodes.filter((n) => n.id !== id),
    edges: document.edges.filter((e) => e.source !== id && e.target !== id),
  };
}
export function rebindResult(node: BoardNode, result: ResultSet): BoardNode {
  return {
    ...node,
    data: {
      ...node.data,
      resultSetId: result.id,
      source: { ...result.source },
      sourceRevision: (node.data.sourceRevision ?? 0) + 1,
      chart: undefined,
      visibleColumns: undefined,
      table: undefined,
      view: "table",
    },
  };
}
export function applyRefresh(
  document: BoardDocument,
  nodeId: string,
  sourceRevision: number,
  resultSetId: string,
): BoardDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === nodeId && (node.data.sourceRevision ?? 0) === sourceRevision
        ? { ...node, data: { ...node.data, resultSetId } }
        : node,
    ),
  };
}
export function chartNumber(value: Cell, column: Column): number | null {
  if (!isNumericColumn(column))
    throw new Error(
      `«${column.name}»: выберите числовой столбец (${column.type}).`,
    );
  if (value === null) return null;
  if (typeof value !== "number" && typeof value !== "string")
    throw new Error(`«${column.name}»: значение не является числом.`);
  const raw = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))
    throw new Error(`«${column.name}»: недопустимое число.`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed))
    throw new Error(`«${column.name}»: число вне диапазона графика.`);
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))
    throw new Error(
      `«${column.name}»: число превышает безопасную точность. Округлите его явно в SQL.`,
    );
  // Charts use IEEE doubles. Refuse values that would quietly lose meaningful decimal digits.
  const significant = raw
    .split(/[eE]/)[0]
    .replace(/^[+-]/, "")
    .replace(".", "")
    .replace(/^0+/, "")
    .replace(/0+$/, "").length;
  if (typeof value === "string" && significant > 15)
    throw new Error(
      `«${column.name}»: более 15 значащих цифр. Округлите значение явно в SQL.`,
    );
  if (parsed === 0 && /[1-9]/.test(raw.split(/[eE]/)[0]))
    throw new Error(`«${column.name}»: значение слишком мало для графика.`);
  return parsed;
}
export function defaultChart(columns: Column[]): ChartSpec {
  const numeric = columns.filter(isNumericColumn);
  return {
    kind: "bar",
    x: columns[0]?.id ?? "",
    y: numeric.slice(0, 1).map((c) => c.id),
    legend: true,
    numberFormat: "auto",
    sort: "none",
  };
}
export interface ChartPointDisplay {
  x: string;
  value: string;
  color?: string;
}
export interface ChartSeriesItem {
  seriesStyle?: ChartMarkStyle;
  /** Only matching marks have an entry, with series defaults already merged. */
  pointStyles?: (ChartMarkStyle | undefined)[];
  metricId?: string;
  colorKey?: string;
  xCategories?: string[];
  /** Shared interval edges for all frequency series; data[i] is [lower, count]. */
  histogramBins?: HistogramBin[];
  name: string;
  data: [string | number | null, number | null][];
  displayData?: ChartPointDisplay[];
  categoryLabels?: Record<string, string>;
}
export type ChartCellFormatter = (
  value: Cell,
  column: Column,
  role: "category" | "metric" | "series",
) => { text: string; color?: string };

function histogramSeries(
  columns: Column[],
  rows: Cell[][],
  spec: ChartSpec,
  formatCell?: ChartCellFormatter,
): ChartSeriesItem[] {
  const xi = columns.findIndex((c) => c.id === spec.x);
  const si = spec.series ? columns.findIndex((c) => c.id === spec.series) : -1;
  if (xi < 0 || !isNumericColumn(columns[xi]))
    throw new Error("Выберите числовой столбец X для гистограммы.");
  if (spec.series && si < 0)
    throw new Error("Выберите существующий столбец для разбивки.");
  const requested = spec.binCount;
  if (
    requested !== undefined &&
    (!Number.isInteger(requested) ||
      requested < 1 ||
      requested > HISTOGRAM_BIN_LIMIT)
  )
    throw new Error(
      `Число интервалов должно быть целым от 1 до ${HISTOGRAM_BIN_LIMIT}.`,
    );

  const groupValues = new Map<Cell | undefined, number[]>();
  const limitError =
    "Гистограмма ограничена 5 000 значений частоты. Уменьшите число интервалов или групп разбивки.";
  let count = 0,
    min = Infinity,
    max = -Infinity;
  for (const row of rows) {
    const value = chartNumber(row[xi] ?? null, columns[xi]);
    if (value === null) continue;
    const group = si < 0 ? undefined : (row[si] ?? null);
    if (group !== null && typeof group === "object")
      throw new Error("Разбивка не поддерживает массивы и объекты.");
    let values = groupValues.get(group);
    if (!values) {
      if (groupValues.size >= CHART_POINT_LIMIT) throw new Error(limitError);
      values = [];
      groupValues.set(group, values);
    }
    values.push(value);
    count++;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!count) return [];
  const bins =
    requested === undefined
      ? autoHistogramBins(
          min,
          max,
          count,
          Math.min(
            HISTOGRAM_BIN_LIMIT,
            Math.floor(CHART_POINT_LIMIT / groupValues.size),
          ),
        )
      : histogramBins(min, max, requested);
  if (groupValues.size * bins.length > CHART_POINT_LIMIT)
    throw new Error(limitError);
  const result: ChartSeriesItem[] = [];
  for (const [group, values] of groupValues) {
    const data: [number, number][] = bins.map((bin) => [bin.lower, 0]);
    for (const value of values) data[histogramBinIndex(bins, value)][1]++;
    let name = columns[xi].name;
    if (group !== undefined)
      name = formatCell
        ? formatCell(group, columns[si], "series").text
        : group === null
          ? "∅ NULL"
          : String(group);
    result.push({
      metricId: spec.x,
      colorKey: chartSeriesColorKey(spec.x, spec.series, group),
      name,
      histogramBins: bins,
      data,
    });
  }
  return result;
}

export function chartSeries(
  columns: (Column & { options?: Pick<TableColumnOptions, "dataType"> })[],
  rows: Cell[][],
  spec: ChartSpec,
  formatCell?: ChartCellFormatter,
) {
  if (spec.kind === "histogram")
    return applyChartMarkRules(
      histogramSeries(columns, rows, spec, formatCell),
      spec,
      columns,
    );
  const categoryAxis =
    spec.kind === "bar" && spec.orientation === "horizontal" ? "Y" : "X";
  const xi = columns.findIndex((c) => c.id === spec.x);
  const ys = spec.y.map((id) => columns.findIndex((c) => c.id === id));
  const si = spec.series ? columns.findIndex((c) => c.id === spec.series) : -1;
  if (xi < 0 || !ys.length || ys.some((i) => i < 0) || (spec.series && si < 0))
    throw new Error("Выберите существующие столбцы X и Y.");
  if (rows.length * ys.length > CHART_POINT_LIMIT)
    throw new Error(
      "График ограничен 5 000 точками во всём сохранённом результате. Агрегируйте данные в SQL.",
    );
  const groups = new Map<string, ChartSeriesItem>();
  const source: ChartSourceRows | undefined = spec.markRules?.some(
    ({ when }) => when.field === "x" || when.field === "column",
  )
    ? new WeakMap()
    : undefined;
  const categoryLabels: Record<string, string> | undefined = formatCell
    ? Object.create(null)
    : undefined;
  const stacked =
    supportsChartStacking(spec.kind) && spec.stacked && Boolean(spec.series);
  const heatmap = spec.kind === "heatmap";
  const dateCategory =
    spec.kind !== "scatter" &&
    isDateColumn(columns[xi], columns[xi].options?.dataType);
  const compareCategories = (
    a: string | number | null,
    b: string | number | null,
  ) =>
    dateCategory
      ? compareDateValues(a, b, spec.sort === "desc" ? "desc" : "asc")
      : (typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), undefined, { numeric: true })) *
        (spec.sort === "desc" ? -1 : 1);
  const needsSharedCategories = spec.kind !== "scatter";
  const seenCategories = new Map<string, Set<string | number | null>>();
  const xCategories = new Set<string>();
  for (const row of rows) {
    const rawX = row[xi];
    if (rawX !== null && !["string", "number", "boolean"].includes(typeof rawX))
      throw new Error(`Ось ${categoryAxis} не поддерживает массивы и объекты.`);
    const x =
      spec.kind === "scatter"
        ? chartNumber(rawX, columns[xi])
        : String(rawX ?? "NULL");
    const displayX = formatCell?.(
      rawX,
      columns[xi],
      spec.kind === "scatter" ? "metric" : "category",
    ).text;
    if (categoryLabels) categoryLabels[String(x)] = displayX!;
    if (needsSharedCategories) xCategories.add(String(x));
    for (const yi of ys) {
      const rawGroup = si < 0 ? undefined : row[si];
      if (
        rawGroup !== undefined &&
        rawGroup !== null &&
        typeof rawGroup === "object"
      )
        throw new Error("Разбивка не поддерживает массивы и объекты.");
      const group =
        rawGroup === undefined
          ? ""
          : formatCell
            ? formatCell(rawGroup, columns[si], "series").text
            : rawGroup === null
              ? "∅ NULL"
              : String(rawGroup);
      const key = `${columns[yi].id}\u0000${JSON.stringify(rawGroup)}`;
      if (stacked || heatmap) {
        const categories = seenCategories.get(key) ?? new Set();
        if (categories.has(x))
          throw new Error(
            heatmap
              ? "Ячейке тепловой карты соответствует несколько значений. Добавьте разбивку или сгруппируйте значения в SQL (GROUP BY)."
              : `Для накопления нужна одна строка на сочетание ${categoryAxis} и разбивки. Сгруппируйте значения в SQL (GROUP BY).`,
          );
        categories.add(x);
        seenCategories.set(key, categories);
      }
      if (!groups.has(key))
        groups.set(key, {
          metricId: columns[yi].id,
          colorKey: chartSeriesColorKey(columns[yi].id, spec.series, rawGroup),
          name: `${columns[yi].name}${group ? ` · ${group}` : ""}`,
          data: [],
          ...(formatCell ? { displayData: [], categoryLabels } : {}),
        });
      const series = groups.get(key)!;
      const datum: ChartSeriesItem["data"][number] = [
        x,
        chartNumber(row[yi], columns[yi]),
      ];
      series.data.push(datum);
      source?.set(datum, row);
      if (formatCell) {
        const display = formatCell(row[yi], columns[yi], "metric");
        series.displayData!.push({
          x: displayX!,
          value: display.text,
          color: display.color,
        });
      }
    }
  }
  const result = [...groups.values()];
  if (spec.sort && spec.sort !== "none")
    for (const series of result) {
      const ordered = series.data
        .map((point, index) => ({
          point,
          display: series.displayData?.[index],
        }))
        .sort(({ point: a }, { point: b }) => compareCategories(a[0], b[0]));
      series.data = ordered.map(({ point }) => point);
      if (series.displayData)
        series.displayData = ordered.map(({ display }) => display!);
    }
  if (needsSharedCategories) {
    // A sparse first series may not contain the globally first category.
    // Keep one shared union in source order, or sort the whole union together.
    const categories = [...xCategories];
    if (
      (heatmap || (stacked && spec.kind !== "bar")) &&
      result.length * categories.length > CHART_POINT_LIMIT
    )
      throw new Error(
        "График ограничен 5 000 точками с учётом пропусков. Агрегируйте данные в SQL.",
      );
    if (spec.sort && spec.sort !== "none") categories.sort(compareCategories);
    for (const series of result) {
      series.xCategories = categories;
      if (stacked && spec.kind !== "bar") {
        // Line/area paths must follow the shared axis order. Explicit nulls
        // also prevent a lower band from bridging a missing breakdown value.
        const byCategory = new Map(
          series.data.map((point) => [point[0], point]),
        );
        if (formatCell && series.displayData) {
          const displayByCategory = new Map(
            series.data.map(([x], index) => [x, series.displayData![index]]),
          );
          const metric = columns.find(
            (column) => column.id === series.metricId,
          )!;
          series.displayData = categories.map(
            (x) =>
              displayByCategory.get(x) ?? {
                x: categoryLabels?.[x] ?? x,
                value: formatCell(null, metric, "metric").text,
              },
          );
        }
        series.data = categories.map((x) => byCategory.get(x) ?? [x, null]);
      }
    }
  }
  return applyChartMarkRules(result, spec, columns, source);
}
export function cellText(value: Cell | undefined) {
  return value === null || value === undefined
    ? "NULL"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
