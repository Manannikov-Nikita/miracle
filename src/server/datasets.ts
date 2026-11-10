import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  DATASET_NAME_PATTERN,
  suggestDatasetName,
  type Dataset,
  type DatasetColumn,
} from "../shared/datasets.js";
import type { Column, QuerySource } from "../shared/types.js";
import type { Database } from "./db.js";
import { problem } from "./project-store.js";

export const datasetNameSchema = z.string().trim().regex(DATASET_NAME_PATTERN, {
  error:
    "Имя набора данных должно содержать до 63 латинских букв, цифр или знаков подчёркивания и не может начинаться с цифры",
});
export const datasetRevisionSchema = z.object({
  baseRevision: z.number().int().positive(),
  mutationId: z.uuid().optional(),
});

type DatasetRow = {
  id: string;
  name: string;
  revision: number;
  result_set_id: string;
  source: QuerySource;
  columns: DatasetColumn[];
  created_at: string;
  updated_at: string;
};

function datasetDto(row: DatasetRow): Dataset {
  return {
    id: row.id,
    name: row.name,
    revision: row.revision,
    resultSetId: row.result_set_id,
    source: row.source,
    columns: row.columns,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const scalarTypes = new Map(
  Object.entries({
    bool: "BOOLEAN",
    boolean: "BOOLEAN",
    int8: "TINYINT",
    int16: "SMALLINT",
    int32: "INTEGER",
    int64: "BIGINT",
    int128: "HUGEINT",
    uint8: "UTINYINT",
    uint16: "USMALLINT",
    uint32: "UINTEGER",
    uint64: "UBIGINT",
    uint128: "UHUGEINT",
    tinyint: "TINYINT",
    smallint: "SMALLINT",
    integer: "INTEGER",
    bigint: "BIGINT",
    hugeint: "HUGEINT",
    utinyint: "UTINYINT",
    usmallint: "USMALLINT",
    uinteger: "UINTEGER",
    ubigint: "UBIGINT",
    uhugeint: "UHUGEINT",
    float32: "FLOAT",
    float64: "DOUBLE",
    float: "FLOAT",
    real: "FLOAT",
    double: "DOUBLE",
    "double precision": "DOUBLE",
    date: "DATE",
    date32: "DATE",
    time: "TIME",
    timestamp_s: "TIMESTAMP_S",
    timestamp_ms: "TIMESTAMP_MS",
    timestamp_ns: "TIMESTAMP_NS",
    timestamptz: "TIMESTAMP WITH TIME ZONE",
    json: "JSON",
  }),
);

function timestampType(precision: number) {
  if (precision === 0) return "TIMESTAMP_S";
  if (precision <= 3) return "TIMESTAMP_MS";
  if (precision <= 6) return "TIMESTAMP";
  return precision <= 9 ? "TIMESTAMP_NS" : "VARCHAR";
}

function duckdbType(type: string): string {
  let value = type.trim().toLowerCase();
  for (
    let wrapper;
    (wrapper = /^(?:nullable|lowcardinality)\((.*)\)$/s.exec(value));
  )
    value = wrapper[1].trim();

  const fixedDecimal = /^decimal(32|64|128)\(\s*(\d+)\s*\)$/.exec(value);
  const decimal = /^(?:decimal|numeric)\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(
    value,
  );
  if (fixedDecimal || decimal) {
    const fixedPrecision: Record<string, number> = { 32: 9, 64: 18, 128: 38 };
    const precision = fixedDecimal
      ? fixedPrecision[fixedDecimal[1]]
      : Number(decimal![1]);
    const scale = Number(fixedDecimal ? fixedDecimal[2] : decimal![2]);
    if (precision >= 1 && precision <= 38 && scale <= precision)
      return `DECIMAL(${precision},${scale})`;
  }
  const datetime = /^datetime(?:64\(\s*(\d+)(?:\s*,.*)?\)|\(.*\))?$/.exec(
    value,
  );
  if (datetime) return timestampType(Number(datetime[1] ?? 0));
  const timestamp =
    /^timestamp(?:\(\s*(\d+)\s*\))?(?: (with|without) time zone)?$/.exec(value);
  if (timestamp) {
    const precision = Number(timestamp[1] ?? 6);
    return timestamp[2] === "with"
      ? precision <= 6
        ? "TIMESTAMP WITH TIME ZONE"
        : "VARCHAR"
      : timestampType(precision);
  }
  const time = /^time\(\s*(\d+)\s*\)$/.exec(value);
  if (time) return Number(time[1]) <= 6 ? "TIME" : "VARCHAR";
  if (/^(?:array|map|row|struct|tuple|nested|object)\(|\[\d*\]$/.test(value))
    return "JSON";
  // DuckDB's exact numeric domains do not cover wide ClickHouse numerics.
  // VARCHAR preserves those values and opaque source formats losslessly.
  return scalarTypes.get(value) ?? "VARCHAR";
}

function datasetColumns(
  columns: (Column & { duckdbType?: string; sourceName?: string })[],
): DatasetColumn[] {
  // Reserve source labels so a duplicate cannot steal an existing label's name.
  const reserved = new Set(columns.map((column) => column.name.toLowerCase()));
  const used = new Set<string>();
  return columns.map((column, index) => {
    const stem = column.name.replace(/\0/g, "") || `column_${index + 1}`;
    let name = stem;
    for (
      let suffix = 2;
      used.has(name.toLowerCase()) ||
      (name !== column.name && reserved.has(name.toLowerCase()));
      suffix++
    )
      name = `${stem}_${suffix}`;
    used.add(name.toLowerCase());
    return {
      id: column.id,
      name,
      sourceName: column.sourceName ?? column.name,
      type: column.type,
      duckdbType: column.duckdbType ?? duckdbType(column.type),
    };
  });
}

/** Metadata writes run inside the enclosing workspace mutation transaction. */
export class DatasetStore {
  constructor(private readonly db: Database) {}

  list(): Dataset[] {
    return this.db
      .query("SELECT * FROM datasets ORDER BY name")
      .rows.map(datasetDto);
  }

  find(id: string): Dataset | undefined {
    const row = this.db.query("SELECT * FROM datasets WHERE id=?1", [id])
      .rows[0];
    return row && datasetDto(row);
  }

  get(id: string): Dataset {
    const dataset = this.find(id);
    if (!dataset)
      throw problem(404, "Набор данных не найден", "DATASET_NOT_FOUND");
    return dataset;
  }

  private result(id: string) {
    const result = this.db.query(
      "SELECT source,columns FROM result_sets WHERE id=?1",
      [id],
    ).rows[0];
    if (!result) throw problem(404, "Результат запроса не найден");
    if (
      this.db.query(
        "SELECT id FROM query_runs WHERE result_set_id=?1 AND status IN ('running','cancelling','paused')",
        [id],
      ).rowCount
    )
      throw problem(
        409,
        "Дождитесь завершения или остановите пакет перед регистрацией набора данных",
      );
    return {
      source: result.source as QuerySource,
      columns: datasetColumns(result.columns),
    };
  }

  private checkName(name: string, id?: string) {
    if (
      this.db.query(
        "SELECT id FROM datasets WHERE name=?1 AND (?2 IS NULL OR id<>?2)",
        [name, id],
      ).rowCount
    )
      throw problem(
        409,
        "Набор данных с таким именем уже существует",
        "DATASET_NAME_CONFLICT",
      );
  }

  register(resultSetId: string, requestedName?: string, title = "") {
    const existing = this.db.query(
      "SELECT * FROM datasets WHERE result_set_id=?1",
      [resultSetId],
    ).rows[0];
    if (existing) return { dataset: datasetDto(existing), created: false };
    const name =
      requestedName ??
      suggestDatasetName(
        title,
        this.db.query("SELECT name FROM datasets").rows.map((row) => row.name),
      );
    this.checkName(name);
    const { source, columns } = this.result(resultSetId);
    const row = this.db.query(
      "INSERT INTO datasets(id,name,result_set_id,source,columns) VALUES(?1,?2,?3,?4,?5) RETURNING *",
      [randomUUID(), name, resultSetId, source, columns],
    ).rows[0];
    return { dataset: datasetDto(row), created: true };
  }

  atRevision(id: string, revision: number) {
    const current = this.get(id);
    if (current.revision !== revision)
      throw problem(
        409,
        "Набор данных изменён. Обновите его перед повтором операции",
        "REVISION_CONFLICT",
      );
    return current;
  }

  rename(current: Dataset, name: string): Dataset {
    if (current.name === name) return current;
    this.checkName(name, current.id);
    const row = this.db.query(
      "UPDATE datasets SET name=?2,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 RETURNING *",
      [current.id, name],
    ).rows[0];
    return datasetDto(row);
  }

  refresh(current: Dataset, resultSetId: string): Dataset {
    if (current.resultSetId === resultSetId) return current;
    if (
      this.db.query("SELECT id FROM datasets WHERE result_set_id=?1", [
        resultSetId,
      ]).rowCount
    )
      throw problem(
        409,
        "Этот результат уже используется другим набором данных",
        "DATASET_RESULT_CONFLICT",
      );
    const { source, columns } = this.result(resultSetId);
    const row = this.db.query(
      "UPDATE datasets SET result_set_id=?2,source=?3,columns=?4,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 RETURNING *",
      [current.id, resultSetId, source, columns],
    ).rows[0];
    return datasetDto(row);
  }

  delete(id: string) {
    this.db.query("DELETE FROM datasets WHERE id=?1", [id]);
  }
}
