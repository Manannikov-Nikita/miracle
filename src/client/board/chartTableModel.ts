import type { ChartSpec, Column } from "../../shared/types";
import type { TableColor, TableViewData } from "../../shared/tableTypes";
import { formatTableCell, prepareTableData } from "../../shared/tableModel";
import {
  chartNumber,
  chartSeries,
  defaultChart,
  isNumericColumn,
} from "./model";
import { formatChartNumber } from "./chartOptions";

export const chartTableData = prepareTableData;

const tableColors: Record<TableColor, string> = {
  green: "#91cbb3",
  yellow: "#e7bd7e",
  red: "#ef9c9c",
  blue: "#91b5ff",
  purple: "#c5a4eb",
};

/** Repair references removed by a table transformation; keep explicit choices. */
export function normalizeChartSpec(
  columns: Column[],
  saved?: ChartSpec,
): ChartSpec {
  const defaults = defaultChart(columns);
  if (!saved) return defaults;
  const exists = (id: string) => columns.some((column) => column.id === id);
  const y = saved.y.filter(exists);
  return {
    ...saved,
    x: exists(saved.x)
      ? saved.x
      : saved.kind === "scatter"
        ? (columns.find(isNumericColumn)?.id ?? defaults.x)
        : defaults.x,
    y: saved.y.length && !y.length ? defaults.y : y,
    series: saved.series && exists(saved.series) ? saved.series : undefined,
  };
}

export function tableChartSeries(table: TableViewData, spec: ChartSpec) {
  const options = new Map(
    table.columns.map((column) => [column.id, column.options]),
  );
  return chartSeries(table.columns, table.rows, spec, (value, column, role) => {
    const settings = options.get(column.id) ?? {};
    const display = formatTableCell(value, column, settings);
    const explicitText =
      (settings.format && settings.format !== "auto") ||
      settings.prefix ||
      settings.suffix ||
      settings.mappings?.some(
        (mapping) => mapping.value === (value === null ? null : String(value)),
      );
    const chartFormat =
      role === "metric" &&
      value !== null &&
      !explicitText &&
      spec.numberFormat &&
      spec.numberFormat !== "auto";
    return {
      text: chartFormat
        ? formatChartNumber(chartNumber(value, column)!, spec.numberFormat)
        : display.text,
      color:
        display.color && settings.display && settings.display !== "auto"
          ? tableColors[display.color]
          : undefined,
    };
  });
}
