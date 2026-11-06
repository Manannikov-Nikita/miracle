import {
  boardKind,
  emptyPresentationDocument,
} from "../../shared/presentation";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Board,
  BoardDocument,
  BoardKind,
  BoardSummary,
} from "../../shared/types";
import { api } from "../api";
import { useProjectSync } from "../agents/ProjectSync";
import { emptyDocument } from "./model";
import {
  boardValuesEqual,
  mergeBoardDocuments,
} from "../../shared/board-merge";
import {
  boardWork,
  containsBoardChanges,
  edgeWork,
  nodeWork,
  protectBoardChanges,
} from "./agent-work";
import type { AgentEntityWork } from "../../shared/agent-work";
import { currentAgentWork } from "../agents/useAgentWork";
import { readBoardViewport, saveBoardViewport } from "./viewport";
// Validation rebuilds objects in schema order. Key insertion order is not a document edit.
function contentKey(value: unknown) {
  return JSON.stringify(value, (_key, part) =>
    part && typeof part === "object" && !Array.isArray(part)
      ? Object.fromEntries(
          Object.keys(part)
            .sort()
            .map((key) => [key, part[key]]),
        )
      : part,
  );
}
function canvasKey({ viewport: _, ...content }: BoardDocument) {
  return contentKey(content);
}
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
export const agentDraftKey = (workspaceId: string, boardId: string) =>
  `miracle:board-agent-drafts:${workspaceId}:${boardId}`;
type HistoryEntry = { before: BoardDocument; after: BoardDocument };
type Inserted = {
  boardId: string;
  ids: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
};
type AddressedWrite = {
  targetId: string | null;
  selectionSequence: number;
  prepared?: {
    target: Board;
    document: BoardDocument;
    ids: ReadonlySet<string>;
    edgeIds: ReadonlySet<string>;
  };
  pending?: Promise<Inserted>;
  outcome?: Inserted;
};
type ParkedDraft = {
  createdAt: string;
  baseRevision: number;
  document: BoardDocument;
};
export function useBoard(
  workspaceId: string,
  notify: (text: string, tone?: "error" | "success" | "info") => void,
  kind: BoardKind = "board",
  registerContext = true,
) {
  const projectSync = useProjectSync();
  const selectedKey =
    kind === "board"
      ? `miracle:selected-board:${workspaceId}`
      : `miracle:selected-presentation:${workspaceId}`;
  const collection =
    kind === "board" ? "/api/boards" : "/api/boards?kind=presentation";
  const initialDocument =
    kind === "board" ? emptyDocument : emptyPresentationDocument;
  const noun = kind === "board" ? "доску" : "презентацию";
  const [list, setList] = useState<BoardSummary[]>([]);
  const [board, setBoard] = useState<Board | null>(null);
  const [persisted, setPersisted] = useState<Board | null>(null);
  const [state, setState] = useState("Загрузка…");
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [collectionLoaded, setCollectionLoaded] = useState(false);
  const [retry, setRetry] = useState(0);
  const current = useRef<Board | null>(null);
  const latestRemote = useRef<Board | null>(null);
  const unknownRestoredBase = useRef(false);
  const creationEvents = useRef(new Set<Map<string, Board>>());
  const addressedWrites = useRef(new Map<string, AddressedWrite>());
  const recordedInsertions = useRef(new WeakSet<Inserted>());
  const saved = useRef("");
  const dirty = useCallback(
    (document: BoardDocument) =>
      !saved.current ||
      canvasKey(document) !== canvasKey(JSON.parse(saved.current)),
    [],
  );
  const history = useRef<HistoryEntry[]>([]);
  const future = useRef<HistoryEntry[]>([]);
  const [parkedDrafts, setParkedDrafts] = useState<ParkedDraft[]>([]);
  const parkedRef = useRef<ParkedDraft[]>([]);
  const saving = useRef(false);
  const inFlightDocument = useRef("");
  const pendingMutation = useRef<{
    id: string;
    boardId: string;
    revision: number;
    document: string;
    base: BoardDocument;
    acknowledged?: boolean;
  } | null>(null);
  const savingDone = useRef<Promise<void> | null>(null);
  const pendingDraft = useRef<{
    key: string;
    value: { baseRevision: number; document: BoardDocument };
  } | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftNotify = useRef(notify);
  draftNotify.current = notify;
  const cancelDraft = useCallback((key?: string) => {
    if (key !== undefined && pendingDraft.current?.key !== key) return;
    if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    pendingDraft.current = null;
  }, []);
  const flushDraft = useCallback(() => {
    const draft = pendingDraft.current;
    cancelDraft();
    if (draft && !persist(draft.key, draft.value))
      draftNotify.current(
        "Локальный черновик не записан: хранилище браузера недоступно.",
        "error",
      );
  }, [cancelDraft]);
  const persistDraft = useCallback(
    (key: string, value: unknown) => {
      // A save acknowledgement or immediate edit supersedes the queued version.
      cancelDraft(key);
      return persist(key, value);
    },
    [cancelDraft],
  );
  const conflictRef = useRef(false);
  conflictRef.current = conflict;
  const loadSequence = useRef(0);
  const mounted = useRef(true);
  const [historyTick, setHistoryTick] = useState(0);
  const assign = useCallback((value: Board | null) => {
    current.current = value;
    setBoard(value);
  }, []);
  const locks = useCallback(
    (): AgentEntityWork[] => currentAgentWork(projectSync),
    [projectSync],
  );
  const canEditNode = useCallback(
    (id: string) => {
      const value = current.current;
      return !!value && !nodeWork(locks(), value.id, id);
    },
    [locks],
  );
  const canEditEdge = useCallback(
    (id: string) => {
      const value = current.current;
      return !!value && !edgeWork(locks(), value.id, id, value.document);
    },
    [locks],
  );
  const canRemoveNode = (id: string) => {
    const value = current.current;
    return (
      !!value &&
      canEditNode(id) &&
      !value.document.edges.some(
        (edge) =>
          (edge.source === id || edge.target === id) &&
          edgeWork(locks(), value.id, edge.id, value.document),
      )
    );
  };
  const canRename = () =>
    !!current.current && !boardWork(locks(), current.current.id);
  const canDelete = () =>
    !!current.current && !boardWork(locks(), current.current.id, true);
  const parkProtectedDraft = useCallback(() => {
    const value = current.current;
    if (!value || !saved.current || unknownRestoredBase.current) return;
    const base = JSON.parse(saved.current) as BoardDocument;
    let document = protectBoardChanges(value.id, base, value.document, locks());
    if (boardValuesEqual(value.document, document)) return;
    flushDraft();
    const next = [
      ...parkedRef.current,
      {
        createdAt: new Date().toISOString(),
        baseRevision: value.revision,
        document: value.document,
      },
    ];
    // Do not hide the draft unless its recovery copy is durable.
    if (!persist(agentDraftKey(workspaceId, value.id), next)) {
      conflictRef.current = true;
      setConflict(true);
      notify(
        "Черновик не удалось сохранить в браузере. Сохраните его копию перед продолжением.",
        "error",
      );
      return;
    }
    parkedRef.current = next;
    setParkedDrafts(next);
    const rebaseHistory = (entries: HistoryEntry[]) =>
      entries
        .map((entry) => ({
          before: protectBoardChanges(value.id, base, entry.before, locks()),
          after: protectBoardChanges(value.id, base, entry.after, locks()),
        }))
        .filter((entry) => !boardValuesEqual(entry.before, entry.after));
    history.current = rebaseHistory(history.current);
    future.current = rebaseHistory(future.current);
    setHistoryTick((n) => n + 1);
    // Reconnect may deliver board contents before the authoritative work snapshot.
    // Once its conflicting object is parked, resume any disjoint local edits.
    let rebased = value;
    const remote = latestRemote.current;
    if (remote?.id === value.id && remote.revision >= value.revision) {
      const merged = mergeBoardDocuments(base, document, remote.document);
      if (!merged.conflicts.length) {
        document = { ...merged.document, viewport: value.document.viewport };
        rebased = remote;
        saved.current = contentKey(remote.document);
        conflictRef.current = false;
        setConflict(false);
      }
    }
    assign({ ...rebased, document });
    persistDraft(
      draftKey(workspaceId, value.id),
      !dirty(document) ? null : { baseRevision: rebased.revision, document },
    );
    setState("Черновик занятого блока сохранён отдельно");
  }, [assign, locks, workspaceId, flushDraft, persistDraft, notify]);
  useEffect(() => {
    parkProtectedDraft();
    return projectSync?.subscribeWork?.(() => {
      parkProtectedDraft();
      setRetry((n) => n + 1);
    });
  }, [projectSync, parkProtectedDraft]);
  const select = useCallback(
    async (id: string) => {
      flushDraft();
      if (saving.current) {
        notify("Дождитесь сохранения доски.", "info");
        return;
      }
      setLoading(true);
      const sequence = ++loadSequence.current;
      try {
        const loaded = await api<Board>(`/api/boards/${id}`);
        while (savingDone.current) await savingDone.current;
        if (!mounted.current || sequence !== loadSequence.current) return;
        if (boardKind(loaded.document) !== kind)
          throw new Error("Выбранный документ принадлежит другой панели.");
        flushDraft();
        unknownRestoredBase.current = false;
        latestRemote.current = loaded;
        setPersisted(loaded);
        saved.current = contentKey(loaded.document);
        try {
          parkedRef.current = JSON.parse(
            localStorage.getItem(agentDraftKey(workspaceId, id)) || "[]",
          );
        } catch {
          parkedRef.current = [];
        }
        setParkedDrafts(parkedRef.current);
        history.current = [];
        future.current = [];
        let local: Board = loaded;
        let restored = false;
        conflictRef.current = false;
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
              boardKind(draft.document) === kind &&
              Array.isArray(draft.document.nodes) &&
              Array.isArray(draft.document.edges)
            ) {
              if (
                draft.document.viewport &&
                !readBoardViewport(workspaceId, id)
              )
                saveBoardViewport(workspaceId, id, draft.document.viewport);
              local = {
                ...loaded,
                revision: draft.baseRevision,
                document: {
                  ...draft.document,
                  viewport: loaded.document.viewport,
                },
              };
              restored =
                canvasKey(draft.document) !== canvasKey(loaded.document);
              if (!restored) {
                local = loaded;
                persistDraft(draftKey(workspaceId, id), null);
              }
              unknownRestoredBase.current =
                restored && draft.baseRevision !== loaded.revision;
              conflictRef.current = unknownRestoredBase.current;
              setConflict(conflictRef.current);
            }
          } else setConflict(false);
        } catch {
          setConflict(false);
        }
        assign(local);
        parkProtectedDraft();
        try {
          localStorage.setItem(selectedKey, id);
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
    [
      assign,
      workspaceId,
      notify,
      flushDraft,
      persistDraft,
      parkProtectedDraft,
      selectedKey,
      kind,
    ],
  );
  useEffect(() => {
    mounted.current = true;
    let live = true;
    api<BoardSummary[]>(collection)
      .then((data) => {
        if (!live) return;
        const items = data.filter((item) => (item.kind ?? "board") === kind);
        setList(items);
        setCollectionLoaded(true);
        let preferred: string | null = null;
        try {
          preferred = localStorage.getItem(selectedKey);
        } catch {}
        const initial = items.find((item) => item.id === preferred) || items[0];
        if (initial) void select(initial.id);
        else {
          setLoading(false);
          setState(kind === "board" ? "Нет досок" : "Нет презентаций");
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
  }, [workspaceId, kind]);
  const change = useCallback(
    (
      document: BoardDocument,
      record = true,
      options?: { deferDraft?: boolean },
    ) => {
      const old = current.current;
      if (!old) return;
      document = protectBoardChanges(old.id, old.document, document, locks());
      const previousNodes = new Map(
        old.document.nodes.map((node) => [node.id, node]),
      );
      document = {
        ...document,
        nodes: document.nodes.map((node) => {
          const previous = previousNodes.get(node.id);
          return previous &&
            previous.data.source !== node.data.source &&
            contentKey(previous.data.source) !== contentKey(node.data.source)
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
      // Navigation is personal view state, never a document edit.
      document = { ...document, viewport: old.document.viewport };
      if (canvasKey(document) === canvasKey(old.document)) return;
      if (record) {
        history.current.push({ before: old.document, after: document });
        if (history.current.length > 60) history.current.shift();
        future.current = [];
      }
      const next = { ...old, document };
      assign(next);
      setHistoryTick((n) => n + 1);
      const key = draftKey(workspaceId, old.id);
      const value = { baseRevision: old.revision, document };
      if (options?.deferDraft) {
        if (pendingDraft.current && pendingDraft.current.key !== key)
          flushDraft();
        cancelDraft();
        pendingDraft.current = { key, value };
        draftTimer.current = setTimeout(flushDraft, 200);
      } else if (!persistDraft(key, value))
        notify(
          "Локальный черновик не записан: хранилище браузера недоступно.",
          "error",
        );
      setState("Изменения…");
    },
    [assign, workspaceId, notify, cancelDraft, flushDraft, persistDraft, locks],
  );
  const receive = useCallback(
    (value: Board, acknowledged?: BoardDocument) => {
      if (boardKind(value.document) !== kind) return;
      for (const events of creationEvents.current) {
        const previous = events.get(value.id);
        if (!previous || previous.revision < value.revision)
          events.set(value.id, value);
      }
      setList((items) =>
        items.some((item) => item.id === value.id)
          ? items.map((item) =>
              item.id === value.id && item.revision < value.revision
                ? value
                : item,
            )
          : [value, ...items],
      );
      const old = current.current;
      if (!old || old.id !== value.id || value.revision <= old.revision) return;
      latestRemote.current = value;
      setPersisted(value);
      parkProtectedDraft();
      const local = current.current!;
      const pending = pendingMutation.current;
      const sent =
        pending?.boardId === value.id
          ? (JSON.parse(pending.document) as BoardDocument)
          : undefined;
      const ownEcho =
        sent &&
        pending &&
        !pending.acknowledged &&
        containsBoardChanges(pending.base, sent, value.document);
      if (ownEcho && pending) pending.acknowledged = true;
      const base =
        acknowledged ||
        (ownEcho ? sent : undefined) ||
        (saved.current
          ? (JSON.parse(saved.current) as BoardDocument)
          : old.document);
      const localDocument = protectBoardChanges(
        value.id,
        value.document,
        local.document,
        locks(),
      );
      const merged = mergeBoardDocuments(base, localDocument, value.document);
      if (merged.conflicts.length || conflictRef.current) {
        flushDraft();
        persistDraft(draftKey(workspaceId, value.id), {
          baseRevision: local.revision,
          document: local.document,
        });
        conflictRef.current = true;
        setConflict(true);
        setState("Конфликт версий — локальный черновик сохранён");
        return;
      }
      saved.current = contentKey(value.document);
      const document = {
        ...merged.document,
        viewport: local.document.viewport,
      };
      assign({ ...value, document });
      const hasChanges = canvasKey(document) !== canvasKey(value.document);
      persistDraft(
        draftKey(workspaceId, value.id),
        hasChanges ? { baseRevision: value.revision, document } : null,
      );
      setState(hasChanges ? "Изменения…" : "Сохранено");
      setHistoryTick((n) => n + 1);
    },
    [
      assign,
      flushDraft,
      parkProtectedDraft,
      persistDraft,
      workspaceId,
      locks,
      kind,
    ],
  );
  const save = useCallback(async () => {
    parkProtectedDraft();
    flushDraft();
    const snapshot = current.current;
    if (
      !snapshot ||
      saving.current ||
      conflictRef.current ||
      !dirty(snapshot.document)
    )
      return;
    saving.current = true;
    let finishSave!: () => void;
    savingDone.current = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    inFlightDocument.current = contentKey(snapshot.document);
    setState("Сохранение…");
    const serialized = contentKey(snapshot.document);
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
        base: JSON.parse(saved.current) as BoardDocument,
      };
    const mutation = pendingMutation.current;
    try {
      const result = await api<Board>(`/api/boards/${snapshot.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          baseRevision: snapshot.revision,
          mutationId: mutation.id,
          document: snapshot.document,
        }),
      });
      receive(result, snapshot.document);
      if (pendingMutation.current?.id === mutation.id)
        pendingMutation.current = null;
      if (
        current.current?.id === snapshot.id &&
        !conflictRef.current &&
        dirty(current.current.document)
      )
        setRetry((n) => n + 1);
    } catch (e) {
      if (current.current?.id !== snapshot.id || !mounted.current) return;
      flushDraft();
      const error = e as Error & { status?: number; code?: string };
      if (error.status === 423 || error.code === "ENTITY_AGENT_LOCKED") {
        parkProtectedDraft();
        setState("Агент работает — черновик сохранён");
      } else if (
        error.status === 409 ||
        /revision|conflict|конфликт/i.test(error.message) ||
        error.code === "REVISION_CONFLICT"
      ) {
        if (
          current.current.revision > snapshot.revision &&
          !conflictRef.current
        ) {
          // A newer event already rebased the local viewport safely.
          setRetry((n) => n + 1);
          return;
        }
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
  }, [receive, parkProtectedDraft, notify, flushDraft]);
  useEffect(() => {
    if (!projectSync) return;
    const removeRemote = (id: string) => {
      setList((items) => items.filter((b) => b.id !== id));
      const old = current.current;
      if (old?.id !== id) return;
      setPersisted(null);
      if (dirty(old.document)) {
        flushDraft();
        conflictRef.current = true;
        setConflict(true);
        setState("Доска удалена. Локальный черновик сохранён");
      } else {
        cancelDraft(draftKey(workspaceId, id));
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
      void api<BoardSummary[]>(collection)
        .then((data) => {
          const items = data.filter((item) => (item.kind ?? "board") === kind);
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
  }, [
    projectSync,
    receive,
    assign,
    notify,
    workspaceId,
    cancelDraft,
    flushDraft,
    persistDraft,
    collection,
    kind,
  ]);
  const flush = useCallback(async () => {
    const id = current.current?.id;
    flushDraft();
    if (!id) return;
    if (savingDone.current) await savingDone.current;
    for (let attempt = 0; attempt <= 5; attempt++) {
      const value = current.current;
      if (value?.id !== id)
        throw new Error("Документ изменился во время сохранения.");
      if (conflictRef.current)
        throw new Error(
          "Разрешите конфликт версий. Локальный черновик сохранён.",
        );
      if (!dirty(value.document)) return;
      if (attempt < 5) await save();
    }
    throw new Error(`Не удалось сохранить ${noun}.`);
  }, [save, flushDraft, dirty, noun]);
  useEffect(() => {
    if (!projectSync) return;
    return projectSync.register(`canvas-save:${kind}`, {
      context: () => (registerContext ? { boardId: current.current?.id } : {}),
      flush,
    });
  }, [projectSync, flush, kind, registerContext]);
  useEffect(() => {
    if (!board || conflict) return;
    const timer = setTimeout(() => void save(), 650);
    return () => clearTimeout(timer);
  }, [board?.document, retry, conflict, save]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      flushDraft();
      if (current.current && dirty(current.current.document)) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flushDraft();
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("pagehide", flushDraft);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      flushDraft();
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("pagehide", flushDraft);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [flushDraft]);
  const create = async (
    name: string,
    document = initialDocument(),
    preserveSelection = false,
    mutationId?: string,
    selectionSequence = loadSequence.current,
  ) => {
    flushDraft();
    // The new ID is known only after POST returns. Retain events observed while
    // it is pending so a later edit cannot be replaced by the creation snapshot.
    const events = new Map<string, Board>();
    creationEvents.current.add(events);
    let value: Board;
    try {
      const created = await api<Board>("/api/boards", {
        method: "POST",
        body: JSON.stringify({
          name,
          document,
          ...(kind === "presentation" ? { kind } : {}),
          mutationId,
        }),
      });
      if (!created?.id || boardKind(created.document) !== kind)
        throw new Error("Сервер вернул другой документ.");
      const observed = events.get(created.id);
      value =
        observed && observed.revision > created.revision ? observed : created;
    } finally {
      creationEvents.current.delete(events);
    }
    flushDraft();
    // The original conflicting draft remains recoverable after creating a copy.
    // The creation event can arrive before its HTTP response. Keep one entry
    // per board and do not replace a newer event with the creation revision.
    setList((items) =>
      items.some((item) => item.id === value.id)
        ? items.map((item) =>
            item.id === value.id && item.revision < value.revision
              ? value
              : item,
          )
        : [value, ...items],
    );
    if (preserveSelection && selectionSequence !== loadSequence.current)
      return value;
    ++loadSequence.current;
    setLoading(false);
    unknownRestoredBase.current = false;
    latestRemote.current = value;
    setPersisted(value);
    try {
      localStorage.setItem(selectedKey, value.id);
    } catch {}
    saved.current = contentKey(value.document);
    conflictRef.current = false;
    setConflict(false);
    parkedRef.current = [];
    setParkedDrafts([]);
    history.current = [];
    future.current = [];
    assign(value);
    setState("Сохранено");
    return value;
  };
  const rename = async (name: string) => {
    const value = current.current;
    if (!value) return;
    if (!canRename()) throw new Error("Агент работает с названием доски");
    if (saving.current) throw new Error("Дождитесь завершения сохранения.");
    await save();
    if (conflictRef.current)
      throw new Error("Сначала разрешите конфликт версий.");
    const fresh = current.current;
    if (fresh?.id !== value.id)
      throw new Error("Документ изменился перед переименованием.");
    if (!canRename()) throw new Error("Агент работает с названием доски");
    const renamed = await api<Board>(`/api/boards/${fresh.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        baseRevision: fresh.revision,
        mutationId: crypto.randomUUID(),
        name,
        document: fresh.document,
      }),
    });
    receive(renamed, fresh.document);
    setList((items) =>
      items.map((item) =>
        item.id === renamed.id && item.revision < renamed.revision
          ? renamed
          : item,
      ),
    );
  };
  const remove = async () => {
    const value = current.current;
    if (!value) return;
    if (!canDelete())
      throw new Error("Дождитесь завершения работы агента с доской");
    try {
      await api(`/api/boards/${value.id}`, {
        method: "DELETE",
        body: JSON.stringify({
          baseRevision: value.revision,
          mutationId: crypto.randomUUID(),
        }),
      });
    } catch (error) {
      flushDraft();
      if ((error as { status?: number }).status === 409) {
        conflictRef.current = true;
        setConflict(true);
        setState("Доска изменена. Обновите версию перед удалением.");
      }
      throw error;
    }
    persistDraft(draftKey(workspaceId, value.id), null);
    const remaining = list.filter((b) => b.id !== value.id);
    setList((items) => items.filter((board) => board.id !== value.id));
    if (current.current?.id !== value.id && current.current) return;
    ++loadSequence.current;
    assign(null);
    setPersisted(null);
    saved.current = "";
    setConflict(false);
    if (remaining[0]) await select(remaining[0].id);
  };
  const applyTo = (
    targetId: string | null,
    transform: (board: Board) => BoardDocument,
    actionId: string = crypto.randomUUID(),
  ): Promise<Inserted> => {
    let write = addressedWrites.current.get(actionId);
    if (!write) {
      write = { targetId, selectionSequence: loadSequence.current };
      addressedWrites.current.set(actionId, write);
    }
    if (write.targetId !== targetId)
      return Promise.reject(new Error("Цель добавления изменилась."));
    if (write.outcome) return Promise.resolve(write.outcome);
    if (write.pending) return write.pending;
    const operation = write;
    const execute = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!operation.prepared) {
          // Only flush the captured document if it is still the current one.
          // Other targets are updated by ID without switching the canvas.
          const selected = current.current;
          if (
            targetId &&
            selected?.id === targetId &&
            (dirty(selected.document) || savingDone.current)
          )
            await flush();
          const target = targetId
            ? await api<Board>(`/api/boards/${encodeURIComponent(targetId)}`)
            : {
                id: "",
                name: kind === "board" ? "Новая доска" : "Новая презентация",
                document: initialDocument(),
                revision: 0,
                updatedAt: "",
              };
          if (
            (targetId && target.id !== targetId) ||
            boardKind(target.document) !== kind
          )
            throw new Error("Выбранный документ принадлежит другой панели.");
          const document = transform(target);
          const addedIds = (
            before: { id: string }[],
            after: { id: string }[],
          ) => {
            const previous = new Set(before.map((item) => item.id));
            return new Set(
              after
                .filter((item) => !previous.has(item.id))
                .map((item) => item.id),
            );
          };
          operation.prepared = {
            target,
            document,
            ids: addedIds(target.document.nodes, document.nodes),
            edgeIds: addedIds(target.document.edges, document.edges),
          };
        }
        const { target, document, ids, edgeIds } = operation.prepared;
        try {
          const board = targetId
            ? await api<Board>(`/api/boards/${encodeURIComponent(targetId)}`, {
                method: "PATCH",
                body: JSON.stringify({
                  baseRevision: target.revision,
                  mutationId: actionId,
                  document,
                }),
              })
            : await create(
                target.name,
                document,
                true,
                actionId,
                operation.selectionSequence,
              );
          if (
            (targetId && board.id !== targetId) ||
            boardKind(board.document) !== kind
          )
            throw new Error("Сервер вернул другой документ.");
          if (targetId) receive(board);
          const inserted = { boardId: board.id, ids, edgeIds };
          recordInsertion(inserted);
          return inserted;
        } catch (error) {
          // Only a rejected version check permits changing the payload.
          // An ambiguous response must replay the identical mutation.
          if (
            targetId &&
            (error as { code?: string }).code === "REVISION_CONFLICT"
          ) {
            operation.prepared = undefined;
            if (attempt < 2) continue;
          }
          throw error;
        }
      }
      throw new Error(`Не удалось сохранить ${noun}.`);
    };
    operation.pending = execute()
      .then((result) => {
        operation.outcome = result;
        operation.prepared = undefined;
        if (addressedWrites.current.size > 100) {
          const oldest = [...addressedWrites.current].find(
            ([key, item]) => key !== actionId && item.outcome,
          );
          if (oldest) addressedWrites.current.delete(oldest[0]);
        }
        return result;
      })
      .finally(() => {
        operation.pending = undefined;
      });
    return operation.pending;
  };
  const reload = async () => {
    if (!current.current) return;
    persistDraft(draftKey(workspaceId, current.current.id), null);
    conflictRef.current = false;
    setConflict(false);
    await select(current.current.id);
  };
  const recordHistory = (
    document: BoardDocument,
    touched?: { nodeIds: string[]; edgeIds: string[] },
  ) => {
    if (current.current && touched) {
      const after = current.current.document;
      const restore = <T extends { id: string }>(
        before: T[],
        current: T[],
        touched: string[],
      ) => {
        const values = new Map(current.map((value) => [value.id, value]));
        for (const id of touched) {
          const original = before.find((value) => value.id === id);
          if (original) values.set(id, original);
          else values.delete(id);
        }
        const order = current
          .map((value) => value.id)
          .filter((id) => values.has(id));
        for (let index = 0; index < before.length; index++) {
          const id = before[index].id;
          if (!values.has(id) || order.includes(id)) continue;
          const successor = before
            .slice(index + 1)
            .find((value) => order.includes(value.id));
          if (successor) order.splice(order.indexOf(successor.id), 0, id);
          else order.push(id);
        }
        return order.map((id) => values.get(id)!);
      };
      document = {
        ...after,
        nodes: restore(document.nodes, after.nodes, touched.nodeIds),
        edges: restore(document.edges, after.edges, touched.edgeIds),
      };
    }
    if (
      !current.current ||
      boardValuesEqual(document, current.current.document)
    )
      return;
    history.current.push({ before: document, after: current.current.document });
    if (history.current.length > 60) history.current.shift();
    future.current = [];
    setHistoryTick((n) => n + 1);
  };
  const recordInsertion = (inserted: Inserted) => {
    const value = current.current;
    if (
      value?.id !== inserted.boardId ||
      recordedInsertions.current.has(inserted)
    )
      return;
    const document = value.document;
    if (
      ![...inserted.ids].some((id) =>
        document.nodes.some((node) => node.id === id),
      )
    )
      return;
    // Build the undo entry from the merged current document so unrelated
    // changes that arrived during the addressed write remain in both states.
    recordHistory({
      ...document,
      nodes: document.nodes.filter((node) => !inserted.ids.has(node.id)),
      edges: document.edges.filter((edge) => !inserted.edgeIds.has(edge.id)),
    });
    recordedInsertions.current.add(inserted);
  };
  const travel = (backwards: boolean) => {
    const source = backwards ? history : future;
    const destination = backwards ? future : history;
    const entry = source.current.at(-1);
    const value = current.current;
    if (!entry || !value) return;
    const merged = mergeBoardDocuments(
      backwards ? entry.after : entry.before,
      backwards ? entry.before : entry.after,
      value.document,
    );
    if (
      merged.conflicts.length ||
      !boardValuesEqual(
        merged.document,
        protectBoardChanges(value.id, value.document, merged.document, locks()),
      )
    ) {
      notify(
        "Это изменение затрагивает обновлённый или занятый агентом блок. Остальные блоки доступны.",
        "info",
      );
      return;
    }
    source.current.pop();
    change(merged.document, false);
    // Source edits advance sourceRevision even during undo. Record the actual
    // transition so redo compares against the version now visible to the user.
    const after = current.current!.document;
    const adjacent = source.current.at(-1);
    if (adjacent) {
      const boundary = backwards ? "after" : "before";
      const normalized = mergeBoardDocuments(
        merged.document,
        after,
        adjacent[boundary],
      );
      if (!normalized.conflicts.length)
        adjacent[boundary] = normalized.document;
    }
    destination.current.push(
      backwards
        ? { before: after, after: value.document }
        : { before: value.document, after },
    );
  };
  const undo = () => travel(true);
  const redo = () => travel(false);
  return {
    list,
    board,
    persisted,
    current,
    loading,
    ready: !loading && collectionLoaded && (!!board || !list.length),
    state,
    conflict,
    editable: true,
    canEditNode,
    canRemoveNode,
    canEditEdge,
    canRename,
    canDelete,
    parkedDrafts,
    change,
    select,
    create,
    applyTo,
    rename,
    remove,
    reload,
    save,
    flush,
    flushDraft,
    undo,
    redo,
    recordHistory,
    recordInsertion,
    selectionSequence: () => loadSequence.current,
    canUndo: history.current.length > 0,
    canRedo: future.current.length > 0,
    historyTick,
  };
}
