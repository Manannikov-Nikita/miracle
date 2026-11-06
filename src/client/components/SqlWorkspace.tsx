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
import type { ProjectTextFile } from "../../shared/project-files";
import {
  isSqlProjectFile,
  loadProjectFileDrafts,
  type ProjectFileDraft,
} from "../project-file-drafts";
import ProjectTextEditor from "./ProjectTextEditor";
import type { ProjectGitEditorState } from "../git/ProjectGitButton";
import { describeError } from "../error-message";
import type { EditorDocument } from "../../shared/agents";
import {
  documentToTab,
  acknowledgeEditor,
  tabFields,
  type EditorTab,
} from "../agents/editor-sync";
import {
  loadEditorDocuments,
  recoveryKey,
  useEditorSync,
} from "../agents/useEditorSync";
import { useProjectSync } from "../agents/ProjectSync";
import {
  currentAgentWork,
  editorAgentWork,
  useAgentWorkLocks,
} from "../agents/useAgentWork";
import { AgentWorkIndicator } from "../agents/AgentWorkIndicator";
import { hasDatePlaceholder } from "../../shared/date-batch";
import DateBatchDialog from "./DateBatchDialog";
import DateBatchProgress from "./DateBatchProgress";
import { QueryDuration } from "./QueryTiming";
import { EmptyState, ErrorBox, IconButton, Modal, Spinner } from "./UI";
import ResultTable from "./ResultTable";
import ResultCanvasActions from "./ResultCanvasActions";
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
    "editorSuggestWidget.border": "#45484e",
    "editorSuggestWidget.foreground": "#eeeff0",
    "editorSuggestWidget.selectedBackground": "#35443c",
    "editorSuggestWidget.selectedForeground": "#eeeff0",
    "editorSuggestWidget.selectedIconForeground": "#b9d3c5",
    "editorSuggestWidget.highlightForeground": "#b5f0d0",
    "editorSuggestWidget.focusHighlightForeground": "#b5f0d0",
    "editorIndentGuide.background1": "#303338",
  },
});
type Tab = EditorTab;
export interface SqlSourceRequest {
  source: QuerySource;
  name?: string;
  run?: QueryRun;
}
interface Props {
  workspaceId: string;
  connections: Connection[];
  activeConnectionId: string;
  onConnectionChange: (id: string) => void;
  metadata: MetadataStore;
  sourceToOpen?: SqlSourceRequest | null;
  savedToOpen?: QueryDocument | null;
  fileToOpen?: ProjectTextFile | null;
  onFileConsumed?: () => void;
  onProjectFileSaved?: () => void;
  onGitEditorStateChange?: (state: ProjectGitEditorState | null) => void;
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
function isEditorLayout(
  value: unknown,
): value is { editor: number; results: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const layout = value as Record<string, unknown>;
  return (
    Object.keys(layout).length === 2 &&
    [layout.editor, layout.results].every(
      (size) =>
        typeof size === "number" &&
        Number.isFinite(size) &&
        size >= 0 &&
        size <= 100,
    ) &&
    Math.abs((layout.editor as number) + (layout.results as number) - 100) <=
      0.01
  );
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
  const [editorOverlays, setEditorOverlays] = useState<HTMLDivElement | null>(
    null,
  );
  useEffect(() => {
    // Monaco reads this host at construction. Keep floating widgets outside the
    // clipped resizable panels, while retaining Monaco's theme/style ancestor.
    const host = document.createElement("div");
    host.className = "monaco-editor vs-dark miracle-editor-overlays";
    document.body.append(host);
    setEditorOverlays(host);
    return () => host.remove();
  }, []);
  const storage = `miracle:sql-tabs:${p.workspaceId}`;
  const [files, setFiles] = useState<ProjectFileDraft[]>(() =>
    loadProjectFileDrafts(p.workspaceId),
  );
  const filesRef = useRef(files);
  filesRef.current = files;
  const recoveryFailed = useRef(false);
  const [fileSaving, setFileSaving] = useState(new Set<string>());
  const fileSavingRef = useRef(new Set<string>());
  const pendingFileRefresh = useRef(new Set<string>());
  const fileRefreshVersions = useRef(new Map<string, number>());
  const refreshFile = useRef<(id: string) => Promise<void>>(async () => {});
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
  const [closeFileId, setCloseFileId] = useState<string | null>(null);
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
    for (const file of files) {
      if (
        isSqlProjectFile(file.path) &&
        !initial.some((tab) => tab.id === file.id)
      ) {
        initial.push({
          id: file.id,
          name: file.name,
          sql: file.content,
          connectionId: p.activeConnectionId,
        });
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
    (id) => filesRef.current.find((file) => file.id === id)?.path,
  );
  const projectSync = useProjectSync();
  useAgentWorkLocks();
  const [activeId, setActiveId] = useState(
    () => localStorage.getItem(`${storage}:active`) || "",
  );
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const workForId = useCallback(
    (id: string) =>
      editorAgentWork(
        currentAgentWork(projectSync),
        tabsRef.current.find((tab) => tab.id === id) ?? { id },
        filesRef.current.find((file) => file.id === id)?.path,
      ),
    [projectSync],
  );
  const active = tabs.find((t) => t.id === activeId) || tabs[0];
  const activeFile = files.find((file) => file.id === activeId);
  const activeTextFile =
    activeFile && !isSqlProjectFile(activeFile.path) ? activeFile : undefined;
  const activeTextFileRef = useRef(activeTextFile);
  activeTextFileRef.current = activeTextFile;
  const visibleId = activeTextFile?.id || active.id;
  const activeWork = workForId(visibleId);
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
  }, [visibleId]);
  const [results, setResults] = useState<Record<string, ResultSet>>({});
  const [runs, setRuns] = useState<Record<string, QueryRun>>({});
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const [runActions, setRunActions] = useState<
    Record<string, "resume" | "cancel">
  >({});
  const runActionsRef = useRef(new Map<string, "resume" | "cancel">());
  const [runActionErrors, setRunActionErrors] = useState<
    Record<string, string>
  >({});
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
  const runError =
    summarizedBatchError || activeRun?.status === "paused"
      ? undefined
      : activeRun?.error;
  const running =
    activeRun && ["running", "cancelling"].includes(activeRun.status);
  const paused = activeRun?.status === "paused";
  const unfinished = running || paused;
  const restoringRun = Boolean(active.runId && !activeRun);
  const launching = launchingTabs.has(active.id);
  const connection = p.connections.find(
    (c) => c.id === (active.connectionId || p.activeConnectionId),
  );
  const patch = useCallback(
    (id: string, values: Partial<Tab>) => {
      if (
        Object.keys(values).some(
          (key) => !["cursor", "scrollTop"].includes(key),
        ) &&
        workForId(id)
      )
        return;
      setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...values } : t)));
    },
    [workForId],
  );
  const acknowledge = useCallback(
    (
      id: string,
      before: Tab,
      values: Partial<Tab>,
      identity: (keyof Tab)[],
    ) => {
      // Confirmations are not new user edits. Rebase only unchanged fields onto
      // the latest streamed document; the normal flush still honors its claim.
      const next = documentSync.sync.tabs.map((tab) =>
        tab.id === id ? acknowledgeEditor(tab, before, values, identity) : tab,
      );
      tabsRef.current = next;
      documentSync.sync.local(next);
      setTabs(next);
      return next.find((tab) => tab.id === id);
    },
    [documentSync.sync],
  );
  useEffect(() => {
    if (!projectSync) return;
    return projectSync.register("editor", {
      editorTabs: () => [
        ...tabsRef.current.map((tab) => {
          const file = filesRef.current.find((item) => item.id === tab.id);
          return {
            id: tab.id,
            name: tab.name,
            ...(file ? { path: file.path } : {}),
          };
        }),
        ...filesRef.current
          .filter((file) => !isSqlProjectFile(file.path))
          .map((file) => ({ id: file.id, name: file.name, path: file.path })),
      ],
      context: () => {
        if (
          activeTextFileRef.current ||
          filesRef.current.some((file) => file.id === activeRef.current.id)
        )
          return {};
        const editor = editorRef.current,
          selection = editor?.getSelection();
        return {
          editorDocumentId: activeRef.current.id,
          selection: selection
            ? editor?.getModel()?.getValueInRange(selection) || undefined
            : undefined,
        };
      },
      flush: async (context) => {
        await documentSync.flush();
        // Native files are saved explicitly, so an @ reference must flush its
        // open draft before the agent reads the path. Other file drafts stay local.
        const paths = new Set(context?.filePaths || []);
        for (const file of filesRef.current.filter((item) =>
          paths.has(item.path),
        )) {
          const content =
            tabsRef.current.find((tab) => tab.id === file.id)?.sql ??
            file.content;
          if (
            content !== file.savedContent &&
            !(await saveProjectFile(file.id))
          )
            throw new Error(
              `Не удалось сохранить файл ${file.path} перед отправкой агенту. Проверьте черновик и повторите отправку.`,
            );
        }
      },
    });
  }, [projectSync, documentSync.flush]);
  useEffect(() => {
    projectSync?.contextChanged();
  }, [visibleId, projectSync]);
  useEffect(() => {
    projectSync?.editorTabsChanged?.();
  }, [tabs, files, projectSync]);
  useEffect(() => {
    const recovery = files.map((file) => ({
      ...file,
      content: isSqlProjectFile(file.path)
        ? (tabs.find((tab) => tab.id === file.id)?.sql ?? file.content)
        : file.content,
    }));
    if (recovery.some((file, index) => file.content !== files[index].content)) {
      filesRef.current = recovery;
      setFiles(recovery);
    }
    try {
      localStorage.setItem(
        `miracle:project-files:${p.workspaceId}`,
        JSON.stringify(recovery),
      );
      recoveryFailed.current = false;
    } catch {
      if (!recoveryFailed.current) {
        recoveryFailed.current = true;
        p.onNotify(
          "Не удалось сохранить копию черновиков в браузере. Сохраните файлы на диск перед закрытием страницы.",
          "error",
        );
      }
    }
  }, [files, tabs, p.workspaceId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        files.some(
          (file) =>
            (tabsRef.current.find((tab) => tab.id === file.id)?.sql ??
              file.content) !== file.savedContent,
        )
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [files]);
  useEffect(() => {
    localStorage.setItem(`${storage}:active`, visibleId);
  }, [visibleId, storage]);
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
      tabsRef.current.some((tab) => tab.id === tabId && tab.runId === id);
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
        const requested = tabsRef.current.find((tab) => tab.id === tabId)!;
        try {
          const update = await api<QueryRun>(`/api/query-runs/${id}`, {
            signal: controller.signal,
          });
          if (!valid()) return;
          runsRef.current = { ...runsRef.current, [tabId]: update };
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
              acknowledge(tabId, requested, { resultSetId: saved.id }, [
                "runId",
              ]);
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
          if (
            error instanceof ApiRequestError &&
            error.status === 404 &&
            !runsRef.current[tabId]
          )
            acknowledge(tabId, requested, { runId: undefined }, ["runId"]);
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
  function open(
    source: QuerySource,
    document?: QueryDocument,
    name?: string,
    run?: QueryRun,
  ) {
    const tabName = document?.name || name || "source.sql";
    const existing = tabsRef.current.find((t) =>
      run
        ? t.runId === run.id
        : document
          ? t.queryId === document.id
          : name !== undefined &&
            t.name === tabName &&
            !filesRef.current.some((file) => file.id === t.id),
    );
    if (existing) {
      setActiveId(existing.id);
      p.onConnectionChange(existing.connectionId);
      if (run) void track(existing.id, run.id);
      return;
    }
    const tab: Tab = {
      id: crypto.randomUUID(),
      ...source,
      name: tabName,
      queryId: document?.id,
      revision: document?.revision,
      ...(run ? { runId: run.id, resultSetId: run.resultSetId } : {}),
    };
    // A second open can arrive before React commits the first new tab.
    tabsRef.current = [...tabsRef.current, tab];
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
    p.onConnectionChange(tab.connectionId);
  }
  useEffect(() => {
    if (p.sourceToOpen) {
      open(
        p.sourceToOpen.source,
        undefined,
        p.sourceToOpen.name,
        p.sourceToOpen.run,
      );
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
    const document = p.fileToOpen;
    if (!document) return;
    if (
      isSqlProjectFile(document.path) &&
      document.content.length > 1_000_000
    ) {
      p.onNotify(
        "SQL-файл превышает лимит редактора: 1 000 000 символов.",
        "error",
      );
      p.onFileConsumed?.();
      return;
    }
    let file = filesRef.current.find((file) => file.path === document.path);
    if (!file) {
      file = {
        ...document,
        id: crypto.randomUUID(),
        savedContent: document.content,
      };
      filesRef.current = [...filesRef.current, file];
      setFiles(filesRef.current);
    } else {
      const existingId = file.id;
      const currentContent =
        tabsRef.current.find((tab) => tab.id === existingId)?.sql ??
        file.content;
      if (
        currentContent === file.savedContent &&
        !fileSavingRef.current.has(file.id)
      ) {
        file = { ...document, id: file.id, savedContent: document.content };
        const refreshed = file;
        filesRef.current = filesRef.current.map((existing) =>
          existing.id === refreshed.id ? refreshed : existing,
        );
        setFiles(filesRef.current);
        setFileErrors((errors) => {
          const next = { ...errors };
          delete next[refreshed.id];
          return next;
        });
        if (isSqlProjectFile(file.path))
          patch(file.id, {
            sql: file.content,
            externalSqlRevision: Date.now(),
          });
      }
    }
    // Clean tabs can refresh from disk; dirty tabs retain their original revision.
    if (
      isSqlProjectFile(file.path) &&
      !tabsRef.current.some((tab) => tab.id === file.id)
    ) {
      const tab: Tab = {
        id: file.id,
        name: file.name,
        sql: file.content,
        connectionId: p.activeConnectionId,
      };
      tabsRef.current = [...tabsRef.current, tab];
      setTabs(tabsRef.current);
    }
    setActiveId(file.id);
    p.onFileConsumed?.();
  }, [p.fileToOpen]);
  refreshFile.current = async (id: string) => {
    const file = filesRef.current.find((item) => item.id === id);
    if (!file || workForId(id)) return;
    if (fileSavingRef.current.has(id)) {
      pendingFileRefresh.current.add(id);
      return;
    }
    const version = (fileRefreshVersions.current.get(id) ?? 0) + 1;
    fileRefreshVersions.current.set(id, version);
    try {
      const remote = await api<ProjectTextFile>(
        `/api/project/file?path=${encodeURIComponent(file.path)}`,
      );
      if (fileRefreshVersions.current.get(id) !== version || workForId(id))
        return;
      if (fileSavingRef.current.has(id)) {
        pendingFileRefresh.current.add(id);
        return;
      }
      const latest = filesRef.current.find((item) => item.id === id);
      if (!latest || latest.revision !== file.revision) return;
      const content =
        tabsRef.current.find((tab) => tab.id === id)?.sql ?? latest.content;
      const dirty = content !== latest.savedContent;
      if (
        dirty &&
        remote.content !== latest.savedContent &&
        remote.content !== content
      ) {
        setFileErrors((errors) => ({
          ...errors,
          [id]: "Файл изменён на диске. Ваш черновик сохранён в браузере. Загрузите версию с диска или скачайте свой черновик.",
        }));
        return;
      }
      filesRef.current = filesRef.current.map((item) =>
        item.id === id
          ? {
              ...remote,
              id,
              content: dirty ? content : remote.content,
              savedContent: remote.content,
            }
          : item,
      );
      setFiles(filesRef.current);
      if (!dirty && isSqlProjectFile(file.path))
        patch(id, { sql: remote.content, externalSqlRevision: Date.now() });
      setFileErrors((errors) => {
        const next = { ...errors };
        delete next[id];
        return next;
      });
    } catch (error) {
      setFileErrors((errors) => ({
        ...errors,
        [id]: describeError(error).details,
      }));
    }
  };
  useEffect(() => {
    if (!projectSync) return;
    let previous = currentAgentWork(projectSync);
    const unsubscribe = projectSync.subscribeWork?.((snapshot) => {
      for (const file of filesRef.current) {
        const target = { id: file.id };
        if (editorAgentWork(previous, target, file.path) && !workForId(file.id))
          void refreshFile.current(file.id);
      }
      previous = snapshot.locks;
    });
    const reconnect = projectSync.onReconnect(() => {
      for (const file of filesRef.current) void refreshFile.current(file.id);
    });
    const gitChanged = projectSync.subscribe((event) => {
      if (event.type !== "git.changed") return;
      const action = (event.data as { action?: string })?.action;
      if (action !== "switch" && action !== "create_branch") return;
      for (const file of filesRef.current) void refreshFile.current(file.id);
      p.onProjectFileSaved?.();
    });
    return () => {
      unsubscribe?.();
      reconnect();
      gitChanged();
    };
  }, [projectSync, workForId]);
  async function saveProjectFile(id: string): Promise<boolean> {
    if (workForId(id)) return false;
    const file = filesRef.current.find((file) => file.id === id);
    if (!file || fileSavingRef.current.has(id)) return false;
    const content = isSqlProjectFile(file.path)
      ? (tabsRef.current.find((tab) => tab.id === id)?.sql ?? file.content)
      : file.content;
    fileSavingRef.current.add(id);
    setFileSaving(new Set(fileSavingRef.current));
    setFileErrors((errors) => {
      const next = { ...errors };
      delete next[id];
      return next;
    });
    try {
      const saved = await api<ProjectTextFile>(
        `/api/project/file?path=${encodeURIComponent(file.path)}`,
        {
          method: "PUT",
          body: json({ content, baseRevision: file.revision }),
        },
      );
      // Edits made during the request stay dirty against the acknowledged disk content.
      filesRef.current = filesRef.current.map((latest) =>
        latest.id === id
          ? {
              ...latest,
              revision: saved.revision,
              size: saved.size,
              updatedAt: saved.updatedAt,
              savedContent: saved.content,
            }
          : latest,
      );
      setFiles(filesRef.current);
      p.onProjectFileSaved?.();
      p.onNotify(`Файл ${file.name} сохранён`, "success");
      const latest = filesRef.current.find((item) => item.id === id);
      const latestContent =
        tabsRef.current.find((tab) => tab.id === id)?.sql ?? latest?.content;
      return latestContent === saved.content;
    } catch (error) {
      const message =
        error instanceof ApiRequestError && error.status === 409
          ? "Файл изменён на диске. Ваш черновик сохранён в браузере. Загрузите версию с диска или скачайте свой черновик."
          : describeError(error).details;
      setFileErrors((errors) => ({ ...errors, [id]: message }));
      return false;
    } finally {
      fileSavingRef.current.delete(id);
      setFileSaving(new Set(fileSavingRef.current));
      if (pendingFileRefresh.current.delete(id)) void refreshFile.current(id);
    }
  }
  async function reloadProjectFile(file: ProjectFileDraft) {
    if (workForId(file.id)) return;
    if (fileSavingRef.current.has(file.id)) return;
    const contentBeforeReload =
      tabsRef.current.find((tab) => tab.id === file.id)?.sql ??
      filesRef.current.find((item) => item.id === file.id)?.content;
    try {
      const remote = await api<ProjectTextFile>(
        `/api/project/file?path=${encodeURIComponent(file.path)}`,
      );
      const latestFile = filesRef.current.find((item) => item.id === file.id);
      if (
        !latestFile ||
        fileSavingRef.current.has(file.id) ||
        workForId(file.id)
      )
        return;
      const latestContent =
        tabsRef.current.find((tab) => tab.id === file.id)?.sql ??
        latestFile.content;
      if (latestContent !== contentBeforeReload) {
        p.onNotify(
          "Черновик изменился во время загрузки. Ваши изменения сохранены; повторите загрузку с диска.",
          "info",
        );
        return;
      }
      setFiles((current) =>
        current.map((latest) =>
          latest.id === file.id
            ? { ...remote, id: file.id, savedContent: remote.content }
            : latest,
        ),
      );
      if (isSqlProjectFile(file.path))
        patch(file.id, {
          sql: remote.content,
          externalSqlRevision: Date.now(),
        });
      setFileErrors((errors) => {
        const next = { ...errors };
        delete next[file.id];
        return next;
      });
    } catch (error) {
      p.onNotify(describeError(error).details, "error");
    }
  }
  const hasUnsavedFiles = files.some(
    (file) =>
      (tabs.find((tab) => tab.id === file.id)?.sql ?? file.content) !==
      file.savedContent,
  );
  const prepareGitMutation = useCallback(async () => {
    if (fileSavingRef.current.size)
      throw new Error("Дождитесь сохранения файлов перед действием Git.");
    if (
      filesRef.current.some(
        (file) =>
          (tabsRef.current.find((tab) => tab.id === file.id)?.sql ??
            file.content) !== file.savedContent,
      )
    )
      throw new Error("Сначала сохраните изменения открытых файлов на диск.");
  }, []);
  const refreshGitFiles = useCallback(async () => {
    await Promise.all(
      filesRef.current.map((file) => refreshFile.current(file.id)),
    );
    p.onProjectFileSaved?.();
  }, [p.onProjectFileSaved]);
  useEffect(() => {
    p.onGitEditorStateChange?.({
      hasUnsavedFiles,
      onBeforeMutation: prepareGitMutation,
      onBranchChanged: refreshGitFiles,
    });
  }, [
    p.onGitEditorStateChange,
    hasUnsavedFiles,
    prepareGitMutation,
    refreshGitFiles,
  ]);
  useEffect(
    () => () => p.onGitEditorStateChange?.(null),
    [p.onGitEditorStateChange],
  );
  function downloadProjectDraft(file: ProjectFileDraft) {
    const content =
      tabsRef.current.find((tab) => tab.id === file.id)?.sql ?? file.content;
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function removeProjectFile(id: string) {
    if (workForId(id)) return;
    if (fileSavingRef.current.has(id)) return;
    pollers.current.get(id)?.abort();
    if (tabsRef.current.some((tab) => tab.id === id)) {
      if (tabsRef.current.length === 1) {
        const empty: Tab = {
          id: crypto.randomUUID(),
          name: "query_1.sql",
          sql: "",
          connectionId: p.activeConnectionId,
        };
        tabsRef.current = [...tabsRef.current, empty];
        setTabs(tabsRef.current);
        documentSync.sync.local(tabsRef.current);
      }
      try {
        await documentSync.sync.remove(id);
      } catch (error) {
        p.onNotify(describeError(error).details, "error");
        return;
      }
    }
    setFiles((current) => current.filter((file) => file.id !== id));
    if (activeId === id)
      setActiveId(tabsRef.current.find((tab) => tab.id !== id)?.id || "");
    setCloseFileId(null);
  }
  function closeProjectFile(file: ProjectFileDraft) {
    if (workForId(file.id)) return;
    if (
      ["running", "cancelling", "paused"].includes(
        runsRef.current[file.id]?.status || "",
      )
    )
      return;
    const content =
      tabsRef.current.find((tab) => tab.id === file.id)?.sql ?? file.content;
    if (content !== file.savedContent) setCloseFileId(file.id);
    else void removeProjectFile(file.id);
  }
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
              await Promise.race([
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
            // Recompute substring matches and prefix ranking on each keystroke,
            // including when an earlier query produced no suggestions.
            incomplete: true,
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
    if (workForId(tabId))
      throw new ApiRequestError(
        "Агент работает с этим запросом. Повторите запуск после завершения работы.",
        423,
        "ENTITY_AGENT_LOCKED",
      );
    if (
      launchingRef.current.has(tabId) ||
      (tabsRef.current.find((tab) => tab.id === tabId)?.runId &&
        !runsRef.current[tabId]) ||
      ["running", "cancelling", "paused"].includes(
        runsRef.current[tabId]?.status || "",
      )
    )
      return;
    launchingRef.current.add(tabId);
    const requested = tabsRef.current.find((tab) => tab.id === tabId)!;
    setLaunchingTabs(new Set(launchingRef.current));
    pollers.current.get(tabId)?.abort();
    try {
      const started = await api<QueryRun>("/api/query-runs", {
        method: "POST",
        body: json(source),
      });
      if (!mounted.current || !tabsRef.current.some((tab) => tab.id === tabId))
        return;
      const accepted = acknowledge(
        tabId,
        requested,
        {
          runId: started.id,
          connectionId: source.connectionId,
          ...(source.dateRange ? { dateRange: source.dateRange } : {}),
        },
        ["runId"],
      );
      if (accepted?.runId !== started.id) return;
      setRuns((current) => ({ ...current, [tabId]: started }));
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
    if (activeTextFileRef.current) return;
    const tab = activeRef.current;
    if (workForId(tab.id)) return;
    if (
      launchingRef.current.has(tab.id) ||
      batchRequest ||
      (tab.runId && !runsRef.current[tab.id]) ||
      ["running", "cancelling", "paused"].includes(
        runsRef.current[tab.id]?.status || "",
      )
    )
      return;
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
    if (!unfinished && !launching && !restoringRun) void run();
  };
  function formatActive() {
    if (workForId(activeRef.current.id)) return;
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
    if (workForId(activeTextFileRef.current?.id ?? activeRef.current.id))
      return;
    if (activeFile) {
      void saveProjectFile(activeFile.id);
      return;
    }
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
  async function actOnRun(action: "resume" | "cancel") {
    const tabId = activeRef.current.id;
    if (workForId(tabId)) return;
    const currentRun = runsRef.current[tabId];
    if (!currentRun || runActionsRef.current.has(tabId)) return;
    if (action === "resume" && currentRun.status !== "paused") return;
    runActionsRef.current.set(tabId, action);
    setRunActions(Object.fromEntries(runActionsRef.current));
    setRunActionErrors((current) => ({ ...current, [tabId]: "" }));
    try {
      const run = await api<QueryRun>(
        `/api/query-runs/${currentRun.id}/${action}`,
        { method: "POST" },
      );
      if (!mounted.current || !tabsRef.current.some((tab) => tab.id === tabId))
        return;
      setRuns((s) => ({ ...s, [tabId]: run }));
      void track(tabId, run.id);
    } catch (e) {
      if (!mounted.current) return;
      const message = describeError(e).details;
      setRunActionErrors((current) => ({ ...current, [tabId]: message }));
      p.onNotify(message, "error");
      // An action may have reached the server even when its response was lost.
      // Reconcile the same run instead of leaving a stale paused/cancelling UI.
      void track(tabId, currentRun.id);
    } finally {
      runActionsRef.current.delete(tabId);
      if (mounted.current)
        setRunActions(Object.fromEntries(runActionsRef.current));
    }
  }
  const cancel = () => actOnRun("cancel");
  async function save() {
    if (workForId(activeRef.current.id)) return;
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
      if (workForId(targetId))
        throw new ApiRequestError(
          "Агент работает с этим запросом. Ваш черновик сохранён.",
          423,
          "ENTITY_AGENT_LOCKED",
        );
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
      acknowledge(
        t.id,
        t,
        {
          queryId: saved.id,
          revision: saved.revision,
          name: saved.name,
        },
        ["queryId", "revision"],
      );
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
    if (workForId(id)) return;
    if (
      ["running", "cancelling", "paused"].includes(
        runsRef.current[id]?.status || "",
      )
    )
      return;
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
    const stored: unknown = JSON.parse(
      localStorage.getItem(`miracle:editor-layout:${p.workspaceId}`) || "null",
    );
    if (isEditorLayout(stored)) layout = stored;
  } catch {}
  return (
    <section
      className="sql-workspace"
      aria-label="Редактор проекта"
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
            disabled={Boolean(workForId(id))}
            onClick={() => {
              if (!workForId(id)) documentSync.sync.keepAsCopy(id);
            }}
          >
            Сохранить мой черновик копией
          </button>
          <button
            className="text-button"
            disabled={Boolean(workForId(id))}
            onClick={() => {
              if (!workForId(id)) documentSync.sync.useServer(id);
            }}
          >
            Загрузить серверную версию
          </button>
        </div>
      ))}
      <div className="sql-tabs-bar">
        <div className="query-tabs" role="tablist" aria-label="Файлы и запросы">
          {tabs.map((t) => (
            <div
              key={t.id}
              ref={t.id === visibleId ? activeTabRef : undefined}
              className={`query-tab ${t.id === visibleId ? "active" : ""}${workForId(t.id) ? " agent-work-active" : ""}`}
            >
              <button
                role="tab"
                aria-selected={t.id === visibleId}
                title={files.find((file) => file.id === t.id)?.path || t.name}
                onClick={() => setActiveId(t.id)}
              >
                <Code size={13} />
                <span>{t.name}</span>
                <AgentWorkIndicator work={workForId(t.id)} compact />
                {runs[t.id]?.status === "running" && <Spinner />}
                {(files.some((file) => file.id === t.id)
                  ? files.find((file) => file.id === t.id)!.savedContent !==
                    t.sql
                  : !t.queryId) && (
                  <i className="unsaved-dot" title="Личный черновик" />
                )}
              </button>
              <IconButton
                label={`Закрыть вкладку ${t.name}`}
                disabled={
                  ["running", "cancelling", "paused"].includes(
                    runs[t.id]?.status || "",
                  ) ||
                  fileSaving.has(t.id) ||
                  Boolean(workForId(t.id))
                }
                onClick={() => {
                  const file = files.find((file) => file.id === t.id);
                  file ? closeProjectFile(file) : closeTab(t.id);
                }}
              >
                <X size={12} />
              </IconButton>
            </div>
          ))}
          {files
            .filter((file) => !isSqlProjectFile(file.path))
            .map((file) => (
              <div
                className={`query-tab ${file.id === visibleId ? "active" : ""}${workForId(file.id) ? " agent-work-active" : ""}`}
                key={file.id}
                ref={file.id === visibleId ? activeTabRef : undefined}
              >
                <button
                  role="tab"
                  title={file.path}
                  aria-selected={file.id === visibleId}
                  onClick={() => setActiveId(file.id)}
                >
                  <Code size={13} />
                  <span>{file.name}</span>
                  <AgentWorkIndicator work={workForId(file.id)} compact />
                  {file.content !== file.savedContent && (
                    <i
                      className="unsaved-dot"
                      title="Есть несохранённые изменения"
                    />
                  )}
                </button>
                <IconButton
                  label={`Закрыть вкладку ${file.name}`}
                  disabled={
                    fileSaving.has(file.id) || Boolean(workForId(file.id))
                  }
                  onClick={() => closeProjectFile(file)}
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
          <IconButton label="Развернуть редактор" onClick={p.onMaximize}>
            <ArrowsOutSimple size={16} />
          </IconButton>
          <IconButton label="Свернуть редактор" onClick={p.onCollapse}>
            <Minus size={16} />
          </IconButton>
        </div>
      </div>
      {activeFile && fileErrors[activeFile.id] && (
        <div className="query-error" role="alert">
          <ErrorBox>{fileErrors[activeFile.id]}</ErrorBox>
          <button
            className="text-button"
            disabled={Boolean(activeWork)}
            onClick={() => void saveProjectFile(activeFile.id)}
          >
            Повторить сохранение
          </button>
          <button
            className="text-button"
            onClick={() => downloadProjectDraft(activeFile)}
          >
            Скачать мой черновик
          </button>
          <button
            className="text-button"
            disabled={Boolean(activeWork)}
            onClick={() => {
              if (
                window.confirm(
                  "Заменить ваш черновик версией с диска? Несохранённые изменения будут потеряны.",
                )
              )
                void reloadProjectFile(activeFile);
            }}
          >
            Загрузить с диска
          </button>
        </div>
      )}
      {activeTextFile ? (
        <ProjectTextEditor
          workspaceId={p.workspaceId}
          file={activeTextFile}
          saving={fileSaving.has(activeTextFile.id)}
          onChange={(content) => {
            if (workForId(activeTextFile.id)) return;
            setFiles((current) =>
              current.map((file) =>
                file.id === activeTextFile.id ? { ...file, content } : file,
              ),
            );
          }}
          onSave={() => void saveProjectFile(activeTextFile.id)}
        />
      ) : (
        <>
          <div className="sql-toolbar">
            <div className="sql-toolbar-context">
              <div className="sql-connection">
                <Database size={14} />
                <Select
                  aria-label="Подключение запроса"
                  disabled={Boolean(activeWork)}
                  value={connection?.id || ""}
                  placeholder="Выберите источник"
                  options={p.connections.map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  onValueChange={(value) => {
                    if (workForId(active.id)) return;
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
            </div>
            <div className="sql-toolbar-actions">
              <AgentWorkIndicator work={activeWork} />
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
                disabled={
                  Boolean(activeWork) ||
                  (activeFile ? fileSaving.has(activeFile.id) : false)
                }
                onClick={() => saveAction.current()}
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
                      disabled={Boolean(activeWork)}
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
              {unfinished ? (
                <button
                  className="button run-button stopping"
                  onClick={cancel}
                  disabled={
                    Boolean(activeWork) ||
                    activeRun.status === "cancelling" ||
                    !!runActions[active.id]
                  }
                >
                  <Square weight="fill" size={11} />
                  {activeRun.status === "cancelling"
                    ? "Остановка…"
                    : "Остановить"}
                </button>
              ) : (
                <button
                  className="button run-button"
                  title={
                    dateMode
                      ? "Выполнить запрос для диапазона дат (⌘ / Ctrl + Enter)"
                      : "Выполнить запрос под курсором или выделенный SQL (⌘ / Ctrl + Enter)"
                  }
                  disabled={Boolean(activeWork) || launching || restoringRun}
                  onClick={run}
                >
                  {launching ? (
                    <Spinner />
                  ) : dateMode ? (
                    <CalendarBlank size={14} />
                  ) : (
                    <Play weight="fill" size={12} />
                  )}
                  {launching
                    ? "Запускаем…"
                    : dateMode
                      ? "По датам"
                      : "Выполнить"}
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
                      disabled={Boolean(activeWork)}
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
                      disabled={Boolean(activeWork)}
                      value={active.schema ?? connection.schema ?? ""}
                      placeholder="schema"
                      onChange={(e) =>
                        patch(active.id, { schema: e.target.value })
                      }
                    />
                  </label>
                </>
              ) : (
                <label>
                  База
                  <input
                    aria-label="База запроса"
                    disabled={Boolean(activeWork)}
                    value={active.database ?? connection.database ?? ""}
                    placeholder="default"
                    onChange={(e) =>
                      patch(active.id, { database: e.target.value })
                    }
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
              // A hidden or not-yet-registered group may briefly report no usable
              // sizes. Keep the last real layout for the next SQL tab mount.
              if (!isEditorLayout(l)) return;
              localStorage.setItem(
                `miracle:editor-layout:${p.workspaceId}`,
                JSON.stringify(l),
              );
              setResultExpanded((l.results || 0) > 0);
            }}
            className="editor-results-group"
          >
            <Panel id="editor" defaultSize="55%" minSize="100px" collapsible>
              <div
                className={`editor-area${activeWork ? " agent-work-active" : ""}`}
              >
                {editorOverlays && (
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
                      readOnly: Boolean(activeWork),
                      overflowWidgetsDomNode: editorOverlays,
                      fixedOverflowWidgets: true,
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
                      suggestFontSize: 13,
                      suggestLineHeight: 28,
                      overviewRulerLanes: 0,
                      hideCursorInOverviewRuler: true,
                      scrollbar: {
                        verticalScrollbarSize: 7,
                        horizontalScrollbarSize: 7,
                      },
                      stickyScroll: { enabled: false },
                    }}
                  />
                )}
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
                              ? activeRun.batch
                                ? `${((activeRun.elapsedMs ?? new Date(activeRun.finishedAt || 0).getTime() - new Date(activeRun.startedAt).getTime()) / 1000).toFixed(2)} с`
                                : "Выполнен"
                              : paused
                                ? "Приостановлен"
                                : activeRun.status === "cancelled"
                                  ? "Отменён"
                                  : activeRun.status === "interrupted"
                                    ? "Прерван"
                                    : "Ошибка"}
                        </span>
                        {!activeRun.batch && <QueryDuration run={activeRun} />}
                      </span>
                    )}
                    {result && (
                      <ResultCanvasActions
                        result={result}
                        disabled={Boolean(activeRun?.batch && unfinished)}
                        onBoardFallback={p.onResult}
                        onNotify={p.onNotify}
                      />
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
                {activeRun?.batch && (
                  <DateBatchProgress
                    run={activeRun}
                    onResume={() => void actOnRun("resume")}
                    action={runActions[active.id]}
                    actionError={runActionErrors[active.id]}
                  />
                )}
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
                      paused
                        ? "Серия ожидает продолжения"
                        : running
                          ? "Запрос выполняется"
                          : "Здесь появятся ваши данные"
                    }
                    description={
                      paused
                        ? "Продолжите с неудачной даты или остановите серию."
                        : running
                          ? activeRun?.batch
                            ? "Строки появятся после первого успешного запроса."
                            : "Результат сохранится после завершения запроса."
                          : "Выберите источник, напишите SQL и нажмите «Выполнить»."
                    }
                    action={
                      !unfinished && (
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
        </>
      )}
      <Modal
        open={Boolean(closeFileId)}
        onOpenChange={(open) => {
          if (!open) setCloseFileId(null);
        }}
        title="Сохранить изменения?"
        description="В файле есть несохранённые изменения."
        className="save-changes-dialog"
      >
        <div className="modal-actions">
          <button className="button" onClick={() => setCloseFileId(null)}>
            Отмена
          </button>
          <button
            className="button"
            disabled={Boolean(
              closeFileId &&
              (fileSaving.has(closeFileId) || workForId(closeFileId)),
            )}
            onClick={() => {
              if (closeFileId) void removeProjectFile(closeFileId);
            }}
          >
            Закрыть без сохранения
          </button>
          <button
            className="button primary"
            disabled={Boolean(
              closeFileId &&
              (fileSaving.has(closeFileId) || workForId(closeFileId)),
            )}
            onClick={async () => {
              if (!closeFileId) return;
              const id = closeFileId;
              if (await saveProjectFile(id)) await removeProjectFile(id);
            }}
          >
            Сохранить и закрыть
          </button>
        </div>
      </Modal>
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
              disabled={saving || Boolean(activeWork)}
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
            <button
              className="button primary"
              disabled={saving || Boolean(activeWork)}
            >
              {saving ? <Spinner /> : "Сохранить"}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
