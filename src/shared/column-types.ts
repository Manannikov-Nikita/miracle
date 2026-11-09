import type { Column } from "./types.js";

const numericType =
  /^(?:(?:Nullable|LowCardinality)\(\s*)*(?:U?Int\d+|Float\d+|Decimal(?:32|64|128|256)?|DOUBLE(?: PRECISION)?|REAL|NUMERIC|BIGINT|SMALLINT|TINYINT|INTEGER|INT)(?=\s*(?:[(),]|$))/i;
export function isNumericColumn(column: Column) {
  return numericType.test(column.type);
}

const dateType =
  /^(?:(?:Nullable|LowCardinality)\(\s*)*(?:Date(?:32)?|DateTime(?:64)?|TIMESTAMP(?:TZ)?)(?=\s*(?:[(),]|with\b|without\b|$))/i;

/** A display format does not change the semantic type of a column. */
export function isDateColumn(
  column: Column,
  dataType?: "auto" | "date",
): boolean {
  return dataType === "date" || dateType.test(column.type.trim());
}
