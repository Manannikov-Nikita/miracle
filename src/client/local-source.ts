import type { Connection, Engine, QuerySource } from "../shared/types";

export const LOCAL_SOURCE_ID = "__local__";
export const LOCAL_SOURCE_NAME = "Файлы и датасеты проекта";
export type SqlSourceConnection = Omit<Connection, "engine"> & {
  engine: Engine;
};
export const localSourceConnection: SqlSourceConnection = {
  id: LOCAL_SOURCE_ID,
  name: LOCAL_SOURCE_NAME,
  engine: "duckdb",
  url: "",
  username: "",
  hasPassword: false,
};

export function sourceConnectionId(source: {
  kind?: QuerySource["kind"];
  connectionId?: string;
}): string {
  return source.kind === "local"
    ? LOCAL_SOURCE_ID
    : (source.connectionId ?? "");
}

export function querySourceForConnection(
  connection: SqlSourceConnection,
  tab: { database?: string; catalog?: string; schema?: string },
  sql: string,
): QuerySource {
  return connection.id === LOCAL_SOURCE_ID
    ? { kind: "local", sql }
    : {
        connectionId: connection.id,
        sql,
        database: tab.database ?? connection.database,
        catalog: tab.catalog ?? connection.catalog,
        schema: tab.schema ?? connection.schema,
      };
}
