import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import type {
  Connection,
  QueryDocument,
  ResultSet,
  SchemaTable,
} from "../shared/types";
import { api, openLocalSession } from "./api";
import { Brand, ErrorBox, Modal, Spinner, Toasts } from "./components/UI";
import Connections from "./components/Connections";
import Explorer, { type ExplorerKind } from "./components/Explorer";
import SqlWorkspace, { type SqlSourceRequest } from "./components/SqlWorkspace";
import BoardWorkspace from "./board/BoardWorkspace";
import WorkspaceRail, { type PaneMode } from "./components/WorkspaceRail";
export default function App() {
  const [workspaceId, setWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [explorer, setExplorer] = useState<ExplorerKind | null>("sources");
  const [explorerDrawer, setExplorerDrawer] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [queryRevision, setQueryRevision] = useState(0);
  const [sourceToOpen, setSourceToOpen] = useState<SqlSourceRequest | null>(
    null,
  );
  const [savedToOpen, setSavedToOpen] = useState<QueryDocument | null>(null);
  const [incomingResult, setIncomingResult] = useState<ResultSet | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1024);
  const [mobileTab, setMobileTab] = useState<"sql" | "board">("sql");
  const [paneMode, setPaneMode] = useState<PaneMode>("split");
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
        setPaneMode(
          ["sql", "board"].includes(saved.paneMode) ? saved.paneMode : "split",
        );
        setMobileTab(saved.mobileTab === "board" ? "board" : "sql");
        setExplorer(
          saved.explorer === null ||
            ["sources", "queries", "history"].includes(saved.explorer)
            ? saved.explorer
            : "sources",
        );
      } catch {
        setPaneMode("split");
        setMobileTab("sql");
        setExplorer("sources");
      }
    }
    setWorkspaceId(next);
  }
  useEffect(() => {
    if (workspaceId)
      localStorage.setItem(
        `miracle:view:${workspaceId}`,
        JSON.stringify({ paneMode, mobileTab, explorer }),
      );
  }, [workspaceId, paneMode, mobileTab, explorer]);
  function savedLayout() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`miracle:workspace-layout:${workspaceId}`) ||
          "null",
      );
      if (saved?.sql > 5 && saved?.board > 5) return saved;
    } catch {}
    return { sql: 45, board: 55 };
  }
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
      setSchema([]);
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
  useEffect(() => {
    if (!workspaceId) return;
    const handle = requestAnimationFrame(() => {
      if (narrow) {
        group.current?.setLayout(
          mobileTab === "sql" ? { sql: 100, board: 0 } : { sql: 0, board: 100 },
        );
      } else if (paneMode === "sql")
        group.current?.setLayout({ sql: 100, board: 0 });
      else if (paneMode === "board")
        group.current?.setLayout({ sql: 0, board: 100 });
      else {
        try {
          const stored = JSON.parse(
            localStorage.getItem(`miracle:workspace-layout:${workspaceId}`) ||
              "null",
          );
          group.current?.setLayout(
            stored?.sql > 5 && stored?.board > 5
              ? stored
              : { sql: 45, board: 55 },
          );
        } catch {
          group.current?.setLayout({ sql: 45, board: 55 });
        }
      }
    });
    return () => cancelAnimationFrame(handle);
  }, [narrow, mobileTab, paneMode, workspaceId]);
  const showSql = () => {
    if (narrow) setMobileTab("sql");
    else if (paneMode === "board") setPaneMode("split");
  };
  const showBoard = () => {
    if (narrow) setMobileTab("board");
    else if (paneMode === "sql") setPaneMode("split");
  };
  function resetLayout() {
    if (workspaceId)
      localStorage.removeItem(`miracle:workspace-layout:${workspaceId}`);
    setPaneMode("split");
    group.current?.setLayout(
      narrow
        ? mobileTab === "sql"
          ? { sql: 100, board: 0 }
          : { sql: 0, board: 100 }
        : { sql: 45, board: 55 },
    );
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
    <div className="app-shell">
      {workspaceError && <ErrorBox>{workspaceError}</ErrorBox>}
      <div className="workspace-body">
        <WorkspaceRail
          narrow={narrow}
          mode={narrow ? mobileTab : paneMode}
          explorer={narrow && !explorerDrawer ? null : explorer}
          connectionCount={connections.length}
          onSelectMode={(mode) => {
            setPaneMode(mode);
            if (mode !== "split") setMobileTab(mode);
            setExplorerDrawer(false);
          }}
          onTogglePane={(pane) => {
            if (narrow) setMobileTab(pane);
            else setPaneMode((mode) => (mode === pane ? "split" : pane));
            setExplorerDrawer(false);
          }}
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
          <Explorer
            onClose={narrow ? () => setExplorerDrawer(false) : undefined}
            key={workspaceId}
            kind={explorer}
            connections={connections}
            activeConnectionId={connectionId}
            onConnectionChange={setConnectionId}
            schema={schema}
            onSchemaChange={setSchema}
            onOpenConnections={() => setConnectionsOpen(true)}
            onOpenQuery={(q) => {
              setExplorerDrawer(false);
              setSavedToOpen(q);
              showSql();
            }}
            onOpenSource={(q) => {
              setExplorerDrawer(false);
              setSourceToOpen({ source: q });
              showSql();
            }}
            queryRevision={queryRevision}
            onNotify={notify}
          />
        )}
        <main className="workbench">
          <Group
            orientation="horizontal"
            groupRef={group}
            className="main-split"
            defaultLayout={savedLayout()}
            disabled={narrow}
            onLayoutChanged={(l) => {
              if (workspaceId && !narrow && l.sql > 5 && l.board > 5)
                localStorage.setItem(
                  `miracle:workspace-layout:${workspaceId}`,
                  JSON.stringify(l),
                );
            }}
          >
            <Panel
              id="sql"
              defaultSize="45%"
              minSize={narrow ? "0px" : "340px"}
              collapsible
            >
              <div
                className="pane-host"
                inert={narrow ? mobileTab !== "sql" : paneMode === "board"}
              >
                <SqlWorkspace
                  workspaceId={workspaceId}
                  key={workspaceId}
                  connections={connections}
                  activeConnectionId={connectionId}
                  onConnectionChange={setConnectionId}
                  schema={schema}
                  sourceToOpen={sourceToOpen}
                  savedToOpen={savedToOpen}
                  onSourceConsumed={() => setSourceToOpen(null)}
                  onSavedConsumed={() => setSavedToOpen(null)}
                  onQueriesChanged={() => setQueryRevision((r) => r + 1)}
                  onResult={(r) => {
                    setIncomingResult(r);
                    showBoard();
                  }}
                  onNotify={notify}
                  onOpenConnections={() => setConnectionsOpen(true)}
                  onMaximize={() =>
                    setPaneMode(paneMode === "sql" ? "split" : "sql")
                  }
                  onCollapse={() =>
                    narrow ? setMobileTab("board") : setPaneMode("board")
                  }
                />
              </div>
            </Panel>
            <Separator
              className="resize-separator vertical"
              aria-label="Размер SQL и доски"
              onDoubleClick={resetLayout}
            />
            <Panel
              id="board"
              defaultSize="55%"
              minSize={narrow ? "0px" : "400px"}
              collapsible
            >
              <div
                className="pane-host"
                inert={narrow ? mobileTab !== "board" : paneMode === "sql"}
              >
                <BoardWorkspace
                  workspaceId={workspaceId}
                  key={workspaceId}
                  incomingResult={incomingResult}
                  onIncomingConsumed={() => setIncomingResult(null)}
                  onOpenSource={(source, name) => {
                    setSourceToOpen({ source, name });
                    showSql();
                  }}
                  onNotify={notify}
                />
              </div>
            </Panel>
          </Group>
        </main>
      </div>
      <Connections
        open={connectionsOpen}
        onClose={() => setConnectionsOpen(false)}
        connections={connections}
        onChanged={loadConnections}
        onNotify={notify}
      />
      <Modal
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title="Меньше кликов, больше смысла"
        description="Сочетания клавиш рабочей среды"
      >
        <div className="shortcut-list">
          {[
            ["Выполнить запрос под курсором или выделение", "⌘ / Ctrl + Enter"],
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
            ["Перемещать без прилипания", "Alt / ⌥ + перетаскивание"],
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
    </div>
  );
}
