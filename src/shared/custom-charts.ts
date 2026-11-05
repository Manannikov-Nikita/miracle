import type { Cell, Column } from "./types.js";
import type { TableColor, TableSpec } from "./tableTypes.js";

export const CUSTOM_CHART_LIMITS = {
  description: 4000,
  html: 100000,
  css: 100000,
  javascript: 200000,
  sourceBytes: 256 * 1024,
  boardBytes: 1.5 * 1024 * 1024,
  rows: 5000,
  cells: 100000,
  dataBytes: 5 * 1024 * 1024,
  reportMessage: 4000,
  reportTtlMs: 60000,
  maxReports: 1000,
} as const;

export interface CustomChartSpec {
  version: 1;
  description: string;
  html: string;
  css: string;
  javascript: string;
}

export interface CustomChartData {
  columns: Column[];
  rows: Cell[][];
  displayRows?: string[][];
  cellColors?: (TableColor | null)[][];
}

export type CustomChartRenderState = "rendering" | "rendered" | "error";

export interface CustomChartReportInput {
  browserId: string;
  sequence: number;
  /** Parent-created Unix milliseconds; retained unchanged across request retries. */
  sentAt: number;
  resultSetId: string;
  specHash: string;
  status: CustomChartRenderState;
  stage?: string;
  message?: string;
}

export interface CustomChartReport extends CustomChartReportInput {
  observedAt: string;
}

export interface CustomChartStatus {
  status: CustomChartRenderState | "not_observed";
  reports: CustomChartReport[];
}

/** Stable UTF-8 input for SHA-256 in Node and WebCrypto, independent of key order. */
export function serializeCustomChart(spec: CustomChartSpec): string {
  return JSON.stringify([
    spec.version,
    spec.description,
    spec.html,
    spec.css,
    spec.javascript,
  ]);
}

/** A render identity also includes the table presentation consumed by the chart. */
export function serializeCustomChartPresentation(
  spec: CustomChartSpec,
  table?: TableSpec,
  visibleColumns?: string[],
): string {
  if (table === undefined && visibleColumns === undefined)
    return serializeCustomChart(spec);
  return JSON.stringify(
    [serializeCustomChart(spec), table, visibleColumns],
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
  );
}
