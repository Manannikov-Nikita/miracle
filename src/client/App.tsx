import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import type {
  Connection,
  QueryDocument,
  ResultSet,
  SchemaTable,
  User,
} from "../shared/types";
import { api, setCsrfToken } from "./api";
import Auth from "./components/Auth";
import Setup from "./components/Setup";
import { Brand, ErrorBox, Modal, Spinner, Toasts } from "./components/UI";
import Connections from "./components/Connections";
import Team from "./components/Team";
import Explorer, { type ExplorerKind } from "./components/Explorer";
import SqlWorkspace, { type SqlSourceRequest } from "./components/SqlWorkspace";
import BoardWorkspace from "./board/BoardWorkspace";
import WorkspaceRail, { type PaneMode } from "./components/WorkspaceRail";
export default function App({
  setupToken = null,
}: {
  setupToken?: string | null;
}) {
  const [setupRequired, setSetupRequired] = useState(false);
  const [setupCredential, setSetupCredential] = useState(setupToken);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [schema, setSchema] = useState<SchemaTable[]>([]);
  const [explorer, setExplorer] = useState<ExplorerKind | null>("sources");
  const [explorerDrawer, setExplorerDrawer] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
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
  function acceptUser(next: User | null) {
    if (next) {
      try {
        const saved = JSON.parse(
          localStorage.getItem(`miracle:view:${next.id}`) || "{}",
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
    setUser(next);
  }
  useEffect(() => {
    if (user)
      localStorage.setItem(
        `miracle:view:${user.id}`,
        JSON.stringify({ paneMode, mobileTab, explorer }),
      );
  }, [user, paneMode, mobileTab, explorer]);
  function savedLayout() {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`miracle:workspace-layout:${user?.id}`) || "null",
      );
      if (saved?.sql > 5 && saved?.board > 5) return saved;
    } catch {}
    return { sql: 45, board: 55 };
  }
  async function loadMe() {
    setLoading(true);
    setLoadError("");
    try {
      const status = await api<{ required: boolean }>("/api/setup/status");
      setSetupRequired(status.required);
      if (status.required) return;
      setSetupCredential(null);
      const r = await api<{ user: User | null; csrfToken: string }>(
        "/api/auth/me",
      );
      setCsrfToken(r.csrfToken);
      acceptUser(r.user);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadMe();
    const unauthorized = () => {
      setUser(null);
      setCsrfToken("");
      notify("Сессия завершена. Войдите снова.", "info");
    };
    window.addEventListener("miracle:unauthorized", unauthorized);
    return () => {
      window.removeEventListener("miracle:unauthorized", unauthorized);
      for (const timer of toastTimers.current) clearTimeout(timer);
    };
  }, []);
  const loadConnections = useCallback(async () => {
    if (!user) return;
    try {
      const c = await api<Connection[]>("/api/connections");
      setConnections(c);
      setConnectionId((id) =>
        c.some((x) => x.id === id)
          ? id
          : localStorage.getItem(`miracle:connection:${user.id}`) &&
              c.some(
                (x) =>
                  x.id ===
                  localStorage.getItem(`miracle:connection:${user.id}`),
              )
            ? localStorage.getItem(`miracle:connection:${user.id}`)!
            : c[0]?.id || "",
      );
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }, [user, notify]);
  useEffect(() => {
    if (user) void loadConnections();
    else {
      setConnections([]);
      setSchema([]);
    }
  }, [user, loadConnections]);
  useEffect(() => {
    if (user && connectionId)
      localStorage.setItem(`miracle:connection:${user.id}`, connectionId);
  }, [user, connectionId]);
  useEffect(() => {
    const media = window.matchMedia("(max-width:1023px)");
    const handler = () => setNarrow(media.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);
  useEffect(() => {
    if (!user) return;
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
            localStorage.getItem(`miracle:workspace-layout:${user.id}`) ||
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
  }, [narrow, mobileTab, paneMode, user]);
  const showSql = () => {
    if (narrow) setMobileTab("sql");
    else if (paneMode === "board") setPaneMode("split");
  };
  const showBoard = () => {
    if (narrow) setMobileTab("board");
    else if (paneMode === "sql") setPaneMode("split");
  };
  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setUser(null);
      setConnections([]);
      setConnectionId("");
      setSourceToOpen(null);
      setSavedToOpen(null);
      setIncomingResult(null);
      setCsrfToken("");
      await loadMe();
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }
  function resetLayout() {
    if (user) localStorage.removeItem(`miracle:workspace-layout:${user.id}`);
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
        <button className="button primary" onClick={loadMe}>
          Подключиться снова
        </button>
      </div>
    );
  if (!user)
    return (
      <>
        {setupRequired ? (
          <Setup
            token={setupCredential}
            onComplete={(next) => {
              setSetupRequired(false);
              setSetupCredential(null);
              acceptUser(next);
            }}
            onInitialized={() => {
              setSetupCredential(null);
              void loadMe();
            }}
          />
        ) : (
          <Auth onLogin={acceptUser} />
        )}
        <Toasts
          items={toasts}
          onDismiss={(id) => setToasts((s) => s.filter((t) => t.id !== id))}
        />
      </>
    );
  return (
    <div className="app-shell">
      <div className="workspace-body">
        <WorkspaceRail
          user={user}
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
          onTeam={() => setTeamOpen(true)}
          onHelp={() => setHelpOpen(true)}
          onLogout={logout}
        />
        {explorer && (!narrow || explorerDrawer) && (
          <Explorer
            onClose={narrow ? () => setExplorerDrawer(false) : undefined}
            key={user.id}
            kind={explorer}
            user={user}
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
              if (user && !narrow && l.sql > 5 && l.board > 5)
                localStorage.setItem(
                  `miracle:workspace-layout:${user.id}`,
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
                  user={user}
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
                  user={user}
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
        user={user}
        connections={connections}
        onChanged={loadConnections}
        onNotify={notify}
      />
      {user.role === "admin" && (
        <Team
          open={teamOpen}
          onClose={() => setTeamOpen(false)}
          currentUser={user}
          onNotify={notify}
        />
      )}
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
