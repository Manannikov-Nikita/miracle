import type { Column } from "./types.js";

const numericType =
  /^(?:(?:Nullable|LowCardinality)\(\s*)*(?:U?Int\d+|Float\d+|Decimal(?:32|64|128|256)?|DOUBLE(?: PRECISION)?|REAL|NUMERIC|BIGINT|SMALLINT|TINYINT|INTEGER|INT)(?=\s*(?:[(),]|$))/i;
export function isNumericColumn(column: Column) {
  return numericType.test(column.type);
}
