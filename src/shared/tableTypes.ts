import type { Cell, Column } from "./types.js";

export type TableColor = "green" | "yellow" | "red" | "blue" | "purple";
export type TableAggregate = "sum" | "avg" | "min" | "max" | "count";
export type TableFormat =
  | "auto"
  | "number"
  | "compact"
  | "percent"
  | "percent100"
  | "currency"
  | "date"
  | "datetime"
  | "duration"
  | "text";
export interface TableColumnOptions {
  label?: string;
  hidden?: boolean;
  width?: number;
  align?: "left" | "center" | "right";
  format?: TableFormat;
  decimals?: number;
  currency?: "RUB" | "USD" | "EUR";
  prefix?: string;
  suffix?: string;
  nullText?: string;
  display?: "auto" | "color-text" | "color-background" | "bar";
  thresholds?: { value: string; color: TableColor }[];
  mappings?: { value: string | null; text: string; color?: TableColor }[];
  summary?: TableAggregate | "none";
}
export interface TableFilter {
  column: string;
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
}
export interface TableSpec {
  version: 1;
  sourceSchema: string;
  columns?: Record<string, TableColumnOptions>;
  order?: string[];
  filters?: TableFilter[];
  sort?: { column: string; direction: "asc" | "desc" };
  pivot?: {
    row: string;
    column: string;
    value: string;
    aggregate: TableAggregate;
  };
  density?: "compact" | "comfortable";
  frozenColumns?: number;
  wrap?: boolean;
}
export interface TableViewColumn extends Column {
  sourceId: string;
  options: TableColumnOptions;
}
export interface TableViewData {
  columns: TableViewColumn[];
  rows: Cell[][];
  sourceRowCount: number;
  filteredRowCount: number;
  summaries: Record<string, Cell>;
  ranges: Record<string, { min: string; max: string }>;
}
