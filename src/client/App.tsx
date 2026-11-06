import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import type {
  BoardKind,
  Connection,
  QueryDocument,
  ResultSet,
} from "../shared/types";
import type { ProjectTextFile } from "../shared/project-files";
import { api, openLocalSession } from "./api";
import { createMetadataStore } from "./metadata-store";
import { Brand, ErrorBox, Modal, Spinner, Toasts } from "./components/UI";
import Connections from "./components/Connections";
import Explorer, {
  type ExplorerKind,
  type ExplorerSourceView,
} from "./components/Explorer";
import SqlWorkspace, { type SqlSourceRequest } from "./components/SqlWorkspace";
import BoardWorkspace from "./board/BoardWorkspace";
import { ProjectSyncProvider, useProjectSync } from "./agents/ProjectSync";
import AgentAssistant from "./agents/AgentAssistant";
import WorkspaceRail from "./components/WorkspaceRail";
import ProjectGitButton, {
  type ProjectGitEditorState,
} from "./git/ProjectGitButton";
import ExplorerPanel from "./components/ExplorerPanel";
import { CanvasWorkspaceProvider } from "./canvas-workspace";
import {
  PANE_MIN_WIDTH,
  PANE_ORDER,
  PANES_BY_MODE,
  isPairMode,
  isPaneMode,
  readPaneLayout,
  resetPaneLayout,
  savePaneLayout,
  selectPaneMode,
  setPaneVisible,
  type PairMode,
  type Pane,
  type PaneMode,
  type PaneView,
} from "./workspace-panes";

const PANE_DIVIDER_LABEL: Record<PairMode, string> = {
  split: "Размер SQL и доски",
  "sql-presentation": "Размер SQL и презентации",
  "board-presentation": "Размер доски и презентации",
};

export default function App() {
  const [workspaceId, setWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const metadata = useMemo(() => createMetadataStore(api), [workspaceId]);
  const sourceViews = useMemo(
    () => new Map<string, ExplorerSourceView>(),
    [workspaceId],
  );
  useEffect(() => () => metadata.dispose(), [metadata]);
  const [explorer, setExplorer] = useState<ExplorerKind | null>("sources");
  const [explorerDrawer, setExplorerDrawer] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [queryRevision, setQueryRevision] = useState(0);
  const [sourceToOpen, setSourceToOpen] = useState<SqlSourceRequest | null>(
    null,
  );
  const [savedToOpen, setSavedToOpen] = useState<QueryDocument | null>(null);
  const [fileToOpen, setFileToOpen] = useState<ProjectTextFile | null>(null);
  const [fileRevision, setFileRevision] = useState(0);
  const [gitEditorState, setGitEditorState] =
    useState<ProjectGitEditorState | null>(null);
  const projectFilesChanged = useCallback(
    () => setFileRevision((value) => value + 1),
    [],
  );
  const [incomingResult, setIncomingResult] = useState<ResultSet | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024);
  const [paneView, setPaneView] = useState<PaneView>({
    mode: "split",
    focusedPane: null,
  });
  const { mode: paneMode, focusedPane } = paneView;
  const visiblePanes = PANES_BY_MODE[paneMode];
  const activeCanvas =
    focusedPane && focusedPane !== "sql"
      ? focusedPane
      : visiblePanes.find((pane) => pane !== "sql");
  const lastSqlPair = useRef<"split" | "sql-presentation">("split");
  const [toasts, setToasts] = useState<
    { id: number; message: string; tone: string }[]
  >([]);
  const group = useGroupRef();
  const toastTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const notify = useCallback(
    (message: string, tone: "error" | "success" | "info" = "info") => {
      const id = Date.now() + Math.random();
      setToasts((s) => [...s.slice(-3), { id, message, tone }]);
      const timer = setTimeout(
        () => {
          setToasts((s) => s.filter((t) => t.id !== id));
          toastTimers.current.delete(timer);
        },
        tone === "error" ? 10000 : 5000,
      );
      toastTimers.current.add(timer);
    },
    [],
  );
  function acceptWorkspace(next: string) {
    if (next) {
      try {
        const saved = JSON.parse(
          localStorage.getItem(`miracle:view:${next}`) || "{}",
        );
        const savedMode: unknown = saved.paneMode;
        const mode = isPaneMode(savedMode) ? savedMode : "split";
        setPaneView({
          mode,
          focusedPane: PANES_BY_MODE[mode].includes(saved.focusedPane)
            ? saved.focusedPane
            : null,
        });
        setExplorer(
          saved.explorer === null ||
            ["sources", "queries", "history"].includes(saved.explorer)
            ? saved.explorer
            : "sources",
        );
      } catch {
        setPaneView({ mode: "split", focusedPane: null });
        setExplorer("sources");
      }
    }
    setWorkspaceId(next);
  }
  useEffect(() => {
    if (workspaceId)
      localStorage.setItem(
        `miracle:view:${workspaceId}`,
        JSON.stringify({ paneMode, focusedPane, explorer }),
      );
  }, [workspaceId, paneMode, focusedPane, explorer]);
  async function loadWorkspace() {
    setLoading(true);
    setLoadError("");
    try {
      const session = await openLocalSession();
      acceptWorkspace(session.workspaceId);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const changed = (event: Event) =>
      setWorkspaceError((event as CustomEvent<string>).detail);
    window.addEventListener("miracle:workspace-changed", changed);
    void loadWorkspace();
    return () => {
      window.removeEventListener("miracle:workspace-changed", changed);
      for (const timer of toastTimers.current) clearTimeout(timer);
    };
  }, []);
  const loadConnections = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const c = await api<Connection[]>("/api/connections");
      setConnections(c);
      setConnectionId((id) =>
        c.some((x) => x.id === id)
          ? id
          : localStorage.getItem(`miracle:connection:${workspaceId}`) &&
              c.some(
                (x) =>
                  x.id ===
                  localStorage.getItem(`miracle:connection:${workspaceId}`),
              )
            ? localStorage.getItem(`miracle:connection:${workspaceId}`)!
            : c[0]?.id || "",
      );
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }, [workspaceId, notify]);
  useEffect(() => {
    if (workspaceId) void loadConnections();
    else {
      setConnections([]);
    }
  }, [workspaceId, loadConnections]);
  useEffect(() => {
    if (workspaceId && connectionId)
      localStorage.setItem(`miracle:connection:${workspaceId}`, connectionId);
  }, [workspaceId, connectionId]);
  useEffect(() => {
    const media = window.matchMedia("(max-width:1023px)");
    const handler = () => setNarrow(media.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);
  useLayoutEffect(() => {
    if (paneMode === "split" || paneMode === "sql-presentation") {
      lastSqlPair.current = paneMode;
    }
    if (!workspaceId || paneMode === "none") return;
    const handle = requestAnimationFrame(() => {
      group.current?.setLayout(readPaneLayout(workspaceId, paneMode));
    });
    return () => cancelAnimationFrame(handle);
  }, [group, paneMode, workspaceId]);
  function changePaneMode(mode: PaneMode) {
    setPaneView((view) => selectPaneMode(view, mode));
  }
  function setPaneVisibility(pane: Pane, visible?: boolean) {
    setPaneView((view) => setPaneVisible(view, pane, visible));
  }
  function focusPane(pane: Pane) {
    setPaneView((view) =>
      view.focusedPane !== pane && PANES_BY_MODE[view.mode].includes(pane)
        ? { ...view, focusedPane: pane }
        : view,
    );
  }
  const showSql = () => setPaneVisibility("sql", true);
  const openCanvas = useCallback((kind: BoardKind) => {
    setPaneView((view) =>
      PANES_BY_MODE[view.mode].includes("sql")
        ? selectPaneMode(view, kind === "board" ? "split" : "sql-presentation")
        : setPaneVisible(view, kind, true),
    );
  }, []);
  const openCanvasPair = useCallback(() => {
    setPaneView((view) => selectPaneMode(view, "board-presentation"));
  }, []);
  function resetCurrentSplit() {
    if (workspaceId && isPairMode(paneMode)) {
      resetPaneLayout(workspaceId, paneMode);
      group.current?.setLayout(readPaneLayout(workspaceId, paneMode));
    }
  }
  function resetLayout() {
    if (workspaceId) {
      for (const mode of [
        "split",
        "sql-presentation",
        "board-presentation",
      ] as const) {
        resetPaneLayout(workspaceId, mode);
      }
      localStorage.removeItem(`miracle:explorer-width:${workspaceId}`);
    }
    if (paneMode === "split")
      group.current?.setLayout(readPaneLayout(workspaceId, "split"));
    changePaneMode("split");
    window.dispatchEvent(new Event("miracle:reset-layout"));
  }
  if (loading)
    return (
      <div className="app-loading">
        <Brand large />
        <span>
          <Spinner />
          Открываем рабочую область…
        </span>
      </div>
    );
  if (loadError)
    return (
      <div className="app-loading">
        <Brand large />
        <ErrorBox>{loadError}</ErrorBox>
        <button className="button primary" onClick={loadWorkspace}>
          Подключиться снова
        </button>
      </div>
    );
  return (
    <ProjectSyncProvider workspaceId={workspaceId}>
      <QueryEvents onChanged={() => setQueryRevision((r) => r + 1)} />
      <div className="app-shell">
        {workspaceError && <ErrorBox>{workspaceError}</ErrorBox>}
        <div className="workspace-body">
          <WorkspaceRail
            mode={paneMode}
            explorer={narrow && !explorerDrawer ? null : explorer}
            connectionCount={connections.length}
            gitControl={
              <ProjectGitButton
                workspaceId={workspaceId}
                hasUnsavedFiles={gitEditorState?.hasUnsavedFiles ?? false}
                onBeforeMutation={async () => {
                  if (!gitEditorState)
                    throw new Error(
                      "Дождитесь загрузки файлов редактора перед действием Git.",
                    );
                  await gitEditorState.onBeforeMutation();
                }}
                onBranchChanged={async () => {
                  if (gitEditorState) await gitEditorState.onBranchChanged();
                  else projectFilesChanged();
                }}
                onNotify={notify}
              />
            }
            onSelectMode={(mode) => {
              changePaneMode(mode);
              setExplorerDrawer(false);
            }}
            onTogglePane={setPaneVisibility}
            onToggleExplorer={(kind) => {
              if (narrow) {
                setExplorerDrawer(explorer !== kind || !explorerDrawer);
                setExplorer(kind);
              } else setExplorer(explorer === kind ? null : kind);
            }}
            onResetLayout={() => {
              resetLayout();
              notify("Размеры панелей восстановлены", "success");
            }}
            onConnections={() => setConnectionsOpen(true)}
            onHelp={() => setHelpOpen(true)}
          />
          {explorer && (!narrow || explorerDrawer) && (
            <ExplorerPanel
              key={workspaceId}
              workspaceId={workspaceId}
              drawer={narrow}
              minWorkspaceWidth={
                visiblePanes.reduce(
                  (width, pane) => width + PANE_MIN_WIDTH[pane],
                  0,
                ) + (isPairMode(paneMode) ? 5 : 0)
              }
            >
              <Explorer
                onClose={narrow ? () => setExplorerDrawer(false) : undefined}
                key={workspaceId}
                kind={explorer}
                workspaceId={workspaceId}
                connections={connections}
                activeConnectionId={connectionId}
                onConnectionChange={setConnectionId}
                metadata={metadata}
                sourceViews={sourceViews}
                onOpenConnections={() => setConnectionsOpen(true)}
                onOpenQuery={(q) => {
                  setExplorerDrawer(false);
                  setSavedToOpen(q);
                  showSql();
                }}
                onOpenFile={(file) => {
                  setExplorerDrawer(false);
                  setFileToOpen(file);
                  showSql();
                }}
                fileRevision={fileRevision}
                onOpenSource={(q, run) => {
                  setExplorerDrawer(false);
                  setSourceToOpen({ source: q, run });
                  showSql();
                }}
                queryRevision={queryRevision}
                onNotify={notify}
              />
            </ExplorerPanel>
          )}
          <main className="workbench">
            {paneMode === "none" && (
              <div className="workbench-empty" role="status">
                <p>Области скрыты</p>
                <span>
                  Включите редактор, доску или презентацию кнопками слева.
                </span>
              </div>
            )}
            <div
              className="workbench-panes"
              hidden={paneMode === "none"}
              inert={paneMode === "none"}
            >
              <CanvasWorkspaceProvider
                key={workspaceId}
                workspaceId={workspaceId}
                onOpen={openCanvas}
                onTransferOpen={openCanvasPair}
                onNotify={notify}
              >
                <Group
                  orientation="horizontal"
                  groupRef={group}
                  className="main-split"
                  defaultLayout={readPaneLayout(workspaceId, paneMode)}
                  disabled={!isPairMode(paneMode)}
                  onLayoutChanged={(
                    layout,
                    { isUserInteraction, requestedLayout },
                  ) => {
                    if (
                      isUserInteraction &&
                      workspaceId &&
                      isPairMode(paneMode)
                    ) {
                      savePaneLayout(
                        workspaceId,
                        paneMode,
                        requestedLayout ?? layout,
                      );
                    }
                  }}
                >
                  {PANE_ORDER.map((pane) => {
                    const visible = visiblePanes.includes(pane);
                    return (
                      <Fragment key={pane}>
                        <Panel
                          id={pane}
                          defaultSize={visible ? undefined : "0%"}
                          minSize={visible ? `${PANE_MIN_WIDTH[pane]}px` : "0%"}
                          maxSize={visible ? "100%" : "0%"}
                          disabled={!visible}
                        >
                          <div
                            className="pane-host"
                            inert={!visible}
                            onPointerDownCapture={() => focusPane(pane)}
                            onFocusCapture={() => focusPane(pane)}
                          >
                            {pane === "sql" ? (
                              <SqlWorkspace
                                workspaceId={workspaceId}
                                key={workspaceId}
                                connections={connections}
                                activeConnectionId={connectionId}
                                onConnectionChange={setConnectionId}
                                metadata={metadata}
                                sourceToOpen={sourceToOpen}
                                savedToOpen={savedToOpen}
                                fileToOpen={fileToOpen}
                                onFileConsumed={() => setFileToOpen(null)}
                                onProjectFileSaved={projectFilesChanged}
                                onGitEditorStateChange={setGitEditorState}
                                onSourceConsumed={() => setSourceToOpen(null)}
                                onSavedConsumed={() => setSavedToOpen(null)}
                                onQueriesChanged={() =>
                                  setQueryRevision((r) => r + 1)
                                }
                                onResult={(r) => {
                                  setIncomingResult(r);
                                  openCanvas("board");
                                }}
                                onNotify={notify}
                                onOpenConnections={() =>
                                  setConnectionsOpen(true)
                                }
                                onMaximize={() =>
                                  changePaneMode(
                                    paneMode === "sql"
                                      ? lastSqlPair.current
                                      : "sql",
                                  )
                                }
                                onCollapse={() =>
                                  setPaneVisibility("sql", false)
                                }
                              />
                            ) : (
                              <BoardWorkspace
                                workspaceId={workspaceId}
                                key={workspaceId}
                                kind={pane}
                                active={visible && activeCanvas === pane}
                                onActivate={() => focusPane(pane)}
                                incomingResult={
                                  pane === "board" ? incomingResult : null
                                }
                                onIncomingConsumed={() =>
                                  setIncomingResult(null)
                                }
                                onOpenSource={(source, name) => {
                                  setSourceToOpen({ source, name });
                                  showSql();
                                }}
                                onNotify={notify}
                              />
                            )}
                          </div>
                        </Panel>
                        {isPairMode(paneMode) && visiblePanes[0] === pane && (
                          <Separator
                            className="resize-separator vertical"
                            aria-label={PANE_DIVIDER_LABEL[paneMode]}
                            disableDoubleClick
                            onDoubleClick={resetCurrentSplit}
                          />
                        )}
                      </Fragment>
                    );
                  })}
                </Group>
              </CanvasWorkspaceProvider>
            </div>
          </main>
        </div>
        <Connections
          open={connectionsOpen}
          onClose={() => setConnectionsOpen(false)}
          connections={connections}
          onChanged={(id) => {
            if (id) {
              metadata.invalidate(id);
              sourceViews.delete(id);
            }
            void loadConnections();
          }}
          onNotify={notify}
        />
        <Modal
          open={helpOpen}
          onOpenChange={setHelpOpen}
          title="Сочетания клавиш"
        >
          <div className="shortcut-list">
            {[
              [
                "Выполнить запрос под курсором или выделение",
                "⌘ / Ctrl + Enter",
              ],
              ["Форматировать SQL", "⌥⌘L / Ctrl+Alt+L"],
              ["Подсказки SQL", "⌘I / Ctrl+Space"],
              ["Перейти по словам", "⌥ / Ctrl + ← / →"],
              ["Начало / конец строки", "⌘← / ⌘→ · Home / End"],
              ["Начало / конец файла", "⌘↑ / ⌘↓ · Ctrl+Home / End"],
              ["Сохранить SQL-файл", "⌘ / Ctrl + S"],
              ["Найти в редакторе", "⌘ / Ctrl + F"],
              ["Отменить действие", "⌘ / Ctrl + Z"],
              ["Перемещать доску", "Пробел + перетаскивание"],
              ["Выбрать несколько блоков", "Shift + клик или рамка"],
              ["Копировать выбранные блоки", "⌘ / Ctrl + C"],
              ["Вставить блоки", "⌘ / Ctrl + V"],
              ["Скопировать перетаскиванием", "Option / Alt + перетаскивание"],
              ["Менять размер без прилипания", "Option / Alt + край блока"],
              ["Сохранять пропорции графика", "Shift + угол графика"],
              ["Удалить выбранный объект", "Delete / Backspace"],
              ["Настроить объект", "Enter"],
              ["Изменить размеры панелей", "Стрелки на разделителе"],
            ].map(([label, key]) => (
              <div key={label}>
                <span>{label}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
        </Modal>
        <Toasts
          items={toasts}
          onDismiss={(id) => setToasts((s) => s.filter((t) => t.id !== id))}
        />
        <AgentAssistant />
      </div>
    </ProjectSyncProvider>
  );
}

function QueryEvents({ onChanged }: { onChanged: () => void }) {
  const sync = useProjectSync();
  const callback = useRef(onChanged);
  callback.current = onChanged;
  useEffect(
    () =>
      sync?.subscribe((event) => {
        if (event.type === "queries.changed") callback.current();
      }),
    [sync],
  );
  return null;
}
