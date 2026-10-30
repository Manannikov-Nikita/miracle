import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowClockwise,
  CaretRight,
  ClockCounterClockwise,
  Code,
  Database,
  MagnifyingGlass,
  Plus,
  X,
} from "@phosphor-icons/react";
import type {
  Connection,
  QueryDocument,
  QueryRun,
  QuerySource,
} from "../../shared/types";
import { api } from "../api";
import { IconButton } from "./UI";
import type { MetadataStore } from "../metadata-store";
import SourceSchemaTree, { type ExplorerSourceView } from "./SourceSchemaTree";
export type { ExplorerSourceView } from "./SourceSchemaTree";
export type ExplorerKind = "sources" | "queries" | "history";
export default function Explorer({
  kind,
  connections,
  activeConnectionId,
  onConnectionChange,
  metadata,
  sourceViews,
  onOpenConnections,
  onOpenQuery,
  onOpenSource,
  queryRevision,
  onNotify,
  onClose,
}: {
  kind: ExplorerKind;
  connections: Connection[];
  activeConnectionId: string;
  onConnectionChange: (id: string) => void;
  metadata: MetadataStore;
  sourceViews?: Map<string, ExplorerSourceView>;
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
  const localViews = useRef(new Map<string, ExplorerSourceView>());
  const views = sourceViews || localViews.current;
  const subscribe = useCallback(
    (listener: () => void) => metadata.subscribe(activeConnectionId, listener),
    [metadata, activeConnectionId],
  );
  const getSnapshot = useCallback(
    () => metadata.getSnapshot(activeConnectionId),
    [metadata, activeConnectionId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const source = connections.find((c) => c.id === activeConnectionId);
  async function reload() {
    if (kind === "sources") {
      if (activeConnectionId) metadata.refresh(activeConnectionId);
      return;
    }
    setLoading(true);
    setError("");
    try {
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
    if (source && kind === "sources") metadata.activate(source.id, source);
  }, [metadata, source, kind]);
  useEffect(() => {
    if (kind === "sources") return;
    let valid = true;
    setLoading(true);
    setError("");
    const request =
      kind === "queries"
        ? api<QueryDocument[]>("/api/queries").then((items) => {
            if (valid) setQueries(items);
          })
        : api<QueryRun[]>("/api/query-runs?limit=30").then((items) => {
            if (valid) setHistory(items);
          });
    void request
      .catch((e: Error) => {
        if (valid) setError(e.message);
      })
      .finally(() => {
        if (valid) setLoading(false);
      });
    return () => {
      valid = false;
    };
  }, [kind, queryRevision]);
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
          {kind === "sources" && (
            <IconButton label="Добавить источник" onClick={onOpenConnections}>
              <Plus size={14} />
            </IconButton>
          )}
          <IconButton
            label="Обновить список"
            onClick={reload}
            disabled={
              kind === "sources" ? snapshot.status === "loading" : loading
            }
          >
            <ArrowClockwise
              size={14}
              className={
                (kind === "sources" ? snapshot.status === "loading" : loading)
                  ? "spin"
                  : ""
              }
            />
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
        {kind !== "sources" && error && (
          <div className="explorer-error" role="alert">
            {error}
            <button className="text-button" onClick={reload}>
              Повторить
            </button>
          </div>
        )}
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
              <SourceSchemaTree
                source={source}
                metadata={metadata}
                snapshot={snapshot}
                views={views}
                filter={filter}
                onOpenSource={onOpenSource}
              />
            )}
            {!connections.length && (
              <div className="explorer-placeholder">
                <Database size={24} />
                <p>
                  Данные начинаются
                  <br />с подключения
                </p>
                <button className="button small" onClick={onOpenConnections}>
                  Добавить источник
                </button>
              </div>
            )}
          </>
        )}
        {kind === "queries" && (
          <>
            <div className="explorer-section-label">
              SQL-ФАЙЛЫ <span>{queries.length}</span>
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
        Рабочая область
      </div>
    </aside>
  );
}
