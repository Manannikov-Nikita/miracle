import type { DateRangeOptions, DateBatchProgress } from "./date-batch.js";
export type {
  DateRangeOptions,
  DateGranularity,
  DateBatchItem,
  DateBatchProgress,
} from "./date-batch.js";
import type { TableSpec } from "./tableTypes.js";
export type { TableSpec, TableColumnOptions } from "./tableTypes.js";
export type Engine = "clickhouse" | "trino";
export interface ClickHouseOptions {
  requestTimeoutMs?: number;
  compression?: boolean;
  settings?: Record<string, string>;
  tls?: {
    certificateAuth?: boolean;
    caCert?: string | null;
    clientCert?: string | null;
    clientKey?: string | null;
  } | null;
}
export interface ClickHousePublicOptions {
  requestTimeoutMs?: number;
  compression?: boolean;
  settings?: Record<string, string>;
  tls?: {
    certificateAuth?: boolean;
    hasCaCert: boolean;
    hasClientCert: boolean;
    hasClientKey: boolean;
  };
}
export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  url: string;
  username: string;
  database?: string;
  catalog?: string;
  schema?: string;
  hasPassword: boolean;
  clickhouse?: ClickHousePublicOptions;
  createdAt?: string;
}
export interface ConnectionInput {
  name: string;
  engine: Engine;
  url: string;
  username: string;
  password?: string;
  database?: string;
  catalog?: string;
  schema?: string;
  clickhouse?: ClickHouseOptions | null;
}
export interface SchemaTable {
  catalog?: string;
  schema: string;
  name: string;
  columns?: { name: string; type: string }[];
}
export interface SqlFunction {
  name: string;
  isAggregate: boolean;
  description?: string;
  syntax?: string;
}
export interface SqlFunctionCatalog {
  functions: SqlFunction[];
  aggregateCombinators: string[];
}
export interface QuerySource {
  dateRange?: DateRangeOptions;
  connectionId: string;
  sql: string;
  database?: string;
  catalog?: string;
  schema?: string;
}
export interface QueryDocument extends QuerySource {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
}
export interface Column {
  id: string;
  name: string;
  type: string;
}
export type Cell =
  string | number | boolean | null | Cell[] | { [key: string]: Cell };
export interface ResultSet {
  id: string;
  columns: Column[];
  rowCount: number;
  byteCount: number;
  createdAt: string;
  source: QuerySource;
}
export interface ResultPage {
  result: ResultSet;
  rows: Cell[][];
  offset: number;
  total: number;
}
export type RunStatus =
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface QueryRun {
  batch?: DateBatchProgress;
  id: string;
  status: RunStatus;
  source: QuerySource;
  resultSetId?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  rowCount?: number;
  elapsedMs?: number;
  progress?: string;
}
export type ChartKind = "bar" | "line" | "area" | "scatter";
export interface ChartSpec {
  kind: ChartKind;
  orientation?: "vertical" | "horizontal";
  x: string;
  y: string[];
  series?: string;
  stacked?: boolean;
  legend: boolean;
  legendPosition?: "top" | "bottom" | "left" | "right";
  legendAlign?: "start" | "center" | "end";
  xLabel?: string;
  yLabel?: string;
  numberFormat?: "auto" | "integer" | "decimal" | "percent" | "compact";
  sort?: "none" | "asc" | "desc";
}
export interface BoardNodeData {
  title: string;
  kind: "result" | "note" | "markdown";
  text?: string;
  color?: string;
  resultSetId?: string;
  source?: QuerySource;
  sourceRevision?: number;
  view?: "table" | "chart";
  chart?: ChartSpec;
  visibleColumns?: string[];
  table?: TableSpec;
  [key: string]: unknown;
}
export interface BoardNode {
  id: string;
  type: "artifact";
  position: { x: number; y: number };
  data: BoardNodeData;
  width?: number;
  height?: number;
}
export type BoardHandleSide = "top" | "right" | "bottom" | "left";
export interface BoardEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: BoardHandleSide;
  targetHandle?: BoardHandleSide;
  label?: string;
}
export interface BoardDocument {
  schemaVersion: 1;
  nodes: BoardNode[];
  edges: BoardEdge[];
  viewport?: { x: number; y: number; zoom: number };
}
export interface Board {
  id: string;
  name: string;
  revision: number;
  document: BoardDocument;
  updatedAt: string;
}
export interface BoardSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
}
export interface ApiError {
  error: string;
  code?: string;
}
