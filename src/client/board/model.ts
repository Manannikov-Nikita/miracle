import type {
  BoardDocument,
  BoardNode,
  Cell,
  ChartSpec,
  Column,
  ResultSet,
} from "../../shared/types";

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
    width: 540,
    height: 350,
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
      node.id === nodeId && node.data.sourceRevision === sourceRevision
        ? { ...node, data: { ...node.data, resultSetId } }
        : node,
    ),
  };
}
const numericType =
  /^(?:(?:Nullable|LowCardinality)\(\s*)*(?:U?Int\d+|Float\d+|Decimal(?:32|64|128|256)?|DOUBLE(?: PRECISION)?|REAL|NUMERIC|BIGINT|SMALLINT|TINYINT|INTEGER|INT)(?=\s*(?:[(),]|$))/i;
export function isNumericColumn(column: Column) {
  return numericType.test(column.type);
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
export function chartSeries(
  columns: Column[],
  rows: Cell[][],
  spec: ChartSpec,
) {
  const xi = columns.findIndex((c) => c.id === spec.x);
  const ys = spec.y.map((id) => columns.findIndex((c) => c.id === id));
  const si = spec.series ? columns.findIndex((c) => c.id === spec.series) : -1;
  if (xi < 0 || !ys.length || ys.some((i) => i < 0) || (spec.series && si < 0))
    throw new Error("Выберите существующие столбцы X и Y.");
  if (rows.length * ys.length > 5000)
    throw new Error(
      "График ограничен 5 000 точками во всём сохранённом результате. Агрегируйте данные в SQL.",
    );
  const groups = new Map<
    string,
    {
      metricId?: string;
      xCategories?: string[];
      name: string;
      data: [string | number | null, number | null][];
    }
  >();
  const stacked =
    spec.kind !== "scatter" && spec.stacked && Boolean(spec.series);
  const stackedCategories = new Map<string, Set<string | number | null>>();
  const xCategories = new Set<string>();
  for (const row of rows) {
    const rawX = row[xi];
    if (rawX !== null && !["string", "number", "boolean"].includes(typeof rawX))
      throw new Error("Ось X не поддерживает массивы и объекты.");
    const x =
      spec.kind === "scatter"
        ? chartNumber(rawX, columns[xi])
        : String(rawX ?? "NULL");
    if (stacked) xCategories.add(String(x));
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
          : rawGroup === null
            ? "∅ NULL"
            : String(rawGroup);
      const key = `${columns[yi].id}\u0000${JSON.stringify(rawGroup)}`;
      if (stacked) {
        const categories = stackedCategories.get(key) ?? new Set();
        if (categories.has(x))
          throw new Error(
            "Для накопления нужна одна строка на сочетание X и разбивки. Сгруппируйте значения в SQL (GROUP BY).",
          );
        categories.add(x);
        stackedCategories.set(key, categories);
      }
      if (!groups.has(key))
        groups.set(key, {
          metricId: columns[yi].id,
          name: `${columns[yi].name}${group ? ` · ${group}` : ""}`,
          data: [],
        });
      groups.get(key)!.data.push([x, chartNumber(row[yi], columns[yi])]);
    }
  }
  const result = [...groups.values()];
  if (spec.sort && spec.sort !== "none")
    for (const series of result)
      series.data.sort(
        (a, b) =>
          (typeof a[0] === "number" && typeof b[0] === "number"
            ? a[0] - b[0]
            : String(a[0]).localeCompare(String(b[0]), undefined, {
                numeric: true,
              })) * (spec.sort === "desc" ? -1 : 1),
      );
  if (stacked) {
    // A sparse first series may not contain the globally first category.
    // Keep one shared union in source order, or sort the whole union together.
    const categories = [...xCategories];
    if (spec.kind !== "bar" && result.length * categories.length > 5000)
      throw new Error(
        "График ограничен 5 000 точками с учётом пропусков. Агрегируйте данные в SQL.",
      );
    if (spec.sort && spec.sort !== "none")
      categories.sort(
        (a, b) =>
          a.localeCompare(b, undefined, { numeric: true }) *
          (spec.sort === "desc" ? -1 : 1),
      );
    for (const series of result) {
      series.xCategories = categories;
      if (spec.kind !== "bar") {
        // Line/area paths must follow the shared axis order. Explicit nulls
        // also prevent a lower band from bridging a missing breakdown value.
        const byCategory = new Map(series.data);
        series.data = categories.map((x) => [x, byCategory.get(x) ?? null]);
      }
    }
  }
  return result;
}
export function cellText(value: Cell | undefined) {
  return value === null || value === undefined
    ? "NULL"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
