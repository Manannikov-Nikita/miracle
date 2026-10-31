import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, BoardDocument, BoardSummary } from "../../shared/types";
import { api } from "../api";
import { useProjectSync } from "../agents/ProjectSync";
import { emptyDocument } from "./model";
function persist(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
export const draftKey = (workspaceId: string, boardId: string) =>
  `miracle:board-draft:${workspaceId}:${boardId}`;
export function useBoard(
  workspaceId: string,
  notify: (text: string, tone?: "error" | "success" | "info") => void,
) {
  const projectSync = useProjectSync();
  const [list, setList] = useState<BoardSummary[]>([]);
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState("Загрузка…");
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const current = useRef<Board | null>(null);
  const saved = useRef("");
  const history = useRef<BoardDocument[]>([]);
  const future = useRef<BoardDocument[]>([]);
  const saving = useRef(false);
  const inFlightDocument = useRef("");
  const pendingMutation = useRef<{
    id: string;
    boardId: string;
    revision: number;
    document: string;
  } | null>(null);
  const savingDone = useRef<Promise<void> | null>(null);
  const conflictRef = useRef(false);
  conflictRef.current = conflict;
  const loadSequence = useRef(0);
  const mounted = useRef(true);
  const [historyTick, setHistoryTick] = useState(0);
  const assign = useCallback((value: Board | null) => {
    current.current = value;
    setBoard(value);
  }, []);
  const select = useCallback(
    async (id: string) => {
      if (saving.current) {
        notify("Дождитесь сохранения доски.", "info");
        return;
      }
      setLoading(true);
      const sequence = ++loadSequence.current;
      try {
        const loaded = await api<Board>(`/api/boards/${id}`);
        if (!mounted.current || sequence !== loadSequence.current) return;
        saved.current = JSON.stringify(loaded.document);
        history.current = [];
        future.current = [];
        let local: Board = loaded;
        let restored = false;
        setConflict(false);
        try {
          const raw = localStorage.getItem(draftKey(workspaceId, id));
          if (raw) {
            const draft = JSON.parse(raw) as {
              document: BoardDocument;
              baseRevision: number;
            };
            if (
              draft.document?.schemaVersion === 1 &&
              Array.isArray(draft.document.nodes) &&
              Array.isArray(draft.document.edges)
            ) {
              local = {
                ...loaded,
                revision: draft.baseRevision,
                document: draft.document,
              };
              restored = JSON.stringify(draft.document) !== saved.current;
              if (!restored) local = loaded;
              setConflict(restored && draft.baseRevision !== loaded.revision);
            }
          } else setConflict(false);
        } catch {
          setConflict(false);
        }
        assign(local);
        try {
          localStorage.setItem(`miracle:selected-board:${workspaceId}`, id);
        } catch {}
        setState(restored ? "Восстановлен локальный черновик" : "Сохранено");
      } catch (e) {
        if (sequence === loadSequence.current) {
          notify((e as Error).message, "error");
          setState("Не удалось загрузить");
        }
      } finally {
        if (sequence === loadSequence.current) setLoading(false);
      }
    },
    [assign, workspaceId, notify],
  );
  useEffect(() => {
    mounted.current = true;
    let live = true;
    api<BoardSummary[]>("/api/boards")
      .then((data) => {
        if (!live) return;
        setList(data);
        let preferred: string | null = null;
        try {
          preferred = localStorage.getItem(
            `miracle:selected-board:${workspaceId}`,
          );
        } catch {}
        const initial = data.find((item) => item.id === preferred) || data[0];
        if (initial) void select(initial.id);
        else {
          setLoading(false);
          setState("Нет досок");
        }
      })
      .catch((e) => {
        if (live) {
          setState("Ошибка загрузки досок");
          setLoading(false);
          notify(e.message, "error");
        }
      });
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [workspaceId]);
  const change = useCallback(
    (document: BoardDocument, record = true) => {
      const old = current.current;
      if (!old) return;
      document = {
        ...document,
        nodes: document.nodes.map((node) => {
          const previous = old.document.nodes.find((n) => n.id === node.id);
          return previous &&
            JSON.stringify(previous.data.source) !==
              JSON.stringify(node.data.source)
            ? {
                ...node,
                data: {
                  ...node.data,
                  sourceRevision: Math.max(
                    (previous.data.sourceRevision ?? 0) + 1,
                    node.data.sourceRevision ?? 0,
                  ),
                },
              }
            : node;
        }),
      };
      // React Flow can emit the existing viewport again after fitting the canvas.
      if (JSON.stringify(document) === JSON.stringify(old.document)) return;
      if (record) {
        history.current.push(old.document);
        if (history.current.length > 60) history.current.shift();
        future.current = [];
      }
      const next = { ...old, document };
      assign(next);
      setHistoryTick((n) => n + 1);
      if (
        !persist(draftKey(workspaceId, old.id), {
          baseRevision: old.revision,
          document,
        })
      )
        notify(
          "Локальный черновик не записан: хранилище браузера недоступно.",
          "error",
        );
      setState("Изменения…");
    },
    [assign, workspaceId, notify],
  );
  const save = useCallback(async () => {
    const snapshot = current.current;
    if (
      !snapshot ||
      saving.current ||
      conflict ||
      JSON.stringify(snapshot.document) === saved.current
    )
      return;
    saving.current = true;
    let finishSave!: () => void;
    savingDone.current = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    inFlightDocument.current = JSON.stringify(snapshot.document);
    setState("Сохранение…");
    const serialized = JSON.stringify(snapshot.document);
    if (
      pendingMutation.current?.boardId !== snapshot.id ||
      pendingMutation.current.revision !== snapshot.revision ||
      pendingMutation.current.document !== serialized
    )
      pendingMutation.current = {
        id: crypto.randomUUID(),
        boardId: snapshot.id,
        revision: snapshot.revision,
        document: serialized,
      };
    try {
      const result = await api<Board>(`/api/boards/${snapshot.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          baseRevision: snapshot.revision,
          mutationId: pendingMutation.current.id,
          document: snapshot.document,
        }),
      });
      if (current.current?.id !== snapshot.id) return;
      const now = current.current;
      if (now.revision > result.revision) return;
      pendingMutation.current = null;
      saved.current = serialized;
      assign({
        ...now,
        revision: result.revision,
        updatedAt: result.updatedAt,
      });
      setList((items) =>
        items.map((item) =>
          item.id === result.id
            ? {
                id: result.id,
                name: result.name,
                revision: result.revision,
                updatedAt: result.updatedAt,
              }
            : item,
        ),
      );
      if (JSON.stringify(now.document) === serialized) {
        persist(draftKey(workspaceId, snapshot.id), null);
        setState("Сохранено");
      } else {
        persist(draftKey(workspaceId, snapshot.id), {
          baseRevision: result.revision,
          document: now.document,
        });
        setState("Изменения…");
        setRetry((n) => n + 1);
      }
    } catch (e) {
      if (current.current?.id !== snapshot.id || !mounted.current) return;
      const error = e as Error & { status?: number; code?: string };
      if (
        error.status === 409 ||
        /revision|conflict|конфликт/i.test(error.message) ||
        error.code === "REVISION_CONFLICT"
      ) {
        conflictRef.current = true;
        setConflict(true);
        setState("Конфликт версий");
      } else {
        setState("Не сохранено — повторить");
        notify(error.message, "error");
      }
    } finally {
      saving.current = false;
      inFlightDocument.current = "";
      finishSave();
      savingDone.current = null;
    }
  }, [assign, conflict, workspaceId, notify]);
  useEffect(() => {
    if (!projectSync) return;
    const receive = (value: Board) => {
      setList((items) =>
        items.some((b) => b.id === value.id)
          ? items.map((b) =>
              b.id === value.id && b.revision < value.revision ? value : b,
            )
          : [value, ...items],
      );
      const old = current.current;
      if (!old || old.id !== value.id || value.revision <= old.revision) return;
      const serialized = JSON.stringify(value.document);
      const dirty = JSON.stringify(old.document) !== saved.current;
      if (
        dirty &&
        serialized !== inFlightDocument.current &&
        serialized !== pendingMutation.current?.document
      ) {
        conflictRef.current = true;
        setConflict(true);
        setState("Конфликт версий — локальный черновик сохранён");
        return;
      }
      if (!dirty && JSON.stringify(old.document) !== serialized) {
        history.current.push(old.document);
        if (history.current.length > 60) history.current.shift();
        future.current = [];
        setHistoryTick((n) => n + 1);
      }
      saved.current = serialized;
      assign(
        serialized === inFlightDocument.current ||
          serialized === pendingMutation.current?.document
          ? { ...old, revision: value.revision, updatedAt: value.updatedAt }
          : value,
      );
      setState("Сохранено");
    };
    const removeRemote = (id: string) => {
      setList((items) => items.filter((b) => b.id !== id));
      const old = current.current;
      if (old?.id !== id) return;
      if (JSON.stringify(old.document) !== saved.current) {
        conflictRef.current = true;
        setConflict(true);
        setState("Доска удалена. Локальный черновик сохранён");
      } else {
        assign(null);
        saved.current = "";
      }
    };
    const unsubscribe = projectSync.subscribe((event) => {
      if (event.type === "board.updated") receive(event.data as Board);
      if (event.type === "board.deleted")
        removeRemote(event.entityId || (event.data as { id: string }).id);
    });
    const reconnect = projectSync.onReconnect(() => {
      const requestedBoard = current.current;
      void api<BoardSummary[]>("/api/boards")
        .then((items) => {
          setList(items);
          const old = current.current;
          if (
            old &&
            old.id === requestedBoard?.id &&
            old.revision === requestedBoard.revision &&
            !items.some((b) => b.id === old.id)
          )
            removeRemote(old.id);
          else if (old)
            void api<Board>(`/api/boards/${old.id}`)
              .then(receive)
              .catch((e) => notify(e.message, "error"));
        })
        .catch((e) => notify(e.message, "error"));
    });
    return () => {
      unsubscribe();
      reconnect();
    };
  }, [projectSync, assign, notify]);
  const flush = useCallback(async () => {
    if (savingDone.current) await savingDone.current;
    if (conflictRef.current)
      throw new Error("Разрешите конфликт доски перед отправкой сообщения.");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (
        !current.current ||
        JSON.stringify(current.current.document) === saved.current
      )
        return;
      await save();
      if (conflictRef.current)
        throw new Error("Конфликт версий доски. Локальный черновик сохранён.");
    }
    throw new Error(
      "Не удалось сохранить доску. Повторите отправку после сохранения.",
    );
  }, [save]);
  useEffect(() => {
    if (!projectSync) return;
    return projectSync.register("board", {
      context: () => ({ boardId: current.current?.id }),
      flush,
    });
  }, [projectSync, flush]);
  useEffect(() => {
    if (!board || conflict) return;
    const timer = setTimeout(() => void save(), 650);
    return () => clearTimeout(timer);
  }, [board?.document, retry, conflict, save]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (
        current.current &&
        JSON.stringify(current.current.document) !== saved.current
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const create = async (name: string, document = emptyDocument()) => {
    const value = await api<Board>("/api/boards", {
      method: "POST",
      body: JSON.stringify({ name, document }),
    });
    // The original conflicting draft remains recoverable after creating a copy.
    ++loadSequence.current;
    setLoading(false);
    setList((items) => [value, ...items]);
    saved.current = JSON.stringify(value.document);
    setConflict(false);
    history.current = [];
    future.current = [];
    assign(value);
    setState("Сохранено");
    return value;
  };
  const rename = async (name: string) => {
    const value = current.current;
    if (!value) return;
    if (saving.current) throw new Error("Дождитесь завершения сохранения.");
    await save();
    if (conflict) throw new Error("Сначала разрешите конфликт версий.");
    const fresh = current.current!;
    const renamed = await api<Board>(`/api/boards/${fresh.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        baseRevision: fresh.revision,
        mutationId: crypto.randomUUID(),
        name,
        document: fresh.document,
      }),
    });
    assign(renamed);
    saved.current = JSON.stringify(renamed.document);
    setList((items) =>
      items.map((item) => (item.id === renamed.id ? renamed : item)),
    );
  };
  const remove = async () => {
    const value = current.current;
    if (!value) return;
    try {
      await api(`/api/boards/${value.id}`, {
        method: "DELETE",
        body: JSON.stringify({
          baseRevision: value.revision,
          mutationId: crypto.randomUUID(),
        }),
      });
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        conflictRef.current = true;
        setConflict(true);
        setState("Доска изменена. Обновите версию перед удалением.");
      }
      throw error;
    }
    persist(draftKey(workspaceId, value.id), null);
    ++loadSequence.current;
    const remaining = list.filter((b) => b.id !== value.id);
    setList(remaining);
    assign(null);
    saved.current = "";
    setConflict(false);
    if (remaining[0]) await select(remaining[0].id);
  };
  const reload = async () => {
    if (!current.current) return;
    persist(draftKey(workspaceId, current.current.id), null);
    setConflict(false);
    await select(current.current.id);
  };
  const recordHistory = (document: BoardDocument) => {
    history.current.push(document);
    if (history.current.length > 60) history.current.shift();
    future.current = [];
    setHistoryTick((n) => n + 1);
  };
  const undo = () => {
    const prev = history.current.pop();
    if (!prev || !current.current) return;
    future.current.push(current.current.document);
    change(prev, false);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next || !current.current) return;
    history.current.push(current.current.document);
    change(next, false);
  };
  return {
    list,
    board,
    current,
    loading,
    state,
    conflict,
    editable: true,
    change,
    select,
    create,
    rename,
    remove,
    reload,
    save,
    flush,
    undo,
    redo,
    recordHistory,
    canUndo: history.current.length > 0,
    canRedo: future.current.length > 0,
    historyTick,
  };
}
