import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/features/wordOperations/register.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  SquaresFour,
  Rows,
  ArrowsOutSimple,
  CaretDown,
  Code,
  Database,
  DotsThree,
  FloppyDisk,
  Minus,
  Plus,
  Play,
  Square,
  Table,
  X,
  Clock,
  CheckCircle,
  WarningCircle,
  TextAlignLeft,
  FolderOpen,
  DownloadSimple,
  CalendarBlank,
} from "@phosphor-icons/react";
import type {
  Connection,
  DateRangeOptions,
  QueryDocument,
  QueryRun,
  QuerySource,
  ResultSet,
  SchemaTable,
  SqlFunctionCatalog,
} from "../../shared/types";
import { api, ApiRequestError, json } from "../api";
import { describeError } from "../error-message";
import type { EditorDocument } from "../../shared/agents";
import {
  documentToTab,
  tabFields,
  type EditorTab,
} from "../agents/editor-sync";
import {
  loadEditorDocuments,
  recoveryKey,
  useEditorSync,
} from "../agents/useEditorSync";
import { useProjectSync } from "../agents/ProjectSync";
import { hasDatePlaceholder } from "../../shared/date-batch";
import DateBatchDialog from "./DateBatchDialog";
import DateBatchProgress from "./DateBatchProgress";
import { EmptyState, ErrorBox, IconButton, Modal, Spinner } from "./UI";
import ResultTable from "./ResultTable";
import { Select } from "./Select";
import { formatSql, sqlFileName } from "../sql-files";
import { sqlStatementAt } from "../sql-statements";
import { createSqlMetadataLoader, sqlSuggestions } from "../sql-completion";
import type { MetadataStore } from "../metadata-store";
import {
  clickhouseSqlConfiguration,
  clickhouseSqlLanguage,
  clickhouseSqlLanguageId,
  sqlLanguageForEngine,
} from "../sql-highlighting";
(self as typeof self & { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });
monaco.languages.register({
  id: clickhouseSqlLanguageId,
  aliases: ["ClickHouse SQL"],
});
monaco.languages.setMonarchTokensProvider(
  clickhouseSqlLanguageId,
  clickhouseSqlLanguage,
);
monaco.languages.setLanguageConfiguration(
  clickhouseSqlLanguageId,
  clickhouseSqlConfiguration,
);
monaco.editor.defineTheme("miracle-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword", foreground: "B9CBC1" },
    { token: "string", foreground: "D1C49A" },
    { token: "number", foreground: "DDBB9D" },
    { token: "comment", foreground: "92969D", fontStyle: "italic" },
    { token: "operator", foreground: "B1BEC9" },
  ],
  colors: {
    "editor.background": "#202225",
    "editor.foreground": "#eeeff0",
    "editorLineNumber.foreground": "#92969d",
    "editorLineNumber.activeForeground": "#d4d7da",
    "editor.lineHighlightBackground": "#27292d",
    "editor.selectionBackground": "#40574b",
    "editorCursor.foreground": "#b9d3c5",
    "editorWidget.background": "#2b2d31",
    "editorWidget.border": "#45484e",
    "editorSuggestWidget.background": "#2b2d31",
    "editorSuggestWidget.selectedBackground": "#3b3e43",
    "editorIndentGuide.background1": "#303338",
  },
});
type Tab = EditorTab;
export interface SqlSourceRequest {
  source: QuerySource;
  name?: string;
}
interface Props {
  workspaceId: string;
  connections: Connection[];
  activeConnectionId: string;
  onConnectionChange: (id: string) => void;
  metadata: MetadataStore;
  sourceToOpen?: SqlSourceRequest | null;
  savedToOpen?: QueryDocument | null;
  onSourceConsumed: () => void;
  onSavedConsumed: () => void;
  onQueriesChanged: () => void;
  onResult: (r: ResultSet) => void;
  onNotify: (m: string, t?: "error" | "success" | "info") => void;
  onOpenConnections: () => void;
  onMaximize: () => void;
  onCollapse: () => void;
}
function loadTabs(key: string): Tab[] {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(stored) && stored.length ? stored : [];
  } catch {
    return [];
  }
}
export default function SqlWorkspace(p: Props) {
  const [documents, setDocuments] = useState<EditorDocument[] | null>(null);
  const [error, setError] = useState("");
  const load = () => {
    setError("");
    void loadEditorDocuments(p.workspaceId)
      .then(setDocuments)
      .catch((e) => setError(describeError(e).details));
  };
  useEffect(load, [p.workspaceId]);
  if (!documents)
    return (
      <section className="sql-workspace" aria-label="SQL-редактор">
        {error ? (
          <>
            <ErrorBox>{error}</ErrorBox>
            <button className="button" onClick={load}>
              Повторить загрузку SQL
            </button>
          </>
        ) : (
          <span role="status">
            <Spinner /> Загружаем SQL-документы…
          </span>
        )}
      </section>
    );
  return <LoadedSqlWorkspace {...p} documents={documents} />;
}
function LoadedSqlWorkspace(p: Props & { documents: EditorDocument[] }) {
  const storage = `miracle:sql-tabs:${p.workspaceId}`;
  const [tabs, setTabs] = useState<Tab[]>(() => {
    let initial = p.documents.map(documentToTab);
    const recovery = loadTabs(recoveryKey(p.workspaceId));
    // A stale recovery is retained as a conflicting draft, never silently rebased.
    for (const tab of recovery) {
      const remote = initial.find((d) => d.id === tab.id);
      if (
        !remote ||
        (tab.documentRevision ?? 0) >= (remote.documentRevision ?? 0) ||
        JSON.stringify(tabFields(tab)) !== JSON.stringify(tabFields(remote))
      ) {
        initial = [...initial.filter((d) => d.id !== tab.id), tab];
      }
    }
    return initial.length
      ? initial
      : [
          {
            id: crypto.randomUUID(),
            name: "query_1.sql",
            sql: "",
            connectionId: p.activeConnectionId,
          },
        ];
  });
  const documentSync = useEditorSync(
    p.workspaceId,
    p.documents,
    tabs,
    setTabs,
    p.onNotify,
  );
  const projectSync = useProjectSync();
  const [activeId, setActiveId] = useState(
    () => localStorage.getItem(`${storage}:active`) || "",
  );
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const active = tabs.find((t) => t.id === activeId) || tabs[0];
  const activeRef = useRef(active);
  activeRef.current = active;
  const activeTabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = activeTabRef.current;
    const strip = node?.parentElement;
    if (!node || !strip) return;
    const reveal = () => {
      if (strip.clientWidth)
        node.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [active.id]);
  const [results, setResults] = useState<Record<string, ResultSet>>({});
  const [runs, setRuns] = useState<Record<string, QueryRun>>({});
  const [trackingErrors, setTrackingErrors] = useState<
    Record<string, { message: string; paused: boolean }>
  >({});
  const mounted = useRef(true);
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState("");
  const [batchRequest, setBatchRequest] = useState<{
    tabId: string;
    source: QuerySource;
    initial?: DateRangeOptions;
  } | null>(null);
  const [launchingTabs, setLaunchingTabs] = useState(new Set<string>());
  const launchingRef = useRef(new Set<string>());
  const [executionSql, setExecutionSql] = useState(active.sql);
  const executableSqlReader = useRef<() => string | null | undefined>(
    () => undefined,
  );

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const restoreEditorFocus = useRef(false);
  useEffect(() => {
    const editor = editorRef.current,
      model = editor?.getModel();
    if (
      !editor ||
      !model ||
      model.uri.toString() !==
        `miracle-query://${p.workspaceId}/${active.id}.sql` ||
      model.getValue() === active.sql
    )
      return;
    const before = model.getValue(),
      after = active.sql;
    let from = 0,
      oldEnd = before.length,
      newEnd = after.length;
    while (from < oldEnd && from < newEnd && before[from] === after[from])
      from++;
    while (
      oldEnd > from &&
      newEnd > from &&
      before[oldEnd - 1] === after[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }
    const start = model.getPositionAt(from),
      end = model.getPositionAt(oldEnd);
    const selection = editor.getSelection(),
      scroll = editor.getScrollTop();
    editor.pushUndoStop();
    editor.executeEdits("project-agent", [
      {
        range: new monaco.Range(
          start.lineNumber,
          start.column,
          end.lineNumber,
          end.column,
        ),
        text: after.slice(from, newEnd),
      },
    ]);
    editor.pushUndoStop();
    if (selection) editor.setSelection(selection);
    editor.setScrollTop(scroll);
    // Local keystroke renders and save acknowledgments may trail Monaco's latest
    // input. Only an explicit remote replacement may execute a programmatic edit.
  }, [active.id, active.externalSqlRevision, p.workspaceId]);
  const completionMetadata = useMemo(
    () => createSqlMetadataLoader(p.metadata),
    [p.metadata],
  );
  const pollers = useRef(new Map<string, AbortController>());
  const runAction = useRef<() => void>(() => {});
  const formatAction = useRef<() => void>(() => {});
  const saveAction = useRef<() => void>(() => {});
  const importInput = useRef<HTMLInputElement>(null);
  const group = useGroupRef();
  useEffect(() => {
    const reset = () => group.current?.setLayout({ editor: 55, results: 45 });
    window.addEventListener("miracle:reset-layout", reset);
    return () => window.removeEventListener("miracle:reset-layout", reset);
  }, [group]);
  const [resultExpanded, setResultExpanded] = useState(true);
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 });
  const activeRun = runs[active.id];
  const result = results[active.id];
  // Progress already explains these summaries; keep specific execution errors.
  const summarizedBatchError =
    activeRun?.batch &&
    ((activeRun.status === "failed" &&
      activeRun.error ===
        `Не удалось выполнить ${activeRun.batch.failed} из ${activeRun.batch.total} дат. Успешные результаты сохранены.`) ||
      (activeRun.status === "cancelled" &&
        activeRun.error ===
          "Пакет остановлен. Успешные результаты сохранены."));
  const runError = summarizedBatchError ? undefined : activeRun?.error;
  const running =
    activeRun && ["running", "cancelling"].includes(activeRun.status);
  const launching = launchingTabs.has(active.id);
  const connection = p.connections.find(
    (c) => c.id === (active.connectionId || p.activeConnectionId),
  );
  const patch = useCallback(
    (id: string, values: Partial<Tab>) =>
      setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...values } : t))),
    [],
  );
  useEffect(() => {
    if (!projectSync) return;
    return projectSync.register("editor", {
      context: () => {
        const editor = editorRef.current,
          selection = editor?.getSelection();
        return {
          editorDocumentId: activeRef.current.id,
          selection: selection
            ? editor?.getModel()?.getValueInRange(selection) || undefined
            : undefined,
        };
      },
      flush: documentSync.flush,
    });
  }, [projectSync, documentSync.flush]);
  useEffect(() => {
    localStorage.setItem(`${storage}:active`, active.id);
  }, [active.id, storage]);
  useEffect(() => {
    if (!active.connectionId && p.activeConnectionId)
      patch(active.id, { connectionId: p.activeConnectionId });
  }, [p.activeConnectionId, active.connectionId, active.id, patch]);
  useEffect(() => {
    if (
      active.connectionId &&
      p.connections.some((c) => c.id === active.connectionId)
    )
      p.onConnectionChange(active.connectionId);
  }, [active.id]);
  async function track(tabId: string, id: string) {
    pollers.current.get(tabId)?.abort();
    const controller = new AbortController();
    pollers.current.set(tabId, controller);
    const valid = () =>
      mounted.current &&
      !controller.signal.aborted &&
      pollers.current.get(tabId) === controller &&
      tabsRef.current.some((tab) => tab.id === tabId);
    let resultVersion = "";
    let failures = 0;
    const clearTrackingError = () =>
      setTrackingErrors((current) => {
        if (!current[tabId]) return current;
        const next = { ...current };
        delete next[tabId];
        return next;
      });
    clearTrackingError();
    const wait = (delay: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", abort);
          resolve();
        }, delay);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        controller.signal.addEventListener("abort", abort, { once: true });
      });
    try {
      while (valid()) {
        let delay = 600;
        try {
          const update = await api<QueryRun>(`/api/query-runs/${id}`, {
            signal: controller.signal,
          });
          if (!valid()) return;
          setRuns((current) => ({ ...current, [tabId]: update }));
          const terminal = !["running", "cancelling"].includes(update.status);
          if (
            update.resultSetId &&
            (update.batch || update.status === "completed")
          ) {
            const version = `${update.resultSetId}:${update.rowCount ?? ""}:${update.batch?.completed ?? ""}`;
            if (version !== resultVersion || terminal) {
              const saved = await api<ResultSet>(
                `/api/result-sets/${update.resultSetId}`,
                { signal: controller.signal },
              );
              if (!valid()) return;
              resultVersion = version;
              setResults((current) => ({ ...current, [tabId]: saved }));
              patch(tabId, { resultSetId: saved.id });
            }
          }
          failures = 0;
          clearTrackingError();
          if (terminal) {
            if (update.status === "failed" || update.status === "interrupted")
              p.onNotify(update.error || "Запрос не завершён", "error");
            return;
          }
        } catch (error) {
          if (!valid() || (error as Error).name === "AbortError") return;
          failures++;
          const retryable =
            !(error instanceof ApiRequestError) ||
            error.status >= 500 ||
            [408, 429].includes(error.status);
          const paused = !retryable || failures >= 5;
          setTrackingErrors((current) => ({
            ...current,
            [tabId]: { message: describeError(error).details, paused },
          }));
          if (paused) return;
          delay = Math.min(5000, 600 * 2 ** (failures - 1));
        }
        await wait(delay);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError" && valid())
        p.onNotify(describeError(error).details, "error");
    } finally {
      if (pollers.current.get(tabId) === controller)
        pollers.current.delete(tabId);
    }
  }
  const trackingKey = tabs
    .map((t) => `${t.id}:${t.resultSetId || ""}:${t.runId || ""}`)
    .join("|");
  useEffect(() => {
    mounted.current = true;
    for (const t of tabs) {
      if (t.resultSetId)
        api<ResultSet>(`/api/result-sets/${t.resultSetId}`)
          .then((r) => {
            if (
              mounted.current &&
              tabsRef.current.some((tab) => tab.id === t.id)
            )
              setResults((s) => (s[t.id] ? s : { ...s, [t.id]: r }));
          })
          .catch(() => {});
      if (t.runId) void track(t.id, t.runId);
    }
    return () => {
      mounted.current = false;
      for (const c of pollers.current.values()) c.abort();
    };
  }, [trackingKey]);
  function open(source: QuerySource, document?: QueryDocument, name?: string) {
    const tabName = document?.name || name || "source.sql";
    const existing = tabsRef.current.find((t) =>
      document
        ? t.queryId === document.id
        : name !== undefined && t.name === tabName,
    );
    if (existing) {
      setActiveId(existing.id);
      p.onConnectionChange(existing.connectionId);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      ...source,
      name: tabName,
      queryId: document?.id,
      revision: document?.revision,
    };
    // A second open can arrive before React commits the first new tab.
    tabsRef.current = [...tabsRef.current, tab];
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
    p.onConnectionChange(tab.connectionId);
  }
  useEffect(() => {
    if (p.sourceToOpen) {
      open(p.sourceToOpen.source, undefined, p.sourceToOpen.name);
      p.onSourceConsumed();
    }
  }, [p.sourceToOpen]);
  useEffect(() => {
    if (p.savedToOpen) {
      open(p.savedToOpen, p.savedToOpen);
      p.onSavedConsumed();
    }
  }, [p.savedToOpen]);
  useEffect(() => {
    if (connection?.id)
      p.metadata.activate(connection.id, {
        database: active.database ?? connection.database,
        catalog: active.catalog ?? connection.catalog,
        schema: active.schema ?? connection.schema,
      });
    if (connection?.engine === "clickhouse")
      void completionMetadata.functionCatalog(connection.id).catch(() => {});
  }, [
    connection,
    active.database,
    active.catalog,
    active.schema,
    p.metadata,
    completionMetadata,
  ]);
  useEffect(() => {
    const provider = monaco.languages.registerCompletionItemProvider(
      ["sql", clickhouseSqlLanguageId],
      {
        triggerCharacters: ["."],
        async provideCompletionItems(model, position, _context, token) {
          if (model !== editorRef.current?.getModel())
            return { suggestions: [] };
          const tab = activeRef.current;
          const connectionId = tab.connectionId || p.activeConnectionId;
          const selectedConnection = p.connections.find(
            (item) => item.id === connectionId,
          );
          const context = {
            database: tab.database ?? selectedConnection?.database,
            catalog: tab.catalog ?? selectedConnection?.catalog,
            schema: tab.schema ?? selectedConnection?.schema,
            engine: selectedConnection?.engine,
          };
          const sql = model.getValue();
          const modelVersion = model.getVersionId();
          const beforeCursor = sql.slice(0, model.getOffsetAt(position));
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          let tables: SchemaTable[] = connectionId
            ? p.metadata.getTables(connectionId)
            : [];
          let functions: SqlFunctionCatalog | undefined;
          let metadataReady = true;
          if (connectionId) {
            const requests = [
              completionMetadata
                .tables(connectionId, sql, context, beforeCursor)
                .then((value) => {
                  tables = value;
                }),
              ...(context.engine === "clickhouse"
                ? [
                    completionMetadata
                      .functionCatalog(connectionId)
                      .then((value) => {
                        functions = value;
                      }),
                  ]
                : []),
            ];
            // Do not hold basic dialect completions behind a slow/offline source.
            // Requests keep warming the per-connection cache for the next prefix.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const ready = Promise.allSettled(requests).then(() => true);
            try {
              metadataReady = await Promise.race([
                ready,
                new Promise<false>((resolve) => {
                  timer = setTimeout(() => resolve(false), 300);
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          }
          if (
            token.isCancellationRequested ||
            model !== editorRef.current?.getModel() ||
            modelVersion !== model.getVersionId() ||
            connectionId !==
              (activeRef.current.connectionId || p.activeConnectionId)
          )
            return { suggestions: [] };
          // Requests that exceed the deadline still publish incremental cache
          // pages; retain those suggestions while the rest is loading.
          if (connectionId) tables = p.metadata.getTables(connectionId);
          const snapshot = connectionId
            ? p.metadata.getSnapshot(connectionId)
            : undefined;
          const suggestions = sqlSuggestions(
            sql,
            beforeCursor,
            tables,
            context,
            functions,
            {
              schemas: snapshot?.schemas,
              prefix: word.word,
              limit: 200,
            },
          );
          const kinds = {
            keyword: monaco.languages.CompletionItemKind.Keyword,
            table: monaco.languages.CompletionItemKind.Struct,
            column: monaco.languages.CompletionItemKind.Field,
            schema: monaco.languages.CompletionItemKind.Module,
            function: monaco.languages.CompletionItemKind.Function,
          };
          return {
            // ClickHouse combinators are generated from the growing function
            // prefix; ask Monaco to refresh instead of filtering the first list.
            incomplete:
              !metadataReady ||
              !snapshot?.complete ||
              suggestions.length >= 200 ||
              context.engine === "clickhouse",
            suggestions: suggestions.map((suggestion) => ({
              ...suggestion,
              kind: kinds[suggestion.kind],
              range,
            })),
          };
        },
      },
    );
    return () => provider.dispose();
  }, [
    connection,
    p.activeConnectionId,
    p.connections,
    p.metadata,
    completionMetadata,
  ]);
  function readExecutableSql() {
    const tab = activeRef.current;
    const selectedConnection = p.connections.find(
      (item) => item.id === (tab.connectionId || p.activeConnectionId),
    );
    const editor = editorRef.current;
    const model = editor?.getModel();
    const position = editor?.getPosition();
    if (
      !model ||
      !position ||
      model.uri.toString() !== `miracle-query://${p.workspaceId}/${tab.id}.sql`
    )
      return undefined;
    const selection = editor?.getSelection();
    const selected = selection ? model.getValueInRange(selection).trim() : "";
    return (
      selected ||
      sqlStatementAt(
        model.getValue(),
        model.getOffsetAt(position),
        selectedConnection?.engine ?? "clickhouse",
      )
    );
  }
  function updateExecutableSql() {
    const sql = executableSqlReader.current();
    if (sql !== undefined) setExecutionSql(sql ?? "");
  }
  // Monaco keeps mount listeners for its lifetime; read the current connection.
  executableSqlReader.current = readExecutableSql;
  useEffect(() => {
    updateExecutableSql();
  }, [active.id, active.sql, connection?.engine]);
  const dateMode = hasDatePlaceholder(executionSql, connection?.engine);
  async function startRun(tabId: string, source: QuerySource) {
    if (launchingRef.current.has(tabId)) return;
    launchingRef.current.add(tabId);
    setLaunchingTabs(new Set(launchingRef.current));
    pollers.current.get(tabId)?.abort();
    try {
      const started = await api<QueryRun>("/api/query-runs", {
        method: "POST",
        body: json(source),
      });
      if (!mounted.current || !tabsRef.current.some((tab) => tab.id === tabId))
        return;
      setRuns((current) => ({ ...current, [tabId]: started }));
      patch(tabId, {
        runId: started.id,
        connectionId: source.connectionId,
        ...(source.dateRange ? { dateRange: source.dateRange } : {}),
      });
      if (!resultExpanded) {
        group.current?.setLayout({ editor: 55, results: 45 });
        setResultExpanded(true);
      }
      void track(tabId, started.id);
    } finally {
      launchingRef.current.delete(tabId);
      if (mounted.current) setLaunchingTabs(new Set(launchingRef.current));
    }
  }
  async function run() {
    const tab = activeRef.current;
    if (launchingRef.current.has(tab.id) || batchRequest) return;
    const conn = p.connections.find(
      (item) => item.id === (tab.connectionId || p.activeConnectionId),
    );
    if (!conn) {
      p.onOpenConnections();
      return;
    }
    const sql = readExecutableSql();
    if (sql === undefined) {
      p.onNotify("Редактор ещё открывает файл. Повторите запуск.", "info");
      return;
    }
    if (!sql) {
      p.onNotify(
        "Нет SQL для запуска. Поставьте курсор на запрос или выделите SQL.",
        "info",
      );
      return;
    }
    const source: QuerySource = {
      connectionId: conn.id,
      sql,
      database: tab.database ?? conn.database,
      catalog: tab.catalog ?? conn.catalog,
      schema: tab.schema ?? conn.schema,
    };
    p.onConnectionChange(conn.id);
    if (hasDatePlaceholder(sql, conn.engine)) {
      setBatchRequest({ tabId: tab.id, source, initial: tab.dateRange });
      return;
    }
    try {
      await startRun(tab.id, source);
    } catch (error) {
      p.onNotify(describeError(error).details, "error");
    }
  }
  runAction.current = () => {
    if (!running && !launching) void run();
  };
  function formatActive() {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    try {
      const source = model.getValue();
      const engine =
        p.connections.find((c) => c.id === activeRef.current.connectionId)
          ?.engine || "clickhouse";
      const formatted = formatSql(source, engine);
      if (formatted !== source) {
        editor.pushUndoStop();
        editor.executeEdits("miracle.format", [
          {
            range: model.getFullModelRange(),
            text: formatted,
            forceMoveMarkers: true,
          },
        ]);
        editor.pushUndoStop();
      }
      editor.setScrollLeft(0);
      editor.revealPositionInCenterIfOutsideViewport(editor.getPosition()!);
      editor.focus();
    } catch (e) {
      p.onNotify(
        `Не удалось форматировать SQL: ${(e as Error).message}`,
        "error",
      );
    }
  }
  formatAction.current = formatActive;
  saveAction.current = () => {
    setSaveName(activeRef.current.name);
    setSaveError("");
    setSaveOpen(true);
  };
  async function importFiles(files: FileList | null) {
    if (!files) return;
    const added: Tab[] = [];
    for (const file of Array.from(files)) {
      if (!/\.sql$/i.test(file.name)) {
        p.onNotify(`Файл ${file.name}: нужен формат .sql`, "error");
        continue;
      }
      if (file.size > 262144) {
        p.onNotify(`Файл ${file.name} превышает 256 KiB`, "error");
        continue;
      }
      added.push({
        id: crypto.randomUUID(),
        name: sqlFileName(file.name),
        sql: await file.text(),
        connectionId: p.activeConnectionId,
      });
    }
    if (added.length) {
      setTabs((t) => [...t, ...added]);
      setActiveId(added[0].id);
    }
    if (importInput.current) importInput.current.value = "";
  }
  function downloadFile() {
    const blob = new Blob([active.sql], {
      type: "application/sql;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = sqlFileName(active.name);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const mount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
      runAction.current(),
    );
    editor.addAction({
      id: "miracle.formatSql",
      label: "Форматировать SQL",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL,
      ],
      contextMenuGroupId: "1_modification",
      contextMenuOrder: 1,
      run: () => formatAction.current(),
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
      saveAction.current(),
    );
    editor.onDidChangeCursorPosition((e) => {
      updateExecutableSql();
      setCursor(e.position);
      patch(activeRef.current.id, {
        cursor: {
          lineNumber: e.position.lineNumber,
          column: e.position.column,
        },
      });
    });
    editor.onDidChangeCursorSelection(updateExecutableSql);
    editor.onDidChangeModel(updateExecutableSql);
    updateExecutableSql();
    editor.onDidScrollChange((e) => {
      patch(activeRef.current.id, { scrollTop: e.scrollTop });
    });
    const t = activeRef.current;
    if (t.cursor) editor.setPosition(t.cursor);
    if (t.scrollTop) editor.setScrollTop(t.scrollTop);
  };
  async function cancel() {
    if (!activeRun) return;
    try {
      const run = await api<QueryRun>(
        `/api/query-runs/${activeRun.id}/cancel`,
        { method: "POST" },
      );
      setRuns((s) => ({ ...s, [active.id]: run }));
    } catch (e) {
      p.onNotify(describeError(e).details, "error");
    }
  }
  async function save() {
    setSaving(true);
    setSaveError("");
    try {
      const targetId = activeRef.current.id;
      // Publish the local draft first: a saved-query update must not echo an
      // older server editor over keystrokes made during this explicit save.
      await documentSync.flush();
      // Acknowledgements or agent edits may arrive while flushing. Keep the
      // original target even if focus changed, but save its latest revision.
      const t = documentSync.sync.tabs.find((tab) => tab.id === targetId);
      if (!t) throw new Error("SQL-файл был закрыт до сохранения");
      const c = p.connections.find(
        (c) => c.id === (t.connectionId || p.activeConnectionId),
      );
      if (!c) throw new Error("Сначала выберите подключение");
      const saved = await api<QueryDocument>(
        `/api/queries${t.queryId ? "/" + t.queryId : ""}`,
        {
          method: t.queryId ? "PATCH" : "POST",
          body: json({
            name: sqlFileName(saveName),
            connectionId: c.id,
            sql: t.sql,
            database: t.database ?? c.database,
            catalog: t.catalog ?? c.catalog,
            schema: t.schema ?? c.schema,
            ...(hasDatePlaceholder(t.sql, c.engine) && t.dateRange
              ? { dateRange: t.dateRange }
              : {}),
            ...(t.queryId ? { baseRevision: t.revision } : {}),
          }),
        },
      );
      patch(t.id, {
        queryId: saved.id,
        revision: saved.revision,
        name: saved.name,
      });
      setSaveOpen(false);
      p.onQueriesChanged();
      p.onNotify("Запрос сохранён", "success");
    } catch (e) {
      setSaveError(describeError(e).details);
    } finally {
      setSaving(false);
    }
  }
  function addTab() {
    const t = {
      id: crypto.randomUUID(),
      name: `query_${tabs.length + 1}.sql`,
      sql: "",
      connectionId: p.activeConnectionId,
    };
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
  }
  function closeTab(id: string) {
    if (tabs.length === 1) {
      p.onNotify("Оставьте хотя бы одну вкладку", "info");
      return;
    }
    pollers.current.get(id)?.abort();
    void documentSync.sync
      .remove(id)
      .catch((e) => p.onNotify(describeError(e).details, "error"));
  }
  let layout: Record<string, number> | undefined;
  try {
    layout =
      JSON.parse(
        localStorage.getItem(`miracle:editor-layout:${p.workspaceId}`) ||
          "null",
      ) || undefined;
  } catch {}
  return (
    <section
      className="sql-workspace"
      aria-label="SQL-редактор"
      // Monaco's EditContext uses a div, which document-level canvas shortcuts
      // do not recognize as an input. Let the editor handle keys, then isolate
      // them from the adjacent board (including Space and Backspace/Delete).
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      {documentSync.error && (
        <div className="query-error">
          <ErrorBox>{documentSync.error}</ErrorBox>
          <button
            className="text-button"
            onClick={() => void documentSync.flush().catch(() => {})}
          >
            Повторить сохранение
          </button>
        </div>
      )}
      {[...documentSync.sync.conflicts.keys()].map((id) => (
        <div className="query-error" key={id} role="alert">
          <span>
            SQL изменён в другом окне или агентом. Ваш черновик сохранён.
          </span>
          <button
            className="text-button"
            onClick={() => documentSync.sync.keepAsCopy(id)}
          >
            Сохранить мой черновик копией
          </button>
          <button
            className="text-button"
            onClick={() => documentSync.sync.useServer(id)}
          >
            Загрузить серверную версию
          </button>
        </div>
      ))}
      <div className="sql-tabs-bar">
        <div className="query-tabs" role="tablist" aria-label="Запросы">
          {tabs.map((t) => (
            <div
              key={t.id}
              ref={t.id === active.id ? activeTabRef : undefined}
              className={`query-tab ${t.id === active.id ? "active" : ""}`}
            >
              <button
                role="tab"
                aria-selected={t.id === active.id}
                onClick={() => setActiveId(t.id)}
              >
                <Code size={13} />
                <span>{t.name}</span>
                {runs[t.id]?.status === "running" && <Spinner />}
                {!t.queryId && (
                  <i className="unsaved-dot" title="Личный черновик" />
                )}
              </button>
              <IconButton
                label={`Закрыть вкладку ${t.name}`}
                disabled={["running", "cancelling"].includes(
                  runs[t.id]?.status || "",
                )}
                onClick={() => closeTab(t.id)}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          <IconButton label="Новый SQL-файл" onClick={addTab}>
            <Plus size={15} />
          </IconButton>
        </div>
        <div className="sql-pane-controls">
          <IconButton label="Развернуть SQL" onClick={p.onMaximize}>
            <ArrowsOutSimple size={16} />
          </IconButton>
          <IconButton label="Свернуть SQL" onClick={p.onCollapse}>
            <Minus size={16} />
          </IconButton>
        </div>
      </div>
      <div className="sql-toolbar">
        <div className="sql-connection">
          <Database size={14} />
          <Select
            aria-label="Подключение запроса"
            value={connection?.id || ""}
            placeholder="Выберите источник"
            options={p.connections.map((c) => ({ value: c.id, label: c.name }))}
            onValueChange={(value) => {
              const c = p.connections.find((c) => c.id === value);
              patch(active.id, {
                connectionId: value,
                database: c?.database,
                catalog: c?.catalog,
                schema: c?.schema,
              });
              p.onConnectionChange(value);
            }}
          />
        </div>
        <div className="sql-toolbar-actions">
          <input
            ref={importInput}
            type="file"
            accept=".sql"
            multiple
            hidden
            onChange={(e) => void importFiles(e.target.files)}
          />
          <IconButton
            label="Сохранить SQL-файл (⌘S / Ctrl+S)"
            onClick={() => {
              setSaveName(active.name);
              setSaveError("");
              setSaveOpen(true);
            }}
          >
            <FloppyDisk size={16} />
          </IconButton>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <IconButton label="Действия SQL">
                <DotsThree size={20} />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="dropdown-menu"
                align="end"
                sideOffset={6}
                collisionPadding={8}
                onCloseAutoFocus={(event) => {
                  if (!restoreEditorFocus.current) return;
                  restoreEditorFocus.current = false;
                  if (editorRef.current) {
                    event.preventDefault();
                    editorRef.current.focus();
                  }
                }}
              >
                <DropdownMenu.Item
                  onSelect={() => importInput.current?.click()}
                >
                  <FolderOpen size={16} /> Открыть .sql файлы
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={downloadFile}>
                  <DownloadSimple size={16} /> Скачать .sql файл
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  onSelect={() => {
                    restoreEditorFocus.current = true;
                    formatActive();
                  }}
                >
                  <TextAlignLeft size={16} /> Форматировать SQL
                  <span>⌥⌘L</span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  onSelect={() =>
                    group.current?.setLayout({ editor: 55, results: 45 })
                  }
                >
                  <Rows size={16} /> Восстановить размеры SQL и результата
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {running ? (
            <button
              className="button run-button stopping"
              onClick={cancel}
              disabled={activeRun.status === "cancelling"}
            >
              <Square weight="fill" size={11} />
              {activeRun.status === "cancelling" ? "Остановка…" : "Остановить"}
            </button>
          ) : (
            <button
              className="button run-button"
              title={
                dateMode
                  ? "Выполнить запрос для диапазона дат (⌘ / Ctrl + Enter)"
                  : "Выполнить запрос под курсором или выделенный SQL (⌘ / Ctrl + Enter)"
              }
              disabled={launching}
              onClick={run}
            >
              {launching ? (
                <Spinner />
              ) : dateMode ? (
                <CalendarBlank size={14} />
              ) : (
                <Play weight="fill" size={12} />
              )}
              {launching ? "Запускаем…" : dateMode ? "По датам" : "Выполнить"}
              <span className="shortcut">⌘ ↵</span>
            </button>
          )}
        </div>
      </div>
      {connection && (
        <div className="query-context">
          {connection.engine === "trino" ? (
            <>
              <label>
                Каталог
                <input
                  aria-label="Каталог запроса"
                  value={active.catalog ?? connection.catalog ?? ""}
                  placeholder="catalog"
                  onChange={(e) =>
                    patch(active.id, { catalog: e.target.value })
                  }
                />
              </label>
              <label>
                Схема
                <input
                  aria-label="Схема запроса"
                  value={active.schema ?? connection.schema ?? ""}
                  placeholder="schema"
                  onChange={(e) => patch(active.id, { schema: e.target.value })}
                />
              </label>
            </>
          ) : (
            <label>
              База
              <input
                aria-label="База запроса"
                value={active.database ?? connection.database ?? ""}
                placeholder="default"
                onChange={(e) => patch(active.id, { database: e.target.value })}
              />
            </label>
          )}
          <span className="readonly-tag">READ ONLY</span>
        </div>
      )}
      <Group
        orientation="vertical"
        groupRef={group}
        defaultLayout={layout || { editor: 55, results: 45 }}
        onLayoutChanged={(l) => {
          localStorage.setItem(
            `miracle:editor-layout:${p.workspaceId}`,
            JSON.stringify(l),
          );
          setResultExpanded((l.results || 0) > 0);
        }}
        className="editor-results-group"
      >
        <Panel id="editor" defaultSize="55%" minSize="100px" collapsible>
          <div className="editor-area">
            <Editor
              path={`miracle-query://${p.workspaceId}/${active.id}.sql`}
              defaultValue={active.sql}
              onChange={(value) => patch(active.id, { sql: value || "" })}
              language={sqlLanguageForEngine(connection?.engine)}
              theme="miracle-dark"
              onMount={mount}
              saveViewState
              keepCurrentModel
              loading={
                <div className="editor-loading">
                  <Spinner />
                  Открываем редактор…
                </div>
              }
              options={{
                fontSize: 13,
                fontFamily:
                  '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
                lineHeight: 23,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                padding: { top: 18, bottom: 14 },
                lineNumbersMinChars: 3,
                renderLineHighlight: "line",
                automaticLayout: true,
                wordWrap: "off",
                tabSize: 4,
                ariaLabel: "Редактор SQL",
                quickSuggestions: true,
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                scrollbar: {
                  verticalScrollbarSize: 7,
                  horizontalScrollbarSize: 7,
                },
                stickyScroll: { enabled: false },
              }}
            />
            <div className="editor-status">
              <span>
                {!connection
                  ? "SQL"
                  : connection.engine === "trino"
                    ? "Trino SQL"
                    : "ClickHouse SQL"}
              </span>
              <span>
                Стр {cursor.lineNumber}, стлб {cursor.column}
                <span className="footer-divider" />
                UTF-8
              </span>
            </div>
          </div>
        </Panel>
        <Separator
          className="resize-separator horizontal"
          onDoubleClick={() =>
            group.current?.setLayout({ editor: 55, results: 45 })
          }
          aria-label="Размер редактора и результатов"
        />
        <Panel id="results" defaultSize="45%" minSize="120px" collapsible>
          <div className="query-results">
            <div className="results-heading">
              <span>
                <Table size={15} />
                <strong>Результат</strong>
                {result && (
                  <span className="count-badge">
                    {result.rowCount.toLocaleString("ru-RU")}
                  </span>
                )}
              </span>
              <div>
                {activeRun && (
                  <span className={`run-status ${activeRun.status}`}>
                    {running ? (
                      <Spinner />
                    ) : activeRun.status === "completed" ? (
                      <CheckCircle size={13} />
                    ) : (
                      <WarningCircle size={13} />
                    )}
                    <span>
                      {running
                        ? "Выполняется"
                        : activeRun.status === "completed"
                          ? `${((activeRun.elapsedMs ?? new Date(activeRun.finishedAt || 0).getTime() - new Date(activeRun.startedAt).getTime()) / 1000).toFixed(2)} с`
                          : activeRun.status === "cancelled"
                            ? "Отменён"
                            : "Ошибка"}
                    </span>
                  </span>
                )}
                {result && (
                  <>
                    <IconButton
                      label="Добавить результат на доску"
                      className="add-to-board"
                      disabled={Boolean(activeRun?.batch && running)}
                      draggable={!(activeRun?.batch && running)}
                      title={
                        activeRun?.batch && running
                          ? "Дождитесь завершения серии, чтобы закрепить снимок"
                          : "Добавить на доску · можно перетащить в нужное место"
                      }
                      onClick={() => p.onResult(result)}
                      onDragStart={(e) => {
                        if (activeRun?.batch && running) {
                          e.preventDefault();
                          return;
                        }
                        e.dataTransfer.setData(
                          "application/x-miracle-result",
                          JSON.stringify(result),
                        );
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                    >
                      <SquaresFour size={17} />
                    </IconButton>
                  </>
                )}
                <IconButton
                  label="Развернуть результат"
                  onClick={() =>
                    group.current?.setLayout({ editor: 0, results: 100 })
                  }
                >
                  <ArrowsOutSimple size={13} />
                </IconButton>
              </div>
            </div>
            {activeRun?.batch && <DateBatchProgress run={activeRun} />}
            {trackingErrors[active.id] && (
              <div className="query-error">
                <ErrorBox
                  error={trackingErrors[active.id].message}
                  title="Не удалось получить статус или результат запроса."
                  hint="Нажмите «Обновить результат», чтобы проверить текущий запуск. Повторно выполнять SQL не требуется."
                />
                <small>
                  {trackingErrors[active.id].paused
                    ? "Не удалось обновить статус или результат. Выполнение на сервере продолжается независимо от этой вкладки."
                    : "Связь с сервером прервалась. Повторяем обновление…"}
                </small>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    const runId = activeRun?.id || active.runId;
                    if (runId) void track(active.id, runId);
                  }}
                >
                  Обновить результат
                </button>
              </div>
            )}
            {runError && (
              <div className="query-error">
                <ErrorBox context="query">{runError}</ErrorBox>
              </div>
            )}
            {result && activeRun && result.id !== activeRun.resultSetId && (
              <div className="query-error">
                <small>Показан результат предыдущего запуска.</small>
              </div>
            )}
            {result ? (
              <ResultTable
                key={result.id}
                result={result}
                onNotify={p.onNotify}
              />
            ) : !p.connections.length ? (
              <EmptyState
                icon={<Database size={27} />}
                title="Подключите первый источник"
                description="Добавьте ClickHouse или Trino, чтобы выполнить свой первый SQL-запрос."
                action={
                  <button
                    className="button primary"
                    onClick={p.onOpenConnections}
                  >
                    <Plus size={16} /> Подключить источник
                  </button>
                }
              />
            ) : (
              <EmptyState
                icon={<Table size={27} />}
                title={
                  running ? "Запрос выполняется" : "Здесь появятся ваши данные"
                }
                description={
                  running
                    ? activeRun?.batch
                      ? "Строки появятся после первого успешного запроса."
                      : "Результат сохранится после завершения запроса."
                    : "Выберите источник, напишите SQL и нажмите «Выполнить»."
                }
                action={
                  !running && (
                    <span className="keyboard-hint">
                      <kbd>⌘ / Ctrl</kbd>
                      <span>+</span>
                      <kbd>Enter</kbd>
                    </span>
                  )
                }
              />
            )}
          </div>
        </Panel>
      </Group>
      <DateBatchDialog
        open={Boolean(batchRequest)}
        initial={batchRequest?.initial}
        onOpenChange={(open) => {
          if (!open) setBatchRequest(null);
        }}
        onSubmit={async (options) => {
          if (!batchRequest) return;
          await startRun(batchRequest.tabId, {
            ...batchRequest.source,
            dateRange: options,
          });
          setBatchRequest(null);
        }}
      />
      <Modal
        open={saveOpen}
        dismissible={!saving}
        onOpenChange={setSaveOpen}
        title="Сохранить SQL-файл"
        description="Запрос сохранится в вашей рабочей области."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Название
            <input
              autoFocus
              required
              disabled={saving}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Выручка по месяцам"
              maxLength={160}
            />
          </label>
          {saveError && <ErrorBox>{saveError}</ErrorBox>}
          <div className="modal-actions">
            <button
              type="button"
              className="button"
              onClick={() => setSaveOpen(false)}
              disabled={saving}
            >
              Отмена
            </button>
            <button className="button primary" disabled={saving}>
              {saving ? <Spinner /> : "Сохранить"}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
