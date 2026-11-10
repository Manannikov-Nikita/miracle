import {
  DuckDBArrayType,
  DuckDBBlobValue,
  DuckDBListType,
  DuckDBListVector,
  DuckDBMapType,
  DuckDBStructType,
  DuckDBTypeId,
  DuckDBUnionType,
  DuckDBVector,
  JsonDuckDBValueConverter,
  UTINYINT,
  VARCHAR,
  type DuckDBAppender,
  type DuckDBDataChunk,
  type DuckDBResult,
  type DuckDBType,
  type DuckDBValueConverter,
} from "@duckdb/node-api";
import native, { type Vector } from "@duckdb/node-bindings";
import { parse } from "lossless-json";
import type { Cell } from "../shared/types.js";
import type { LocalQueryColumn } from "./local-query.js";
import { foldDuckDBName } from "./duckdb-inputs.js";

const scalarTypes = new Set([
  "BOOLEAN",
  "TINYINT",
  "SMALLINT",
  "INTEGER",
  "BIGINT",
  "HUGEINT",
  "BIGNUM",
  "UTINYINT",
  "USMALLINT",
  "UINTEGER",
  "UBIGINT",
  "UHUGEINT",
  "FLOAT",
  "DOUBLE",
  "DATE",
  "TIME",
  "TIME_NS",
  "TIME WITH TIME ZONE",
  "TIMESTAMP",
  "TIMESTAMP_S",
  "TIMESTAMP_MS",
  "TIMESTAMP_NS",
  "TIMESTAMP WITH TIME ZONE",
  "TIMESTAMPTZ_NS",
  "UUID",
  "INTERVAL",
  "BIT",
  "BLOB",
  "VARCHAR",
  "JSON",
]);
const isSafeType = (type: string) =>
  scalarTypes.has(type) || /^DECIMAL\(\d{1,2},\s?\d{1,2}\)$/.test(type);
const displayTypes: Record<string, string> = {
  UTINYINT: "UInt8",
  USMALLINT: "UInt16",
  UINTEGER: "UInt32",
  UBIGINT: "UInt64",
  UHUGEINT: "UInt128",
  HUGEINT: "Int128",
  BIGNUM: "Decimal",
  FLOAT: "Float32",
  TIMESTAMP_S: "TIMESTAMP",
  TIMESTAMP_MS: "TIMESTAMP",
  TIMESTAMP_NS: "TIMESTAMP",
  TIMESTAMPTZ_NS: "TIMESTAMPTZ",
};
const nestedTypes = new Set([
  DuckDBTypeId.LIST,
  DuckDBTypeId.ARRAY,
  DuckDBTypeId.STRUCT,
  DuckDBTypeId.MAP,
  DuckDBTypeId.UNION,
  DuckDBTypeId.VARIANT,
]);

function datasetType(type: DuckDBType) {
  if (type.alias === "JSON" || nestedTypes.has(type.typeId)) return "JSON";
  const name = type.toString();
  return isSafeType(name) ? name : "VARCHAR";
}

export function queryColumns(
  result: DuckDBResult,
  types: readonly DuckDBType[],
): LocalQueryColumn[] {
  const names = result.columnNames();
  const reserved = new Set(names.filter(Boolean).map(foldDuckDBName));
  const used = new Set<string>();
  return names.map((sourceName, index) => {
    const stem = sourceName || `column_${index + 1}`;
    let name = stem;
    if (
      used.has(foldDuckDBName(stem)) ||
      (!sourceName && reserved.has(foldDuckDBName(stem)))
    ) {
      let suffix = 2;
      do {
        name = `${stem}_${suffix++}`;
      } while (
        used.has(foldDuckDBName(name)) ||
        reserved.has(foldDuckDBName(name))
      );
    }
    used.add(foldDuckDBName(name));
    const duckdbType = datasetType(types[index]!);
    return {
      id: String(index),
      name,
      sourceName,
      type: displayTypes[duckdbType] || duckdbType,
      duckdbType,
    };
  });
}

const readDuckDBCell: DuckDBValueConverter<Cell> = (value, type, converter) => {
  if (value === null) return null;
  if (typeof value === "bigint")
    return Number.isSafeInteger(Number(value))
      ? Number(value)
      : value.toString();
  if (value instanceof DuckDBBlobValue)
    return Buffer.from(value.bytes).toString("base64");
  if (type.typeId === DuckDBTypeId.INTERVAL) return String(value);
  if (type.alias === "JSON" && typeof value === "string") {
    return parse(value, null, (text) => {
      const number = Number(text);
      return String(number) === text &&
        (!Number.isInteger(number) || Number.isSafeInteger(number))
        ? number
        : text;
    }) as Cell;
  }
  return JsonDuckDBValueConverter(value, type, converter);
};

type CellReader = (index: number) => Cell;

function nullableReader(
  vector: Vector,
  count: number,
  read: CellReader,
): CellReader {
  const validity = native.vector_get_validity(
    vector,
    Math.ceil(count / 64) * 8,
  );
  return validity
    ? (index) =>
        validity[index >> 3]! & (1 << (index & 7)) ? read(index) : null
    : read;
}

function vectorReader(
  vector: Vector,
  count: number,
  type: DuckDBType,
): CellReader {
  if (type instanceof DuckDBStructType) {
    const entries = type.entryTypes.map((entry, i) =>
      vectorReader(native.struct_vector_get_child(vector, i), count, entry),
    );
    // The binding's struct decoder assigns to ordinary object properties.
    // Reading children by position retains literal keys such as __proto__.
    return nullableReader(
      vector,
      count,
      type.isTuple
        ? (index) => entries.map((read) => read(index))
        : (index) =>
            Object.fromEntries(
              entries.map((read, i) => [type.entryNames[i]!, read(index)]),
            ),
    );
  }
  if (type instanceof DuckDBMapType) {
    return vectorReader(
      vector,
      count,
      new DuckDBListType(
        new DuckDBStructType(["key", "value"], [type.keyType, type.valueType]),
      ),
    );
  }
  if (type instanceof DuckDBListType) {
    const list = DuckDBListVector.fromRawVector(type, vector, count);
    const read = vectorReader(
      native.list_vector_get_child(vector),
      native.list_vector_get_size(vector),
      type.valueType,
    );
    return nullableReader(vector, count, (index) => {
      const offset = list.getEntryOffset(index);
      return Array.from({ length: list.getEntryLength(index) }, (_, i) =>
        read(offset + i),
      );
    });
  }
  if (type instanceof DuckDBArrayType) {
    const read = vectorReader(
      native.array_vector_get_child(vector),
      count * type.length,
      type.valueType,
    );
    return nullableReader(vector, count, (index) =>
      Array.from({ length: type.length }, (_, i) =>
        read(index * type.length + i),
      ),
    );
  }
  if (type instanceof DuckDBUnionType) {
    const tag = DuckDBVector.create(
      native.struct_vector_get_child(vector, 0),
      count,
      UTINYINT,
    );
    const members = type.memberTypes.map((member, i) =>
      vectorReader(
        native.struct_vector_get_child(vector, i + 1),
        count,
        member,
      ),
    );
    return nullableReader(vector, count, (index) => {
      const member = tag.getItem(index);
      if (member === null) return null;
      const i = Number(member);
      return { tag: type.memberTags[i]!, value: members[i]!(index) };
    });
  }
  const scalar = DuckDBVector.create(vector, count, type);
  const read: CellReader = (index) =>
    readDuckDBCell(scalar.getItem(index), type, readDuckDBCell);
  if (type.typeId !== DuckDBTypeId.VARIANT) return read;

  // Dynamic VARIANT values carry their object keys in their first physical
  // child. Check before the upstream decoder can drop the field.
  const keys = DuckDBListVector.fromRawVector(
    new DuckDBListType(VARCHAR),
    native.struct_vector_get_child(vector, 0),
    count,
  );
  return nullableReader(vector, count, (index) => {
    const start = keys.getEntryOffset(index);
    const end = start + keys.getEntryLength(index);
    for (let key = start; key < end; key++) {
      if (keys.childVector.getItem(key) === "__proto__")
        throw new Error(
          "Для VARIANT с полем __proto__ используйте CAST(значение AS VARCHAR)",
        );
    }
    return read(index);
  });
}

export function queryChunkReaders(
  chunk: DuckDBDataChunk,
  types: readonly DuckDBType[],
) {
  // The result metadata retains logical aliases such as JSON that are absent
  // on the physical chunk vectors.
  return types.map((type, index) =>
    vectorReader(
      native.data_chunk_get_vector(chunk.chunk, index),
      chunk.rowCount,
      type,
    ),
  );
}

export const quoteDuckDBIdentifier = (name: string) =>
  '"' + name.replaceAll('"', '""') + '"';

export function datasetColumnDefinitions(columns: readonly LocalQueryColumn[]) {
  return columns
    .map(({ name, duckdbType }) => {
      if (!isSafeType(duckdbType))
        throw new Error(
          `Неподдерживаемый тип набора данных DuckDB: ${duckdbType}`,
        );
      return `${quoteDuckDBIdentifier(name)} ${duckdbType}`;
    })
    .join(", ");
}

export function appendDuckDBCell(
  appender: DuckDBAppender,
  value: Cell,
  type: string,
) {
  if (value === null) appender.appendNull();
  else if (type === "BLOB" && typeof value === "string")
    appender.appendBlob(Buffer.from(value, "base64"));
  else if (type === "JSON" || typeof value === "object")
    appender.appendVarchar(JSON.stringify(value));
  else appender.appendVarchar(String(value));
}
