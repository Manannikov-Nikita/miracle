import { useEffect, useState } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  Code,
  Database,
  MagnifyingGlass,
  Plus,
  Table,
  Hash,
  TextT,
  Trash,
  X,
} from "@phosphor-icons/react";
import type {
  Connection,
  QueryDocument,
  QueryRun,
  QuerySource,
  SchemaTable,
  User,
} from "../../shared/types";
import { api } from "../api";
import { EmptyState, IconButton, Spinner } from "./UI";
export type ExplorerKind = "sources" | "queries" | "history";
export default function Explorer({
  kind,
  user,
  connections,
  activeConnectionId,
  onConnectionChange,
  schema,
  onSchemaChange,
  onOpenConnections,
  onOpenQuery,
  onOpenSource,
  queryRevision,
  onNotify,
  onClose,
}: {
  kind: ExplorerKind;
  user: User;
  connections: Connection[];
  activeConnectionId: string;
  onConnectionChange: (id: string) => void;
  schema: SchemaTable[];
  onSchemaChange: (s: SchemaTable[]) => void;
  onOpenConnections: () => void;
  onOpenQuery: (q: QueryDocument) => void;
  onOpenSource: (q: QuerySource) => void;
  queryRevision: number;
  onNotify: (m: string, t?: "error" | "success" | "info") => void;
  onClose?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [queries, setQueries] = useState<QueryDocument[]>([]);
  const [history, setHistory] = useState<QueryRun[]>([]);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const source = connections.find((c) => c.id === activeConnectionId);
  async function reload() {
    setLoading(true);
    setError("");
    try {
      if (kind === "sources" && activeConnectionId)
        onSchemaChange(
          await api<SchemaTable[]>(
            `/api/connections/${activeConnectionId}/schema`,
          ),
        );
      if (kind === "queries")
        setQueries(await api<QueryDocument[]>("/api/queries"));
      if (kind === "history")
        setHistory(await api<QueryRun[]>("/api/query-runs?limit=30"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let valid = true;
    if (kind === "sources" && activeConnectionId) {
      setLoading(true);
      setError("");
      onSchemaChange([]);
      api<SchemaTable[]>(`/api/connections/${activeConnectionId}/schema`)
        .then((s) => {
          if (valid) onSchemaChange(s);
        })
        .catch((e) => {
          if (valid) setError(e.message);
        })
        .finally(() => {
          if (valid) setLoading(false);
        });
    } else if (kind !== "sources") void reload();
    return () => {
      valid = false;
    };
  }, [kind, activeConnectionId, queryRevision]);
  async function toggle(t: SchemaTable) {
    const key = `${t.catalog || ""}.${t.schema}.${t.name}`;
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else {
      next.add(key);
      if (!t.columns) {
        try {
          const qs = new URLSearchParams({
            schema: t.schema,
            table: t.name,
            ...(t.catalog ? { catalog: t.catalog } : {}),
          });
          const columns = await api<{ name: string; type: string }[]>(
            `/api/connections/${activeConnectionId}/columns?${qs}`,
          );
          onSchemaChange(
            schema.map((s) =>
              s.name === t.name &&
              s.schema === t.schema &&
              s.catalog === t.catalog
                ? { ...s, columns }
                : s,
            ),
          );
        } catch (e) {
          onNotify((e as Error).message, "error");
        }
      }
    }
    setExpanded(next);
  }
  const title =
    kind === "sources"
      ? "Источники данных"
      : kind === "queries"
        ? "SQL-файлы"
        : "История запросов";
  return (
    <aside className={`explorer ${onClose ? "explorer-drawer" : ""}`}>
      <div className="explorer-heading">
        <strong>{title}</strong>
        <div>
          {kind === "sources" && user.role === "admin" && (
            <IconButton label="Добавить источник" onClick={onOpenConnections}>
              <Plus size={14} />
            </IconButton>
          )}
          <IconButton
            label="Обновить список"
            onClick={reload}
            disabled={loading}
          >
            <ArrowClockwise size={14} className={loading ? "spin" : ""} />
          </IconButton>
          {onClose && (
            <IconButton label="Закрыть обозреватель" onClick={onClose}>
              <X size={14} />
            </IconButton>
          )}
        </div>
      </div>
      <div className="explorer-search">
        <MagnifyingGlass size={14} />
        <input
          aria-label={`Поиск: ${title}`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Поиск…"
        />
      </div>
      <div className="explorer-body">
        {kind === "sources" && (
          <>
            <div className="explorer-section-label">
              ПОДКЛЮЧЕНИЯ <span>{connections.length}</span>
            </div>
            {connections.map((c) => (
              <button
                key={c.id}
                className={`connection-tree-item ${c.id === activeConnectionId ? "active" : ""}`}
                onClick={() => onConnectionChange(c.id)}
              >
                <CaretRight size={12} />
                <span className={`source-symbol ${c.engine}`}>
                  {c.engine === "clickhouse" ? "▥" : "T"}
                </span>
                <span>{c.name}</span>
                {c.id === activeConnectionId && <span className="status-dot" />}
              </button>
            ))}
            {source && (
              <>
                <div className="explorer-section-label schema-label">
                  {source.database || source.catalog || "СХЕМЫ"}
                  <span>{schema.length}</span>
                </div>
                {loading && (
                  <div className="explorer-loading">
                    <Spinner />
                    Читаем схему…
                  </div>
                )}
                {error && (
                  <div className="explorer-error" role="alert">
                    {error}
                    <button className="text-button" onClick={reload}>
                      Повторить
                    </button>
                  </div>
                )}
                {schema
                  .filter((t) =>
                    `${t.schema}.${t.name}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                  )
                  .map((t) => {
                    const key = `${t.catalog || ""}.${t.schema}.${t.name}`;
                    return (
                      <div key={key}>
                        <button
                          className="table-tree-item"
                          onClick={() => toggle(t)}
                          onDoubleClick={() =>
                            onOpenSource({
                              connectionId: source.id,
                              sql: `SELECT *\nFROM ${[
                                t.catalog,
                                t.schema,
                                t.name,
                              ]
                                .filter((s): s is string => Boolean(s))
                                .map((s) => `"${s.replaceAll('"', '""')}"`)
                                .join(".")}\nLIMIT 100;`,
                              database: source.database,
                              catalog: t.catalog || source.catalog,
                              schema: t.schema,
                            })
                          }
                        >
                          <span>
                            {expanded.has(key) ? (
                              <CaretDown size={11} />
                            ) : (
                              <CaretRight size={11} />
                            )}
                          </span>
                          <Table size={14} />
                          <span>{t.name}</span>
                          <small title={t.schema}>
                            {t.schema === source.schema ||
                            t.schema === source.database
                              ? ""
                              : t.schema}
                          </small>
                        </button>
                        {expanded.has(key) && (
                          <div className="columns-tree">
                            {t.columns ? (
                              t.columns.map((c, i) => (
                                <div key={`${c.name}-${i}`}>
                                  <span>
                                    {/int|decimal|float|double|numeric/i.test(
                                      c.type,
                                    ) ? (
                                      <Hash size={12} />
                                    ) : (
                                      <TextT size={12} />
                                    )}
                                  </span>
                                  <span>{c.name}</span>
                                  <small>{c.type}</small>
                                </div>
                              ))
                            ) : (
                              <div>
                                <Spinner />
                                Загрузка…
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
              </>
            )}
            {!connections.length && (
              <div className="explorer-placeholder">
                <Database size={24} />
                <p>
                  Данные начинаются
                  <br />с подключения
                </p>
                {user.role === "admin" && (
                  <button className="button small" onClick={onOpenConnections}>
                    Добавить источник
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {kind === "queries" && (
          <>
            <div className="explorer-section-label">
              ОБЩИЕ ФАЙЛЫ <span>{queries.length}</span>
            </div>
            {queries
              .filter((q) =>
                q.name.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((q) => (
                <button
                  key={q.id}
                  className="saved-query-item"
                  onClick={() => onOpenQuery(q)}
                >
                  <Code size={15} />
                  <span>
                    {q.name.endsWith(".sql") ? q.name : q.name + ".sql"}
                  </span>
                </button>
              ))}
            {!queries.length && (
              <div className="explorer-placeholder">
                <Code size={24} />
                <p>
                  Сохраните запрос —<br />
                  он появится здесь.
                </p>
              </div>
            )}
          </>
        )}
        {kind === "history" && (
          <>
            <div className="explorer-section-label">ПОСЛЕДНИЕ ЗАПУСКИ</div>
            {history
              .filter((r) =>
                r.source.sql.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((r) => (
                <button
                  key={r.id}
                  className="history-item"
                  onClick={() => onOpenSource(r.source)}
                >
                  <span className={`history-dot ${r.status}`} />
                  <div>
                    <code>
                      {r.source.sql
                        .replace(/--[^\n]*/g, "")
                        .trim()
                        .slice(0, 90)}
                    </code>
                    <small>
                      {new Date(r.startedAt).toLocaleString("ru-RU", {
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}{" "}
                      ·{" "}
                      {r.status === "completed"
                        ? "Выполнен"
                        : r.status === "failed"
                          ? "Ошибка"
                          : r.status === "cancelled"
                            ? "Отменён"
                            : r.status === "running"
                              ? "Выполняется"
                              : r.status === "cancelling"
                                ? "Отмена"
                                : "Прерван"}
                    </small>
                  </div>
                </button>
              ))}
            {!history.length && (
              <div className="explorer-placeholder">
                <ClockCounterClockwise size={24} />
                <p>
                  История начнётся
                  <br />с первого запроса.
                </p>
              </div>
            )}
          </>
        )}
      </div>
      <div className="explorer-footer">
        <span className="status-dot" />
        Общая рабочая область
      </div>
    </aside>
  );
}
