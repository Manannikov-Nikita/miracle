import type { BoardImage } from "./board-images.js";
import type { DateRangeOptions, DateBatchProgress } from "./date-batch.js";
export type {
  DateRangeOptions,
  DateGranularity,
  DateBatchItem,
  DateBatchProgress,
} from "./date-batch.js";
import type { TableSpec } from "./tableTypes.js";
import type { CustomChartSpec } from "./custom-charts.js";
import type { ShapeSpec } from "./shapes.js";
import type { TextStyleSpec } from "./text-style.js";
export type { ShapeKind, ShapeSpec } from "./shapes.js";
export type { TextStyleSpec } from "./text-style.js";
export type { TableSpec, TableColumnOptions } from "./tableTypes.js";
export type RemoteEngine = "clickhouse" | "trino";
export type Engine = RemoteEngine | "duckdb";
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
export interface TrinoOptions {
  externalAuthentication?: boolean;
  tls?: { caCert?: string | null } | null;
}
export interface TrinoPublicOptions {
  externalAuthentication?: boolean;
  tls?: { hasCaCert: boolean };
}
export interface Connection {
  id: string;
  name: string;
  engine: RemoteEngine;
  url: string;
  username: string;
  database?: string;
  catalog?: string;
  schema?: string;
  hasPassword: boolean;
  clickhouse?: ClickHousePublicOptions;
  trino?: TrinoPublicOptions;
  createdAt?: string;
}
export interface ConnectionInput {
  name: string;
  engine: RemoteEngine;
  url: string;
  username: string;
  password?: string;
  database?: string;
  catalog?: string;
  schema?: string;
  clickhouse?: ClickHouseOptions | null;
  trino?: TrinoOptions | null;
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
export interface RemoteQuerySource {
  kind?: "remote";
  dateRange?: DateRangeOptions;
  connectionId: string;
  sql: string;
  database?: string;
  catalog?: string;
  schema?: string;
}
export interface LocalQuerySource {
  kind: "local";
  sql: string;
  connectionId?: never;
  database?: never;
  catalog?: never;
  schema?: never;
  dateRange?: never;
}
export type QuerySource = RemoteQuerySource | LocalQuerySource;
export type QueryDocument = QuerySource & {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
};
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
  | "paused"
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
  showXAxis?: boolean;
  showYAxis?: boolean;
  showGrid?: boolean;
  showLabels?: boolean;
  showTotals?: boolean;
  labelPosition?: "auto" | "outside" | "inside";
  palette?: "default" | "cool" | "warm" | "vivid";
  /** Colors by stable metric / breakdown identity, independent of row order. */
  seriesColors?: Record<string, string>;
  xLabel?: string;
  yLabel?: string;
  numberFormat?: "auto" | "integer" | "decimal" | "percent" | "compact";
  sort?: "none" | "asc" | "desc";
}
export interface BoardNodeData {
  title: string;
  kind: "result" | "note" | "markdown" | "shape" | "text" | "image";
  image?: BoardImage;
  text?: string;
  textStyle?: TextStyleSpec;
  shape?: ShapeSpec;
  color?: string;
  resultSetId?: string;
  datasetId?: string;
  datasetRevision?: number;
  datasetName?: string;
  publishDataset?: boolean;
  source?: QuerySource;
  sourceRevision?: number;
  view?: "table" | "chart" | "custom";
  chart?: ChartSpec;
  customChart?: CustomChartSpec;
  visibleColumns?: string[];
  table?: TableSpec;
  [key: string]: unknown;
}
export interface BoardNode {
  id: string;
  slideId?: string;
  type: "artifact";
  position: { x: number; y: number };
  data: BoardNodeData;
  width?: number;
  height?: number;
}
export type BoardHandleSide = "top" | "right" | "bottom" | "left";
export interface BoardEdgeAppearance {
  path?: "smoothstep" | "straight" | "bezier";
  line?: "solid" | "dashed" | "dotted";
  color?: string;
  width?: 1 | 2 | 3;
  startArrow?: boolean;
  endArrow?: boolean;
}
export interface BoardEdgePoint {
  x: number;
  y: number;
}
export interface BoardEdge {
  id: string;
  slideId?: string;
  source?: string;
  target?: string;
  sourcePoint?: BoardEdgePoint;
  targetPoint?: BoardEdgePoint;
  /** Manual bend offset from the endpoint midpoint; absent uses automatic routing. */
  bend?: BoardEdgePoint;
  sourceHandle?: BoardHandleSide;
  targetHandle?: BoardHandleSide;
  label?: string;
  labelPosition?: number;
  appearance?: BoardEdgeAppearance;
}
export type BoardKind = "board" | "presentation";
export interface PresentationSlide {
  id: string;
  title: string;
  background: string;
}
export interface BoardDocument {
  schemaVersion: 1;
  kind?: BoardKind;
  slides?: PresentationSlide[];
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
  kind?: BoardKind;
  name: string;
  revision: number;
  updatedAt: string;
}
export interface ApiError {
  error: string;
  code?: string;
  details?: string;
}
