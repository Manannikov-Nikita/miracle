import { z } from "zod";
import type { Column, ResultSet } from "./types.js";
import { isNumericColumn } from "./column-types.js";
import { renameVisualFormulaReferences } from "./visual-table-formula.js";

export type VisualTableScalar = string | number | boolean | null;
export interface VisualTableColumn {
  id: string;
  name: string;
  type: "text" | "number" | "boolean";
  sourceColumnId?: string;
  formula?: string;
  summary?: "none" | "sum" | "avg" | "min" | "max" | "count";
  width?: number;
}
export interface VisualTableRow {
  id: string;
  values: Record<string, VisualTableScalar>;
}
export interface VisualTableEdit {
  rowId: string;
  columnId: string;
  value: VisualTableScalar;
}
export interface VisualTableSpec {
  version: 1;
  sourceResultSetId?: string;
  sourceSchema?: string;
  columns: VisualTableColumn[];
  rows?: VisualTableRow[];
  edits: VisualTableEdit[];
  filters?: Array<{
    columnId: string;
    op:
      | "contains"
      | "eq"
      | "neq"
      | "gt"
      | "gte"
      | "lt"
      | "lte"
      | "isNull"
      | "notNull";
    value?: string;
  }>;
  sort?: { columnId: string; direction: "asc" | "desc" };
}
export interface VisualTableResult {
  columns: VisualTableColumn[];
  rows: VisualTableRow[];
  summaries: Record<string, VisualTableScalar>;
  sourceRowCount: number;
  totalRowCount: number;
  offset: number;
  limit: number;
  sql: string;
  parameters: VisualTableScalar[];
  elapsedMs: number;
}
export const VISUAL_TABLE_LIMITS = {
  columns: 100,
  manualRows: 1000,
  edits: 10000,
  filters: 20,
  formulaLength: 2000,
  cellLength: 10000,
  specBytes: 1024 * 1024,
  sourceRows: 50000,
  sourceBytes: 20 * 1024 * 1024,
  sourceCells: 1000000,
  pageSize: 500,
  maxPageSize: 2000,
} as const;
const id = z.string().min(1).max(200);
const scalar = z.union([
  z.string().max(VISUAL_TABLE_LIMITS.cellLength),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export function isVisualTableNumeric(value: VisualTableScalar): boolean {
  if (value === null) return true;
  if (typeof value === "number")
    return (
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value))
    );
  return (
    typeof value === "string" &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
  );
}
function accepts(column: VisualTableColumn, value: VisualTableScalar) {
  return (
    value === null ||
    (column.type === "number"
      ? isVisualTableNumeric(value)
      : column.type === "boolean"
        ? typeof value === "boolean"
        : typeof value === "string")
  );
}
export const visualTableSpecSchema: z.ZodType<VisualTableSpec> = z
  .object({
    version: z.literal(1),
    sourceResultSetId: z.uuid().optional(),
    sourceSchema: z.string().min(1).max(100000).optional(),
    columns: z
      .array(
        z
          .object({
            id,
            name: z.string().trim().min(1).max(200),
            type: z.enum(["text", "number", "boolean"]),
            sourceColumnId: id.optional(),
            formula: z
              .string()
              .max(VISUAL_TABLE_LIMITS.formulaLength)
              .optional(),
            summary: z
              .enum(["none", "sum", "avg", "min", "max", "count"])
              .optional(),
            width: z.number().int().min(60).max(2000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(VISUAL_TABLE_LIMITS.columns),
    rows: z
      .array(z.object({ id, values: z.record(id, scalar) }).strict())
      .max(VISUAL_TABLE_LIMITS.manualRows)
      .optional(),
    edits: z
      .array(z.object({ rowId: id, columnId: id, value: scalar }).strict())
      .max(VISUAL_TABLE_LIMITS.edits),
    filters: z
      .array(
        z
          .object({
            columnId: id,
            op: z.enum([
              "contains",
              "eq",
              "neq",
              "gt",
              "gte",
              "lt",
              "lte",
              "isNull",
              "notNull",
            ]),
            value: z.string().max(VISUAL_TABLE_LIMITS.cellLength).optional(),
          })
          .strict(),
      )
      .max(VISUAL_TABLE_LIMITS.filters)
      .optional(),
    sort: z
      .object({ columnId: id, direction: z.enum(["asc", "desc"]) })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((table, context) => {
    const fail = (message: string) =>
      context.addIssue({ code: "custom", message });
    const columns = new Map(table.columns.map((c) => [c.id, c]));
    if (
      columns.size !== table.columns.length ||
      new Set(table.columns.map((c) => c.name.toLocaleLowerCase())).size !==
        table.columns.length
    )
      fail("Идентификаторы и названия столбцов должны быть уникальными.");
    const sourceIds = table.columns.flatMap((c) =>
      c.sourceColumnId ? [c.sourceColumnId] : [],
    );
    if (new Set(sourceIds).size !== sourceIds.length)
      fail("Исходный столбец указан несколько раз.");
    if (
      table.sourceResultSetId
        ? !table.sourceSchema || table.rows !== undefined
        : table.sourceSchema !== undefined ||
          sourceIds.length > 0 ||
          table.rows === undefined
    )
      fail("Укажите снимок SQL или собственные строки таблицы.");
    const rows = new Set(table.rows?.map((r) => r.id));
    if (rows.size !== (table.rows?.length ?? 0))
      fail("Идентификаторы строк должны быть уникальными.");
    for (const row of table.rows ?? [])
      for (const [columnId, value] of Object.entries(row.values)) {
        const column = columns.get(columnId);
        if (!column || !accepts(column, value))
          fail("Неверный столбец или тип значения в строке.");
      }
    const edits = new Set<string>();
    for (const edit of table.edits) {
      const column = columns.get(edit.columnId),
        key = JSON.stringify([edit.rowId, edit.columnId]);
      if (!column || !accepts(column, edit.value))
        fail("Неверный столбец или тип локальной правки.");
      if (
        table.sourceResultSetId
          ? !new RegExp(`^${table.sourceResultSetId}:(0|[1-9]\\d*)$`).test(
              edit.rowId,
            )
          : !rows.has(edit.rowId)
      )
        fail("Правка не принадлежит исходной строке таблицы.");
      if (edits.has(key)) fail("Ячейка изменена несколько раз.");
      edits.add(key);
    }
    for (const filter of table.filters ?? [])
      if (
        !columns.has(filter.columnId) ||
        (!["isNull", "notNull"].includes(filter.op) &&
          filter.value === undefined)
      )
        fail("Неверный фильтр таблицы.");
    if (table.sort && !columns.has(table.sort.columnId))
      fail("Столбец сортировки не найден.");
    for (const column of table.columns)
      if (
        column.type !== "number" &&
        ["sum", "avg"].includes(column.summary ?? "")
      )
        fail("Сумма и среднее доступны числовым столбцам.");
    if (
      new TextEncoder().encode(JSON.stringify(table)).byteLength >
      VISUAL_TABLE_LIMITS.specBytes
    )
      fail("Настройки и локальные правки таблицы превышают 1 MiB.");
  });
export function visualTableSourceSchema(columns: Column[]): string {
  return JSON.stringify(columns.map((c) => [c.id, c.name, c.type]));
}
export function createEmptyVisualTable(): VisualTableSpec {
  const columns: VisualTableColumn[] = ["text", "number", "number"].map(
    (type, i) => ({
      id: crypto.randomUUID(),
      name: `Столбец ${i + 1}`,
      type: type as VisualTableColumn["type"],
    }),
  );
  return {
    version: 1,
    columns,
    rows: Array.from({ length: 5 }, () => ({
      id: crypto.randomUUID(),
      values: {},
    })),
    edits: [],
  };
}
export function createResultVisualTable(result: ResultSet): VisualTableSpec {
  const names = new Set<string>();
  const columns = result.columns.map((column): VisualTableColumn => {
    let name = column.name.trim() || "Столбец",
      suffix = 2;
    while (names.has(name.toLocaleLowerCase()))
      name = `${column.name} (${suffix++})`;
    names.add(name.toLocaleLowerCase());
    return {
      id: column.id,
      sourceColumnId: column.id,
      name,
      type: isNumericColumn(column)
        ? "number"
        : /^(?:(?:Nullable|LowCardinality)\(\s*)*(?:Bool|Boolean)(?:\)|$)/i.test(
              column.type,
            )
          ? "boolean"
          : "text",
    };
  });
  return visualTableSpecSchema.parse({
    version: 1,
    sourceResultSetId: result.id,
    sourceSchema: visualTableSourceSchema(result.columns),
    columns,
    edits: [],
  });
}
export function renameVisualTableColumn(
  table: VisualTableSpec,
  id: string,
  name: string,
): VisualTableSpec {
  if (!table.columns.some((c) => c.id === id))
    throw new Error("Столбец не найден.");
  return visualTableSpecSchema.parse({
    ...table,
    columns: table.columns.map((c) => ({
      ...c,
      ...(c.id === id ? { name } : {}),
      ...(c.formula === undefined
        ? {}
        : {
            formula: renameVisualFormulaReferences(
              c.formula,
              table.columns,
              id,
              name.trim(),
            ),
          }),
    })),
  });
}
export function setVisualTableCell(
  table: VisualTableSpec,
  rowId: string,
  columnId: string,
  value: VisualTableScalar,
): VisualTableSpec {
  return visualTableSpecSchema.parse({
    ...table,
    edits: [
      ...table.edits.filter(
        (e) => e.rowId !== rowId || e.columnId !== columnId,
      ),
      { rowId, columnId, value },
    ],
  });
}
