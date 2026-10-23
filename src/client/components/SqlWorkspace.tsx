import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/features/wordOperations/register.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import {
  ArrowRight,
  ArrowsOutSimple,
  CaretDown,
  Code,
  Database,
  DotsSixVertical,
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
} from "@phosphor-icons/react";
import type {
  Connection,
  QueryDocument,
  QueryRun,
  QuerySource,
  ResultSet,
  SchemaTable,
  SqlFunctionCatalog,
  User,
} from "../../shared/types";
import { api, json, waitForRun } from "../api";
import { EmptyState, ErrorBox, IconButton, Modal, Spinner } from "./UI";
import ResultTable from "./ResultTable";
import { Select } from "./Select";
import { formatSql, sqlFileName } from "../sql-files";
import { sqlStatementAt } from "../sql-statements";
import { createSqlMetadataLoader, sqlSuggestions } from "../sql-completion";
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
    { token: "keyword", foreground: "C792EA" },
    { token: "string", foreground: "C3D58B" },
    { token: "number", foreground: "F3B77B" },
    { token: "comment", foreground: "636E81", fontStyle: "italic" },
    { token: "operator", foreground: "8BB8E8" },
  ],
  colors: {
    "editor.background": "#1c1f25",
    "editor.foreground": "#d9dfeb",
    "editorLineNumber.foreground": "#505b6d",
    "editorLineNumber.activeForeground": "#a6b3c8",
    "editor.lineHighlightBackground": "#232832",
    "editor.selectionBackground": "#36475f",
    "editorCursor.foreground": "#91b4ee",
    "editorWidget.background": "#242933",
    "editorWidget.border": "#3b4352",
    "editorSuggestWidget.background": "#252a34",
    "editorSuggestWidget.selectedBackground": "#374253",
    "editorIndentGuide.background1": "#292f39",
  },
});
interface Tab {
  id: string;
  name: string;
  sql: string;
  connectionId: string;
  database?: string;
  catalog?: string;
  schema?: string;
  queryId?: string;
  revision?: number;
  resultSetId?: string;
  runId?: string;
  cursor?: { lineNumber: number; column: number };
  scrollTop?: number;
}
export interface SqlSourceRequest {
  source: QuerySource;
  name?: string;
}
interface Props {
  user: User;
  connections: Connection[];
  activeConnectionId: string;
  onConnectionChange: (id: string) => void;
  schema: SchemaTable[];
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
  const storage = `miracle:sql-tabs:${p.user.id}`;
  const [tabs, setTabs] = useState<Tab[]>(() =>
    loadTabs(storage).length
      ? loadTabs(storage)
      : [
          {
            id: crypto.randomUUID(),
            name: "query_1.sql",
            sql: "",
            connectionId: p.activeConnectionId,
          },
        ],
  );
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
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState("");
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const completionMetadata = useRef(createSqlMetadataLoader(api));
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
  const running =
    activeRun && ["running", "cancelling"].includes(activeRun.status);
  const connection = p.connections.find(
    (c) => c.id === (active.connectionId || p.activeConnectionId),
  );
  const patch = useCallback(
    (id: string, values: Partial<Tab>) =>
      setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...values } : t))),
    [],
  );
  useEffect(() => {
    const timer = setTimeout(
      () => localStorage.setItem(storage, JSON.stringify(tabs)),
      250,
    );
    return () => clearTimeout(timer);
  }, [tabs, storage]);
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
    try {
      const final = await waitForRun(
        id,
        (r) => setRuns((s) => ({ ...s, [tabId]: r })),
        controller.signal,
      );
      if (final.status === "completed" && final.resultSetId) {
        const saved = await api<ResultSet>(
          `/api/result-sets/${final.resultSetId}`,
          { signal: controller.signal },
        );
        setResults((s) => ({ ...s, [tabId]: saved }));
        patch(tabId, { resultSetId: saved.id });
      } else if (final.status === "failed" || final.status === "interrupted")
        p.onNotify(final.error || "Запрос не завершён", "error");
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        p.onNotify((e as Error).message, "error");
    } finally {
      if (pollers.current.get(tabId) === controller)
        pollers.current.delete(tabId);
    }
  }
  useEffect(() => {
    for (const t of tabs) {
      if (t.resultSetId)
        api<ResultSet>(`/api/result-sets/${t.resultSetId}`)
          .then((r) => setResults((s) => ({ ...s, [t.id]: r })))
          .catch(() => {});
      if (t.runId) void track(t.id, t.runId);
    }
    return () => {
      for (const c of pollers.current.values()) c.abort();
    };
  }, []);
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
      void completionMetadata.current.schema(connection.id).catch(() => {});
    if (connection?.engine === "clickhouse")
      void completionMetadata.current
        .functionCatalog(connection.id)
        .catch(() => {});
  }, [connection]);
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
          let tables: SchemaTable[] = [];
          let functions: SqlFunctionCatalog | undefined;
          let metadataReady = true;
          if (connectionId) {
            const requests = [
              completionMetadata.current
                .tables(connectionId, sql, context, beforeCursor)
                .then((value) => {
                  tables = value;
                }),
              ...(context.engine === "clickhouse"
                ? [
                    completionMetadata.current
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
            incomplete: !metadataReady || context.engine === "clickhouse",
            suggestions: sqlSuggestions(
              sql,
              beforeCursor,
              tables,
              context,
              functions,
            ).map((suggestion) => ({
              ...suggestion,
              kind: kinds[suggestion.kind],
              range,
            })),
          };
        },
      },
    );
    return () => provider.dispose();
  }, [connection, p.activeConnectionId, p.connections]);
  async function run() {
    const tab = activeRef.current;
    if (p.user.role === "viewer") return;
    const conn = p.connections.find(
      (c) => c.id === (tab.connectionId || p.activeConnectionId),
    );
    if (!conn) {
      p.onOpenConnections();
      return;
    }
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const position = editor?.getPosition();
    if (
      !model ||
      !position ||
      model.uri.toString() !== `miracle-query://${p.user.id}/${tab.id}.sql`
    ) {
      p.onNotify("Редактор ещё открывает файл. Повторите запуск.", "info");
      return;
    }
    const selected = selection ? model.getValueInRange(selection).trim() : "";
    const sql =
      selected ||
      sqlStatementAt(
        model.getValue(),
        model.getOffsetAt(position),
        conn.engine,
      );
    if (!sql) {
      p.onNotify(
        "Нет SQL для запуска. Поставьте курсор на запрос или выделите SQL.",
        "info",
      );
      return;
    }
    p.onConnectionChange(conn.id);
    try {
      const started = await api<QueryRun>("/api/query-runs", {
        method: "POST",
        body: json({
          connectionId: conn.id,
          sql,
          database: tab.database ?? conn.database,
          catalog: tab.catalog ?? conn.catalog,
          schema: tab.schema ?? conn.schema,
        }),
      });
      setRuns((s) => ({ ...s, [tab.id]: started }));
      patch(tab.id, { runId: started.id, connectionId: conn.id });
      if (!resultExpanded) {
        group.current?.setLayout({ editor: 55, results: 45 });
        setResultExpanded(true);
      }
      void track(tab.id, started.id);
    } catch (e) {
      p.onNotify((e as Error).message, "error");
    }
  }
  runAction.current = () => {
    if (!running) void run();
  };
  function formatActive() {
    if (p.user.role === "viewer") return;
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
    if (p.user.role === "viewer") return;
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
      setCursor(e.position);
      patch(activeRef.current.id, {
        cursor: {
          lineNumber: e.position.lineNumber,
          column: e.position.column,
        },
      });
    });
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
      p.onNotify((e as Error).message, "error");
    }
  }
  async function save() {
    setSaving(true);
    setSaveError("");
    try {
      const t = activeRef.current;
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
      p.onNotify("Запрос сохранён для команды", "success");
    } catch (e) {
      setSaveError((e as Error).message);
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
    setTabs((ts) => ts.filter((t) => t.id !== id));
  }
  let layout: Record<string, number> | undefined;
  try {
    layout =
      JSON.parse(
        localStorage.getItem(`miracle:editor-layout:${p.user.id}`) || "null",
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
      <div className="pane-heading">
        <span>
          <Code size={16} />
          <strong>SQL-редактор</strong>
        </span>
        <div>
          <IconButton label="Развернуть SQL" onClick={p.onMaximize}>
            <ArrowsOutSimple size={14} />
          </IconButton>
          <IconButton label="Свернуть SQL" onClick={p.onCollapse}>
            <Minus size={15} />
          </IconButton>
        </div>
      </div>
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
            label="Открыть .sql файлы"
            onClick={() => importInput.current?.click()}
          >
            <FolderOpen size={16} />
          </IconButton>
          <IconButton label="Скачать .sql файл" onClick={downloadFile}>
            <DownloadSimple size={16} />
          </IconButton>
          <IconButton
            label="Форматировать SQL (⌥⌘L / Ctrl+Alt+L)"
            disabled={p.user.role === "viewer"}
            onClick={formatActive}
          >
            <TextAlignLeft size={16} />
          </IconButton>
          <IconButton
            label="Сохранить SQL-файл (⌘S / Ctrl+S)"
            disabled={p.user.role === "viewer"}
            onClick={() => {
              setSaveName(active.name);
              setSaveError("");
              setSaveOpen(true);
            }}
          >
            <FloppyDisk size={16} />
          </IconButton>
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
              title="Выполнить запрос под курсором или выделенный SQL (⌘ / Ctrl + Enter)"
              disabled={p.user.role === "viewer"}
              onClick={run}
            >
              <Play weight="fill" size={12} />
              Выполнить<span className="shortcut">⌘ ↵</span>
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
            `miracle:editor-layout:${p.user.id}`,
            JSON.stringify(l),
          );
          setResultExpanded((l.results || 0) > 0);
        }}
        className="editor-results-group"
      >
        <Panel id="editor" defaultSize="55%" minSize="100px" collapsible>
          <div className="editor-area">
            <Editor
              path={`miracle-query://${p.user.id}/${active.id}.sql`}
              value={active.sql}
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
                readOnly: p.user.role === "viewer",
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
                {result && p.user.role !== "viewer" && (
                  <>
                    <span
                      role="button"
                      tabIndex={0}
                      className="result-drag-handle"
                      draggable
                      aria-label="Перетащить результат на доску"
                      title="Перетащить результат на доску"
                      onDragStart={(e) => {
                        e.dataTransfer.setData(
                          "application/x-miracle-result",
                          JSON.stringify(result),
                        );
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          p.onResult(result);
                        }
                      }}
                    >
                      <DotsSixVertical size={16} />
                    </span>
                    <button
                      className="button small add-to-board"
                      onClick={() => p.onResult(result)}
                    >
                      На доску
                      <ArrowRight size={13} />
                    </button>
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
            {activeRun?.error && (
              <div className="query-error">
                <ErrorBox>{activeRun.error}</ErrorBox>
                {result && (
                  <small>Показан предыдущий успешный результат.</small>
                )}
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
                description={
                  p.user.role === "admin"
                    ? "Добавьте ClickHouse или Trino, чтобы выполнить свой первый SQL-запрос."
                    : "Администратор рабочей области может добавить ClickHouse или Trino."
                }
                action={
                  p.user.role === "admin" && (
                    <button
                      className="button primary"
                      onClick={p.onOpenConnections}
                    >
                      <Plus size={16} /> Подключить источник
                    </button>
                  )
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
                    ? "Результат сохранится после завершения запроса."
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
      <div className="sql-bottom-bar">
        <span>
          <span className="status-dot" />
          Черновик сохранён на устройстве
        </span>
        <button
          onClick={() => group.current?.setLayout({ editor: 55, results: 45 })}
        >
          Вернуть панели
        </button>
      </div>
      <Modal
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title="Сохранить SQL-файл"
        description="Запрос будет доступен всей команде."
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
