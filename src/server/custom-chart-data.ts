import {
  CUSTOM_CHART_LIMITS as limits,
  type CustomChartData,
} from "../shared/custom-charts.js";
import type { Cell, Column } from "../shared/types.js";
import type { TableSpec } from "../shared/tableTypes.js";
import { formatTableCell, prepareTableData } from "../shared/tableModel.js";
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

export function checkTableSourceMetadata(
  rowCount: number,
  columnCount: number,
  byteCount: number,
) {
  if (
    rowCount > 50000 ||
    rowCount * columnCount > 1000000 ||
    byteCount > 20 * 1024 * 1024
  )
    throw problem(
      422,
      "Для преобразований таблицы допустимы 50 000 строк, 20 MiB и 1 000 000 ячеек. Сократите результат в SQL.",
      "TABLE_DATA_TOO_LARGE",
    );
}

export function preparedCustomChartData(
  columns: Column[],
  rows: Cell[][],
  expectedRows: number,
  table?: TableSpec,
  visibleColumns?: string[],
): CustomChartData {
  checkTableSourceMetadata(
    expectedRows,
    columns.length,
    Buffer.byteLength(JSON.stringify({ columns, rows }), "utf8"),
  );
  if (rows.length !== expectedRows)
    throw problem(
      422,
      "Снимок неполный. Повторите исходный SQL перед построением графика",
      "CUSTOM_CHART_INCOMPLETE",
    );
  let prepared;
  try {
    prepared = prepareTableData(columns, rows, table, visibleColumns);
  } catch (error) {
    throw problem(
      422,
      error instanceof Error ? error.message : String(error),
      "CUSTOM_CHART_TABLE_INVALID",
    );
  }
  checkCustomChartMetadata(prepared.rows.length, prepared.columns.length);
  const formatted = prepared.rows.map((row) =>
    row.map((value, index) =>
      formatTableCell(
        value,
        prepared.columns[index],
        prepared.columns[index].options,
      ),
    ),
  );
  const data: CustomChartData = {
    columns: prepared.columns.map(({ id, name, type }) => ({ id, name, type })),
    rows: prepared.rows,
    displayRows: formatted.map((row) => row.map((value) => value.text)),
    cellColors: formatted.map((row) => row.map((value) => value.color ?? null)),
  };
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > limits.dataBytes)
    throw problem(
      422,
      "Кастомный график допускает не более 5 MiB данных с оформлением. Сократите результат или настройки таблицы.",
      "CUSTOM_CHART_DATA_TOO_LARGE",
    );
  return data;
}
