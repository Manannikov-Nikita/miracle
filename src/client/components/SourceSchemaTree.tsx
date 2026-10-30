import { useReducer } from "react";
import {
  CaretDown,
  CaretRight,
  Database,
  Hash,
  Table,
  TextT,
} from "@phosphor-icons/react";
import type { Connection, QuerySource, SchemaTable } from "../../shared/types";
import {
  metadataSchemaKey,
  metadataTableKey,
  type MetadataSnapshot,
  type MetadataStore,
  type SchemaMetadata,
} from "../metadata-store";
import { Spinner } from "./UI";

export interface ExplorerSourceView {
  expandedSchemas: Set<string>;
  expandedTables: Set<string>;
  limits: Record<string, number>;
}

const pageSize = 100;
const schemaLabel = (scope: { catalog?: string; schema: string }) =>
  [scope.catalog, scope.schema].filter(Boolean).join(".");

export default function SourceSchemaTree({
  source,
  metadata,
  snapshot,
  views,
  filter,
  onOpenSource,
}: {
  source: Connection;
  metadata: MetadataStore;
  snapshot: MetadataSnapshot;
  views: Map<string, ExplorerSourceView>;
  filter: string;
  onOpenSource: (source: QuerySource) => void;
}) {
  const [, redraw] = useReducer((value) => value + 1, 0);
  if (!views.has(source.id))
    views.set(source.id, {
      expandedSchemas: new Set(),
      expandedTables: new Set(),
      limits: {},
    });
  const view = views.get(source.id)!;
  const search = filter.trim().toLocaleLowerCase();
  const tableLabel = (table: SchemaTable) =>
    `${schemaLabel(table)}.${table.name}`;
  const columnMatches = (column: { name: string; type: string }) =>
    `${column.name} ${column.type}`.toLocaleLowerCase().includes(search);
  const groups = snapshot.schemas
    .map((scope) => ({
      scope,
      tables: search
        ? scope.tables.filter(
            (table) =>
              tableLabel(table).toLocaleLowerCase().includes(search) ||
              table.columns?.some(columnMatches),
          )
        : scope.tables,
    }))
    .filter(
      ({ scope, tables }) =>
        !search ||
        tables.length ||
        schemaLabel(scope).toLocaleLowerCase().includes(search),
    );
  const schemaLimit = view.limits.schemas || pageSize;
  const searchLimit = view.limits[`search:${search}`] || pageSize;
  const searchCount = groups.reduce(
    (count, group) => count + group.tables.length,
    0,
  );
  const failedSchemas = snapshot.schemas.filter(
    (scope) => scope.error || scope.columnsError,
  );
  let searchRemaining = searchLimit;
  let searchColumnsRemaining = searchLimit;
  function changeLimit(key: string) {
    view.limits[key] = (view.limits[key] || pageSize) + pageSize;
    redraw();
  }
  function toggleSchema(scope: SchemaMetadata) {
    const key = metadataSchemaKey(scope);
    if (view.expandedSchemas.has(key)) view.expandedSchemas.delete(key);
    else {
      view.expandedSchemas.add(key);
      void metadata.loadTables(source.id, scope).catch(() => {});
    }
    redraw();
  }
  function toggleTable(table: SchemaTable) {
    const key = metadataTableKey(table);
    if (view.expandedTables.has(key)) view.expandedTables.delete(key);
    else {
      view.expandedTables.add(key);
      void metadata.loadColumns(source.id, table).catch(() => {});
    }
    redraw();
  }
  function openTable(table: SchemaTable) {
    onOpenSource({
      connectionId: source.id,
      sql: `SELECT *\nFROM ${[table.catalog, table.schema, table.name]
        .filter((part): part is string => Boolean(part))
        .map((part) => `"${part.replaceAll('"', '""')}"`)
        .join(".")}\nLIMIT 100;`,
      database: source.database,
      catalog: table.catalog || source.catalog,
      schema: table.schema,
    });
  }
  return (
    <>
      <div className="explorer-section-label schema-label">
        СХЕМЫ <span>{snapshot.schemas.length}</span>
      </div>
      {snapshot.status === "loading" && !snapshot.schemas.length && (
        <div className="explorer-loading" role="status">
          <Spinner /> Загружаем схемы…
        </div>
      )}
      {snapshot.error && (
        <div className="explorer-error" role="alert">
          {snapshot.error}
          <button
            className="text-button"
            onClick={() => metadata.refresh(source.id)}
          >
            Повторить
          </button>
        </div>
      )}
      {snapshot.background && (
        <div className="metadata-progress" role="status">
          <Spinner />{" "}
          <span>
            Загружаем объекты для поиска…
            <small>
              {
                snapshot.schemas.filter(
                  (scope) => scope.complete && scope.columnsComplete,
                ).length
              }{" "}
              из {snapshot.schemas.length} схем
            </small>
          </span>
        </div>
      )}
      {search && !snapshot.complete && (
        <div className="metadata-hint">
          Результаты дополняются по мере загрузки.
        </div>
      )}
      {failedSchemas.length > 0 && (
        <div className="explorer-error" role="alert">
          Не удалось полностью загрузить схемы: {failedSchemas.length}. Поиск
          пока охватывает только доступные объекты.
          <button
            className="text-button"
            onClick={() => {
              for (const scope of failedSchemas)
                void metadata.retrySchema(source.id, scope).catch(() => {});
            }}
          >
            Повторить загрузку
          </button>
        </div>
      )}
      {groups.slice(0, schemaLimit).map(({ scope, tables }, index) => {
        const key = metadataSchemaKey(scope);
        const label = schemaLabel(scope);
        const expanded = Boolean(search) || view.expandedSchemas.has(key);
        const limit = search ? searchRemaining : view.limits[key] || pageSize;
        const visible = tables.slice(0, limit);
        if (search)
          searchRemaining = Math.max(0, searchRemaining - visible.length);
        const catalogHeading =
          scope.catalog &&
          (index === 0 || groups[index - 1].scope.catalog !== scope.catalog);
        return (
          <div className="schema-tree-group" key={key}>
            {catalogHeading && (
              <div className="schema-catalog" title={scope.catalog}>
                {scope.catalog}
              </div>
            )}
            <button
              className="schema-tree-item"
              aria-label={`Схема ${label}`}
              aria-expanded={expanded}
              onClick={() => toggleSchema(scope)}
              title={label}
            >
              {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
              <Database size={14} />
              <span>{scope.schema}</span>
              <small>
                {scope.status === "idle"
                  ? ""
                  : `${scope.tables.length}${scope.complete ? "" : "+"}`}
              </small>
            </button>
            {expanded && (
              <div className="schema-tables">
                {scope.status === "loading" && !scope.tables.length && (
                  <div className="explorer-loading" role="status">
                    <Spinner /> Загружаем таблицы…
                  </div>
                )}
                {scope.error && (
                  <div className="explorer-error" role="alert">
                    {scope.error}
                    <button
                      className="text-button"
                      onClick={() =>
                        void metadata
                          .retrySchema(source.id, scope)
                          .catch(() => {})
                      }
                    >
                      Повторить
                    </button>
                  </div>
                )}
                {scope.columnsError && (
                  <div className="explorer-error" role="alert">
                    Не все столбцы доступны для поиска: {scope.columnsError}
                    <button
                      className="text-button"
                      onClick={() =>
                        void metadata
                          .retrySchema(source.id, scope)
                          .catch(() => {})
                      }
                    >
                      Повторить загрузку
                    </button>
                  </div>
                )}
                {visible.map((table) => {
                  const tableKey = metadataTableKey(table);
                  const matchingColumns = search
                    ? table.columns?.filter(columnMatches) || []
                    : [];
                  const tableExpanded = view.expandedTables.has(tableKey);
                  const columns = tableExpanded
                    ? table.columns
                    : matchingColumns;
                  const columnLimit = search
                    ? Math.min(
                        searchColumnsRemaining,
                        view.limits[tableKey] || pageSize,
                      )
                    : view.limits[tableKey] || pageSize;
                  const visibleColumns = columns?.slice(0, columnLimit);
                  if (search)
                    searchColumnsRemaining -= visibleColumns?.length || 0;
                  const columnError = metadata.getColumnError(source.id, table);
                  return (
                    <div key={tableKey}>
                      <button
                        className="table-tree-item"
                        aria-label={`Таблица ${tableLabel(table)}`}
                        aria-expanded={
                          tableExpanded || matchingColumns.length > 0
                        }
                        title={tableLabel(table)}
                        onClick={() => toggleTable(table)}
                        onDoubleClick={() => openTable(table)}
                      >
                        <span>
                          {tableExpanded || matchingColumns.length ? (
                            <CaretDown size={11} />
                          ) : (
                            <CaretRight size={11} />
                          )}
                        </span>
                        <Table size={14} />
                        <span>{table.name}</span>
                      </button>
                      {(tableExpanded || matchingColumns.length > 0) && (
                        <div className="columns-tree">
                          {columns ? (
                            visibleColumns!.map((column, columnIndex) => (
                              <div
                                key={`${column.name}-${columnIndex}`}
                                title={`${column.name}: ${column.type}`}
                              >
                                <span>
                                  {/int|decimal|float|double|numeric/i.test(
                                    column.type,
                                  ) ? (
                                    <Hash size={12} />
                                  ) : (
                                    <TextT size={12} />
                                  )}
                                </span>
                                <span>{column.name}</span>
                                <small>{column.type}</small>
                              </div>
                            ))
                          ) : !columnError ? (
                            <div role="status">
                              <Spinner /> Загрузка…
                            </div>
                          ) : null}
                          {columnError && (
                            <div className="column-error" role="alert">
                              <span>{columnError}</span>
                              <button
                                className="text-button"
                                onClick={() =>
                                  void metadata
                                    .loadColumns(source.id, table)
                                    .catch(() => {})
                                }
                              >
                                Повторить
                              </button>
                            </div>
                          )}
                          {columns?.length === 0 && !columnError && (
                            <div>Нет доступных столбцов</div>
                          )}
                          {columns &&
                            columns.length > (visibleColumns?.length || 0) && (
                              <button
                                className="metadata-more text-button"
                                onClick={() => {
                                  changeLimit(tableKey);
                                  if (search) changeLimit(`search:${search}`);
                                }}
                              >
                                Показать ещё столбцы
                              </button>
                            )}
                        </div>
                      )}
                    </div>
                  );
                })}
                {!search &&
                  (visible.length < tables.length ||
                    (!scope.complete &&
                      scope.status !== "loading" &&
                      !scope.error)) && (
                    <button
                      className="metadata-more text-button"
                      aria-label={`Показать ещё таблицы в ${label}`}
                      onClick={() => {
                        changeLimit(key);
                        if (
                          !scope.complete &&
                          view.limits[key] > scope.tables.length
                        )
                          void metadata
                            .loadMoreTables(source.id, scope)
                            .catch(() => {});
                      }}
                    >
                      Показать ещё
                      {scope.complete
                        ? ` · ${tables.length - visible.length}`
                        : ""}
                    </button>
                  )}
                {!tables.length && scope.complete && !search && (
                  <div className="metadata-hint">Нет доступных таблиц</div>
                )}
              </div>
            )}
          </div>
        );
      })}
      {groups.length > schemaLimit && (
        <button
          className="metadata-more text-button"
          onClick={() => changeLimit("schemas")}
        >
          Показать ещё схемы
        </button>
      )}
      {search && searchCount > searchLimit && (
        <button
          className="metadata-more text-button"
          onClick={() => changeLimit(`search:${search}`)}
        >
          Показать ещё результаты · {searchCount - searchLimit}
        </button>
      )}
      {search && !groups.length && (
        <div className="metadata-hint">
          {snapshot.complete ? "Ничего не найдено" : "Совпадений пока нет"}
        </div>
      )}
      {!search && snapshot.status === "ready" && !snapshot.schemas.length && (
        <div className="metadata-hint">Нет доступных схем</div>
      )}
    </>
  );
}
