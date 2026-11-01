import {
  CUSTOM_CHART_LIMITS as limits,
  type CustomChartData,
} from "../shared/custom-charts.js";
import type { Cell, Column } from "../shared/types.js";
import { problem } from "./project-store.js";

export function checkCustomChartMetadata(
  rowCount: number,
  columnCount: number,
) {
  if (rowCount > limits.rows || rowCount * columnCount > limits.cells)
    throw problem(
      422,
      "Кастомный график допускает не более 5000 строк и 100 000 ячеек. Агрегируйте данные в SQL",
      "CUSTOM_CHART_DATA_TOO_LARGE",
    );
}

export function customChartData(
  columns: Column[],
  rows: Cell[][],
  expectedRows: number,
): CustomChartData {
  checkCustomChartMetadata(expectedRows, columns.length);
  if (rows.length !== expectedRows)
    throw problem(
      422,
      "Снимок неполный. Повторите исходный SQL перед построением графика",
      "CUSTOM_CHART_INCOMPLETE",
    );
  const data = { columns, rows };
  if (
    rows.length > limits.rows ||
    rows.reduce((count, row) => count + row.length, 0) > limits.cells ||
    Buffer.byteLength(JSON.stringify(data), "utf8") > limits.dataBytes
  )
    throw problem(
      422,
      "Кастомный график допускает не более 5000 строк, 100 000 ячеек и 5 MiB данных. Агрегируйте данные в SQL",
      "CUSTOM_CHART_DATA_TOO_LARGE",
    );
  return data;
}
