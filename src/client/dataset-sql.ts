import type { QuerySource, SchemaTable } from "../shared/types";

export function datasetQuery(name: string): QuerySource {
  return {
    kind: "local",
    sql: `SELECT *\nFROM "${name.replaceAll('"', '""')}"\nLIMIT 100;`,
  };
}

export function datasetTables(
  datasets: readonly {
    name: string;
    columns: readonly { name: string; duckdbType: string }[];
  }[],
): SchemaTable[] {
  return datasets.map(({ name, columns }) => ({
    schema: "",
    name,
    columns: columns.map(({ name, duckdbType }) => ({
      name,
      type: duckdbType,
    })),
  }));
}

const fileReaders: Record<string, string> = {
  csv: "read_csv",
  tsv: "read_csv",
  parquet: "read_parquet",
  json: "read_json",
  jsonl: "read_json",
  xlsx: "read_xlsx",
};

export function projectFileReader(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(fileReaders, extension)
    ? fileReaders[extension]
    : undefined;
}

export function projectFileQuery(
  path: string,
  sheet?: string,
): QuerySource | undefined {
  const reader = projectFileReader(path);
  if (!reader) return;
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const sheetArgument =
    reader === "read_xlsx" && sheet ? `, sheet = ${literal(sheet)}` : "";
  return {
    kind: "local",
    sql: `SELECT *\nFROM ${reader}(${literal(path)}${sheetArgument})\nLIMIT 100;`,
  };
}
