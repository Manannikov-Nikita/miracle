import type { Cell, Column } from "./types.js";

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
}

export type CustomChartRenderState = "rendering" | "rendered" | "error";

export interface CustomChartReportInput {
  browserId: string;
  sequence: number;
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
