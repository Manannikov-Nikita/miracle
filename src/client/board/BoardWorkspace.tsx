import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  ConnectionMode,
  MiniMap,
  useReactFlow,
  type NodeChange,
  type EdgeChange,
  type Connection as FlowConnection,
  type ResizeParams,
} from "@xyflow/react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  DotsThree,
  FileMd,
  FloppyDisk,
  LinkSimple,
  Note,
  PencilSimple,
  Plus,
  SlidersHorizontal,
  Trash,
} from "@phosphor-icons/react";
import "@xyflow/react/dist/style.css";
import type {
  BoardDocument,
  BoardEdge,
  BoardNode,
  BoardNodeData,
  QueryRun,
  QuerySource,
  ResultSet,
} from "../../shared/types";
import { api, waitForRun } from "../api";
import { useProjectSync } from "../agents/ProjectSync";
import { Select } from "../components/Select";
import { ErrorBox } from "../components/UI";
import ArtifactNode, {
  BoardActions,
  type ArtifactFlowNode,
} from "./ArtifactNode";
import Inspector from "./Inspector";
import BoardFlow from "./BoardFlow";
import BoardEdgeView, {
  type BoardFlowEdge,
  type BoardEdgeGeometryPatch,
} from "./BoardEdgeView";
import {
  edgeGeometryKey,
  toBoardFlow,
  type BoardCanvasNode,
} from "./edge-flow";
import {
  applyRefresh,
  createResultNode,
  emptyDocument,
  rebindResult,
  removeNode,
} from "./model";
import { useBoard } from "./useBoard";
import { readBoardViewport, saveBoardViewport } from "./viewport";
import { applyBoardNodeChanges } from "./flow-nodes";
import { boardHandleSide } from "./connection-sides";
import {
  alignBoardNodes,
  snapBoardNodes,
  type AlignmentAction,
  type AlignmentGuide,
} from "./alignment";
import { AlignmentGuides } from "./AlignmentGuides";
import { AlignmentToolbar } from "./AlignmentToolbar";
import { snapResizedNode, type ResizeSides } from "./resize-snapping";
import "./board.css";
export { createResultNode } from "./model";
export interface BoardWorkspaceProps {
  workspaceId: string;
  incomingResult?: ResultSet | null;
  onIncomingConsumed: () => void;
  onOpenSource: (source: QuerySource, title: string) => void;
  onNotify: (message: string, tone?: "error" | "success" | "info") => void;
}
const nodeTypes = { artifact: ArtifactNode, "edge-anchor": () => null };
const edgeTypes = { board: BoardEdgeView };
// Documents store explicit sizes, while transient React Flow measurements are not persisted.
const boardFitOptions = { padding: 0.15, includeHiddenNodes: true };
function Workspace({
  workspaceId,
  incomingResult,
  onIncomingConsumed,
  onOpenSource,
  onNotify,
}: BoardWorkspaceProps) {
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;
  const notify = useCallback(
    (message: string, tone?: "error" | "success" | "info") =>
      notifyRef.current(message, tone),
    [],
  );
  const workspaceRef = useRef<HTMLElement>(null);
  const store = useBoard(workspaceId, notify);
  const { board, editable, change } = store;
  // Choose the camera once per board; remote content updates must not move it.
  const initialViewport = useMemo(
    () =>
      board
        ? (readBoardViewport(workspaceId, board.id) ?? board.document.viewport)
        : undefined,
    [workspaceId, board?.id],
  );
  const flow = useReactFlow<BoardCanvasNode, BoardFlowEdge>();
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const renderedBoard = useMemo(
    () =>
      board
        ? toBoardFlow(board.document, selectedIds)
        : { nodes: [], edges: [] },
    [board?.document, selectedIds],
  );
  const selectionRef = useRef<ReadonlySet<string>>(selectedIds);
  const projectSync = useProjectSync();
  useEffect(
    () =>
      projectSync?.register("board-selection", {
        context: () => {
          const current = store.current.current;
          return {
            boardId: current?.id,
            boardNodes:
              current?.document.nodes
                .filter((node) => selectionRef.current.has(node.id))
                .map((node) => ({ id: node.id, title: node.data.title })) || [],
          };
        },
        // useBoard registers the board's pending writes separately.
        flush: async () => {},
      }),
    [projectSync, store.current],
  );
  useEffect(() => {
    projectSync?.contextChanged();
  }, [projectSync, selectedIds, board?.id, board?.document.nodes]);
  const selectNodes = (ids: ReadonlySet<string>) => {
    selectionRef.current = ids;
    setSelectedIds(ids);
  };
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const movingIds = useRef<ReadonlySet<string> | null>(null);
  const altPressed = useRef(false);
  const snapCancelled = useRef(false);
  const [inspecting, setInspecting] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const hasSelection =
    board?.document.nodes.some((node) => selectedIds.has(node.id)) ||
    board?.document.edges.some((edge) => edge.id === selectedEdge);
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  useEffect(() => {
    if (editingEdge !== selectedEdge) setEditingEdge(null);
  }, [editingEdge, selectedEdge]);
  const [metadata, setMetadata] = useState<Record<string, ResultSet>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<
    "new" | "rename" | "delete" | "copy" | null
  >(null);
  const [name, setName] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<Error | null>(null);
  const boardMenuTrigger = useRef<HTMLButtonElement>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const [rebind, setRebind] = useState<ResultSet | null>(null);
  const [latestResult, setLatestResult] = useState<ResultSet | null>(null);
  const gesture = useRef<BoardDocument | null>(null);
  const resizing = useRef<{
    boardId: string;
    id: string;
    sides: ResizeSides;
    raw: ResizeParams;
    moved: boolean;
  } | null>(null);
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const resizeStart = useCallback(
    (id: string, sides: ResizeSides, raw: ResizeParams) => {
      const current = store.current.current;
      if (!editableRef.current || !current) return;
      resizing.current = { boardId: current.id, id, sides, raw, moved: false };
      gesture.current = current.document;
      movingIds.current = null;
      snapCancelled.current = false;
      setGuides([]);
    },
    [store.current],
  );
  const resize = useCallback(
    (id: string, raw: ResizeParams, moved: boolean) => {
      const active = resizing.current;
      if (
        !editableRef.current ||
        !active ||
        active.id !== id ||
        active.boardId !== store.current.current?.id
      )
        return;
      active.raw = raw;
      active.moved ||= moved;
      // onResizeEnd precedes XYFlow's final dimensions change. Keep the raw
      // rectangle until onNodesChange consumes it, so release cannot revert it.
    },
    [store.current],
  );
  const processing = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  // XYFlow emits position changes before its drag callbacks. Capture modifiers
  // before those changes, including mouseup, to keep the final snap consistent.
  useEffect(() => {
    const modifier = (event: MouseEvent | PointerEvent | KeyboardEvent) => {
      altPressed.current = event.altKey;
      if (event.altKey) setGuides([]);
    };
    const cancel = () => {
      altPressed.current = false;
      snapCancelled.current = true;
      setGuides([]);
    };
    const keyDown = (event: KeyboardEvent) => {
      modifier(event);
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("mousedown", modifier, true);
    window.addEventListener("mousemove", modifier, true);
    window.addEventListener("mouseup", modifier, true);
    window.addEventListener("pointermove", modifier, true);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", modifier, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("mousedown", modifier, true);
      window.removeEventListener("mousemove", modifier, true);
      window.removeEventListener("mouseup", modifier, true);
      window.removeEventListener("pointermove", modifier, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", modifier, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current) controller.abort();
    };
  }, []);
  useEffect(() => {
    setSelected(null);
    selectNodes(new Set());
    setGuides([]);
    gesture.current = null;
    resizing.current = null;
    movingIds.current = null;
    snapCancelled.current = false;
    setInspecting(false);
    setSelectedEdge(null);
    setEditingEdge(null);
    if (initialViewport) void flow.setViewport(initialViewport);
    else if (board) {
      const frame = requestAnimationFrame(
        () => void flow.fitView(boardFitOptions),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [workspaceId, board?.id]);
  useEffect(() => {
    const available = new Set(board?.document.nodes.map((node) => node.id));
    const ids = new Set(
      [...selectionRef.current].filter((id) => available.has(id)),
    );
    if (ids.size !== selectionRef.current.size) {
      selectNodes(ids);
      setSelected((primary) =>
        primary && ids.has(primary) ? primary : ([...ids].at(-1) ?? null),
      );
    }
  }, [board?.document.nodes]);
  const addResult = useCallback(
    async (result: ResultSet, position?: { x: number; y: number }) => {
      if (!editable) return;
      setLatestResult(result);
      const existing = store.current.current;
      if (!existing) {
        const document = emptyDocument();
        document.nodes.push(createResultNode(result));
        await store.create("Новая доска", document);
        return;
      }
      const point =
        position ??
        flow.screenToFlowPosition({
          x: window.innerWidth * 0.68,
          y: window.innerHeight * 0.35,
        });
      const node = createResultNode(result, point, existing.document.nodes);
      change({
        ...existing.document,
        nodes: [...existing.document.nodes, node],
      });
      setMetadata((values) => ({ ...values, [result.id]: result }));
      setSelected(node.id);
      selectNodes(new Set([node.id]));
    },
    [editable, change, flow, store.create],
  );
  useEffect(() => {
    if (!incomingResult || store.loading || processing.current) return;
    if (!editable) {
      onIncomingConsumed();
      notify("У наблюдателя нет прав на изменение доски.", "info");
      return;
    }
    processing.current = true;
    void addResult(incomingResult)
      .catch((e) => notify(e.message, "error"))
      .finally(() => {
        processing.current = false;
        onIncomingConsumed();
      });
  }, [incomingResult, store.loading, editable]);
  const update = useCallback(
    (id: string, patch: Partial<BoardNodeData>) => {
      const current = store.current.current;
      if (current)
        change({
          ...current.document,
          nodes: current.document.nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } } : n,
          ),
        });
    },
    [change],
  );
  const remove = useCallback(
    (id: string) => {
      const current = store.current.current;
      if (current) change(removeNode(current.document, id));
      if (selected === id) setSelected(null);
      selectNodes(
        new Set([...selectionRef.current].filter((value) => value !== id)),
      );
    },
    [change, selected],
  );
  const refresh = useCallback(
    async (id: string) => {
      const current = store.current.current;
      const node = current?.document.nodes.find((n) => n.id === id);
      if (!current || !node || !editable || busy[id] || store.conflict) return;
      const sourceRevision = node.data.sourceRevision ?? 1;
      const boardId = current.id;
      const controller = new AbortController();
      controllers.current.add(controller);
      setBusy((value) => ({ ...value, [id]: true }));
      try {
        await store.save();
        const live = store.current.current;
        if (
          !live ||
          live.id !== boardId ||
          live.document.nodes.find((n) => n.id === id)?.data.sourceRevision !==
            node.data.sourceRevision
        )
          throw new Error("Источник изменился. Повторите обновление.");
        const run = await api<QueryRun>(
          `/api/boards/${boardId}/nodes/${id}/refresh`,
          {
            method: "POST",
            body: JSON.stringify({ sourceRevision }),
            signal: controller.signal,
          },
        );
        const done = await waitForRun(run.id, undefined, controller.signal);
        if (done.status !== "completed" || !done.resultSetId)
          throw new Error(
            done.error ||
              "Обновление не завершено. Предыдущий снимок сохранён.",
          );
        const latest = store.current.current;
        if (
          latest?.id === boardId &&
          latest.document.nodes.find((n) => n.id === id)?.data
            .sourceRevision === sourceRevision
        ) {
          change(
            applyRefresh(latest.document, id, sourceRevision, done.resultSetId),
          );
          notify("Снимок обновлён.", "success");
        } else
          notify("Источник изменился; поздний результат не применён.", "info");
      } catch (e) {
        if (!controller.signal.aborted) notify((e as Error).message, "error");
      } finally {
        controllers.current.delete(controller);
        if (mounted.current) setBusy((value) => ({ ...value, [id]: false }));
      }
    },
    [editable, busy, change, store.save, notify],
  );
  const addText = (kind: "note" | "markdown") => {
    if (!board || !editable) return;
    const node: BoardNode = {
      id: crypto.randomUUID(),
      type: "artifact",
      position: flow.screenToFlowPosition({
        x: window.innerWidth * 0.65,
        y: window.innerHeight * 0.35,
      }),
      width: 360,
      height: 260,
      data: {
        kind,
        title: kind === "note" ? "Заметка" : "Markdown",
        text:
          kind === "markdown"
            ? "## Наблюдение\n\nДобавьте контекст к данным."
            : "",
      },
    };
    change({ ...board.document, nodes: [...board.document.nodes, node] });
    setSelected(node.id);
    selectNodes(new Set([node.id]));
  };
  const onNodesChange = (incoming: NodeChange<BoardCanvasNode>[]) => {
    const current = store.current.current;
    if (!current) return;
    const nodeIds = new Set(current.document.nodes.map((node) => node.id));
    const changes = incoming.filter(
      (item) =>
        item.type !== "add" && item.type !== "replace" && nodeIds.has(item.id),
    ) as NodeChange<ArtifactFlowNode>[];
    const selectionChanges = changes.filter(
      (c) => c.type === "select" || c.type === "remove",
    );
    if (selectionChanges.length) {
      const ids = new Set(selectionRef.current);
      for (const item of selectionChanges) {
        if (item.type === "select" && item.selected) ids.add(item.id);
        else ids.delete(item.id);
      }
      selectNodes(ids);
      setSelected((primary) =>
        primary && ids.has(primary) ? primary : ([...ids].at(-1) ?? null),
      );
      if (ids.size) setSelectedEdge(null);
    }
    if (!editable) return;
    const meaningful = changes.filter(
      (c) =>
        c.type !== "select" &&
        !(c.type === "dimensions" && c.resizing === undefined),
    );
    if (!meaningful.length) return;
    const ongoing = meaningful.some(
      (c) =>
        (c.type === "position" && c.dragging) ||
        (c.type === "dimensions" && c.resizing),
    );
    const completed = meaningful.some(
      (c) =>
        (c.type === "position" && c.dragging === false) ||
        (c.type === "dimensions" && c.resizing === false),
    );
    if (ongoing && !gesture.current) gesture.current = current.document;
    const dragging = meaningful.flatMap((c) =>
      c.type === "position" && c.dragging === true ? [c.id] : [],
    );
    if (dragging.length) {
      if (!movingIds.current) snapCancelled.current = false;
      movingIds.current = new Set(dragging);
    }
    let next = applyBoardNodeChanges(meaningful, current.document.nodes);
    const activeResize = resizing.current;
    const resizeChanges =
      activeResize?.boardId === current.id &&
      meaningful.some(
        (c) => c.type === "dimensions" && c.id === activeResize.id,
      );
    if (activeResize && resizeChanges && activeResize.moved) {
      // Raw callbacks contain the full rectangle; individual XYFlow changes
      // omit unchanged coordinates and final changes omit setAttributes.
      next = next.map((node) =>
        node.id === activeResize.id
          ? {
              ...node,
              position: { x: activeResize.raw.x, y: activeResize.raw.y },
              width: activeResize.raw.width,
              height: activeResize.raw.height,
            }
          : node,
      );
      if (!altPressed.current && !snapCancelled.current) {
        const snapped = snapResizedNode(
          next,
          activeResize.id,
          activeResize.sides,
          flow.getZoom(),
        );
        next = snapped.nodes;
        setGuides(completed ? [] : snapped.guides);
      } else setGuides([]);
    }
    const dragPositions = meaningful.some(
      (c) => c.type === "position" && c.dragging !== undefined,
    );
    if (
      movingIds.current &&
      dragPositions &&
      !altPressed.current &&
      !snapCancelled.current
    ) {
      const snapped = snapBoardNodes(next, movingIds.current, flow.getZoom());
      next = snapped.nodes;
      setGuides(completed ? [] : snapped.guides);
    } else if (dragPositions || completed) setGuides([]);
    const removed = new Set(
      changes.filter((c) => c.type === "remove").map((c) => c.id),
    );
    const document = {
      ...current.document,
      nodes: next,
      edges: current.document.edges.filter(
        (e) =>
          (!e.source || !removed.has(e.source)) &&
          (!e.target || !removed.has(e.target)),
      ),
    };
    change(document, !gesture.current);
    if (completed && gesture.current) {
      if (JSON.stringify(gesture.current) !== JSON.stringify(document))
        store.recordHistory(gesture.current);
      gesture.current = null;
    }
    if (completed && movingIds.current) movingIds.current = null;
    if (completed && resizeChanges) resizing.current = null;
  };
  const alignSelection = (action: AlignmentAction) => {
    const current = store.current.current;
    if (!current || !editable || selectionRef.current.size < 2) return;
    const nodes = alignBoardNodes(
      current.document.nodes,
      selectionRef.current,
      action,
    );
    change({ ...current.document, nodes });
    setGuides([]);
  };
  const connect = (connection: FlowConnection | Omit<BoardEdge, "id">) => {
    const document = store.current.current?.document;
    if (
      !document ||
      !editable ||
      !connection.source ||
      !connection.target ||
      connection.source === connection.target
    )
      return;
    change({
      ...document,
      edges: [
        ...document.edges,
        {
          id: crypto.randomUUID(),
          source: connection.source,
          target: connection.target,
          sourceHandle: boardHandleSide(connection.sourceHandle, "right"),
          targetHandle: boardHandleSide(connection.targetHandle, "left"),
          label: "label" in connection ? connection.label : undefined,
        },
      ],
    });
  };
  const selectedNode = board?.document.nodes.find((n) => n.id === selected);
  const updateEdge = (
    boardId: string,
    id: string,
    patch: Partial<Pick<BoardEdge, "label" | "appearance">>,
  ) => {
    const current = store.current.current;
    if (!editableRef.current || !current || current.id !== boardId) return;
    change({
      ...current.document,
      edges: current.document.edges.map((edge) =>
        edge.id === id
          ? {
              ...edge,
              ...patch,
              ...(patch.appearance
                ? {
                    appearance: { ...edge.appearance, ...patch.appearance },
                  }
                : {}),
            }
          : edge,
      ),
    });
  };
  const removeEdge = (boardId: string, id: string) => {
    const current = store.current.current;
    if (!editableRef.current || !current || current.id !== boardId) return;
    change({
      ...current.document,
      edges: current.document.edges.filter((edge) => edge.id !== id),
    });
    setSelectedEdge(null);
    setEditingEdge(null);
    workspaceRef.current?.focus({ preventScroll: true });
  };
  const updateEdgeGeometry = (
    boardId: string,
    id: string,
    patch: BoardEdgeGeometryPatch,
    expected?: BoardEdge,
  ) => {
    const current = store.current.current;
    if (!editableRef.current || !current || current.id !== boardId) return;
    const edge = current.document.edges.find((item) => item.id === id);
    if (
      !edge ||
      (expected && edgeGeometryKey(edge) !== edgeGeometryKey(expected))
    )
      return;
    const next = {
      ...edge,
      ...patch,
      ...(patch.appearance
        ? { appearance: { ...edge.appearance, ...patch.appearance } }
        : {}),
    };
    const nodeIds = new Set(current.document.nodes.map((node) => node.id));
    if (
      (next.source && !nodeIds.has(next.source)) ||
      (next.target && !nodeIds.has(next.target))
    )
      return;
    change({
      ...current.document,
      edges: current.document.edges.map((item) =>
        item.id === id ? next : item,
      ),
    });
  };
  const openDialog = (
    kind: NonNullable<typeof dialog>,
    trigger = document.activeElement as HTMLElement | null,
  ) => {
    dialogTrigger.current = trigger;
    setName(
      kind === "rename"
        ? (board?.name ?? "")
        : kind === "copy"
          ? `${board?.name ?? "Доска"} — копия`
          : "Новая доска",
    );
    setDialogError(null);
    setDialog(kind);
  };
  const submit = async () => {
    setDialogBusy(true);
    setDialogError(null);
    try {
      if (dialog === "delete") await store.remove();
      else if (!name.trim()) throw new Error("Введите название доски.");
      else if (dialog === "rename") await store.rename(name.trim());
      else if (dialog === "copy") {
        await store.create(name.trim(), board!.document);
      } else await store.create(name.trim());
      setDialog(null);
    } catch (e) {
      setDialogError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setDialogBusy(false);
    }
  };
  const actionContext = {
    boardId: board?.id ?? "",
    editable,
    resizeStart,
    resize,
    update,
    remove,
    refresh: (id: string) => void refresh(id),
    openSource: (id: string) => {
      const node = store.current.current?.document.nodes.find(
        (n) => n.id === id,
      );
      if (node?.data.source) onOpenSource(node.data.source, node.data.title);
    },
    inspect: (id: string) => {
      setSelected(id);
      selectNodes(new Set([id]));
      setInspecting(true);
    },
    metadata: useCallback(
      (result: ResultSet) =>
        setMetadata((values) =>
          values[result.id] ? values : { ...values, [result.id]: result },
        ),
      [],
    ),
    busy,
  };
  return (
    <section
      ref={workspaceRef}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (
          (e.target as HTMLElement).closest(
            "input,textarea,[contenteditable=true]",
          )
        )
          return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) store.redo();
          else store.undo();
        } else if (e.ctrlKey && e.key.toLowerCase() === "y") {
          e.preventDefault();
          store.redo();
        }
      }}
      className={`board-workspace${hasSelection ? " board-has-selection" : ""}`}
      aria-label="Аналитическая доска"
    >
      <div className="board-header">
        <span className="board-heading">Доска</span>
        <Select
          aria-label="Выбрать доску"
          value={board?.id ?? ""}
          placeholder="Выберите доску"
          onValueChange={(selectedId) => {
            void store.save().then(() => store.select(selectedId));
          }}
          options={store.list.map((b) => ({ value: b.id, label: b.name }))}
        />
        <span
          className={`board-save-state${store.conflict ? " board-warning" : ""}`}
          role="status"
          title={editable ? store.state : "Только просмотр"}
        >
          {editable ? store.state : "Только просмотр"}
        </span>
        {editable && (
          <>
            <button
              onClick={() => openDialog("new")}
              title="Создать доску"
              aria-label="Создать доску"
              className="board-header-icon"
            >
              <Plus size={17} aria-hidden="true" />
            </button>
            {board && (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    ref={boardMenuTrigger}
                    className="board-header-icon"
                    title="Действия с доской"
                    aria-label="Действия с доской"
                  >
                    <DotsThree size={19} weight="bold" aria-hidden="true" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="dropdown-menu"
                    align="end"
                    sideOffset={6}
                    collisionPadding={8}
                    onCloseAutoFocus={(event) => {
                      if (dialog) event.preventDefault();
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                    onKeyUp={(event) => event.stopPropagation()}
                  >
                    <DropdownMenu.Item
                      onSelect={() =>
                        openDialog("rename", boardMenuTrigger.current)
                      }
                    >
                      <PencilSimple size={16} aria-hidden="true" />
                      Переименовать доску
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      className="board-menu-danger"
                      onSelect={() =>
                        openDialog("delete", boardMenuTrigger.current)
                      }
                    >
                      <Trash size={16} aria-hidden="true" />
                      Удалить доску
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </>
        )}
      </div>
      {store.conflict && (
        <div className="board-conflict" role="alert">
          <span>
            Доска изменена в другой вкладке. Ваш черновик сохранён локально.
          </span>
          <button onClick={() => openDialog("copy")}>Сохранить копию</button>
          <button onClick={() => void store.reload()}>
            Загрузить серверную
          </button>
        </div>
      )}
      {board && (
        <div className="board-tools">
          <button
            disabled={!editable}
            onClick={() => addText("note")}
            title="Добавить заметку"
            aria-label="Добавить заметку"
            className="board-tools-icon"
          >
            <Note size={18} aria-hidden="true" />
          </button>
          <button
            disabled={!editable}
            onClick={() => addText("markdown")}
            title="Добавить Markdown"
            aria-label="Добавить Markdown"
            className="board-tools-icon"
          >
            <FileMd size={18} aria-hidden="true" />
          </button>
          <span className="board-tools-divider" />
          <button
            disabled={!editable || !store.canUndo}
            onClick={store.undo}
            className="board-tools-icon"
            aria-label="Отменить изменение"
            title="Отменить"
          >
            <ArrowCounterClockwise size={16} aria-hidden="true" />
          </button>
          <button
            disabled={!editable || !store.canRedo}
            onClick={store.redo}
            className="board-tools-icon"
            aria-label="Повторить изменение"
            title="Повторить"
          >
            <ArrowClockwise size={16} aria-hidden="true" />
          </button>
          <button
            disabled={!selectedNode}
            onClick={() => setInspecting((value) => !value)}
            className="board-tools-icon"
            aria-label="Свойства"
            aria-pressed={inspecting && !!selectedNode}
            title="Свойства выбранного блока"
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
          </button>
          {editable && selectedNode?.data.kind === "result" && (
            <button
              disabled={
                !latestResult ||
                latestResult.id === selectedNode.data.resultSetId
              }
              title="Заменить источник выбранного блока последним добавленным SQL-результатом"
              className="board-tools-icon"
              aria-label="Перепривязать"
              onClick={() => setRebind(latestResult)}
            >
              <LinkSimple size={16} aria-hidden="true" />
            </button>
          )}
          {editable && store.state.includes("Не сохранено") && (
            <button
              onClick={() => void store.save()}
              className="board-tools-icon"
              aria-label="Повторить сохранение"
              title="Повторить сохранение"
            >
              <FloppyDisk size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      <div
        className="board-canvas"
        onDragOver={(e) => {
          if (
            editable &&
            e.dataTransfer.types.includes("application/x-miracle-result")
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData("application/x-miracle-result");
          if (!raw || !editable) return;
          e.preventDefault();
          try {
            const result = JSON.parse(raw) as ResultSet;
            if (
              typeof result.id !== "string" ||
              !Array.isArray(result.columns) ||
              typeof result.source?.sql !== "string"
            )
              throw new Error("Некорректный результат запроса.");
            void addResult(
              result,
              flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
            ).catch((error) => notify(error.message, "error"));
          } catch (error) {
            notify((error as Error).message, "error");
          }
        }}
      >
        {board ? (
          <BoardActions.Provider value={actionContext}>
            <BoardFlow
              gestureScope={`${workspaceId}:${board.id}`}
              colorMode="dark"
              nodes={renderedBoard.nodes}
              edges={renderedBoard.edges.map(
                ({ edge: e, source, target }): BoardFlowEdge => ({
                  ...e,
                  source,
                  target,
                  ariaLabel: e.label ? `Стрелка: ${e.label}` : "Стрелка",
                  sourceHandle: e.sourceHandle ?? "right",
                  targetHandle: e.targetHandle ?? "left",
                  selected: e.id === selectedEdge,
                  type: "board",
                  data: {
                    edge: e,
                    gestureScope: `${workspaceId}:${board.id}`,
                    editable,
                    editing: editingEdge === e.id,
                    onSelect: () => {
                      setSelectedEdge(e.id);
                      setSelected(null);
                      selectNodes(new Set());
                      setInspecting(false);
                    },
                    onEdit: () => {
                      if (!editable) return;
                      setSelectedEdge(e.id);
                      setEditingEdge(e.id);
                      setSelected(null);
                      selectNodes(new Set());
                      setInspecting(false);
                    },
                    onFinishEdit: () =>
                      setEditingEdge((current) =>
                        current === e.id ? null : current,
                      ),
                    onChange: (patch) => updateEdge(board.id, e.id, patch),
                    onGeometryChange: (patch, expected) =>
                      updateEdgeGeometry(board.id, e.id, patch, expected),
                    onDelete: () => removeEdge(board.id, e.id),
                    onClose: () => {
                      setSelectedEdge(null);
                      setEditingEdge(null);
                      workspaceRef.current?.focus({ preventScroll: true });
                    },
                  },
                }),
              )}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={(changes: EdgeChange<BoardFlowEdge>[]) => {
                const selection = [...changes]
                  .reverse()
                  .find((item) => item.type === "select" && item.selected);
                if (selection?.type === "select") {
                  setSelectedEdge(selection.id);
                  setSelected(null);
                  selectNodes(new Set());
                } else if (
                  changes.some(
                    (item) =>
                      item.type === "select" &&
                      !item.selected &&
                      item.id === selectedEdge,
                  )
                )
                  setSelectedEdge(null);
                const current = store.current.current;
                if (
                  editableRef.current &&
                  current?.id === board.id &&
                  changes.some((c) => c.type === "remove")
                )
                  change({
                    ...current.document,
                    edges: current.document.edges.filter(
                      (edge) =>
                        !changes.some(
                          (item) =>
                            item.type === "remove" && item.id === edge.id,
                        ),
                    ),
                  });
              }}
              onConnect={connect}
              connectionMode={ConnectionMode.Loose}
              isValidConnection={(connection) =>
                connection.source !== connection.target
              }
              onNodeClick={(_, node) => {
                if (node.type !== "artifact") return;
                if (selectionRef.current.has(node.id)) setSelected(node.id);
                setSelectedEdge(null);
              }}
              onNodeDragStart={() => {
                snapCancelled.current = false;
              }}
              onNodeDragStop={() => {
                movingIds.current = null;
                setGuides([]);
              }}
              onSelectionDragStop={() => {
                movingIds.current = null;
                setGuides([]);
              }}
              onEdgeClick={(_, edge) => {
                setSelectedEdge(edge.id);
                setSelected(null);
                selectNodes(new Set());
              }}
              onPaneClick={() => {
                workspaceRef.current?.focus({ preventScroll: true });
                setSelected(null);
                selectNodes(new Set());
                setSelectedEdge(null);
                setInspecting(false);
              }}
              onMoveEnd={(_, viewport) => {
                if (store.current.current?.id === board.id)
                  saveBoardViewport(workspaceId, board.id, viewport);
              }}
              nodesDraggable={editable}
              nodesConnectable={editable}
              elementsSelectable
              selectionOnDrag
              selectionKeyCode={null}
              multiSelectionKeyCode={["Shift", "Meta", "Control"]}
              panOnDrag={[1, 2]}
              panOnScroll
              zoomOnDoubleClick={false}
              deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
              minZoom={0.15}
              maxZoom={2}
              defaultViewport={initialViewport}
              proOptions={{ hideAttribution: true }}
            >
              <AlignmentGuides guides={guides} />
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                color="var(--board-border)"
              />
              <Controls
                showInteractive={false}
                fitViewOptions={boardFitOptions}
              />
              <MiniMap
                style={{ width: 120, height: 75 }}
                pannable
                zoomable
                nodeColor="var(--board-border)"
                maskColor="color-mix(in srgb, var(--board-bg) 72%, transparent)"
              />
              {!board.document.nodes.length && !board.document.edges.length && (
                <div className="board-canvas-empty">
                  <strong>Начните с результата запроса</strong>
                  <span>
                    Нажмите «На доску» в SQL-панели или перетащите результат
                    сюда.
                  </span>
                  <span>
                    Добавьте заметки, графики и стрелки для контекста.
                  </span>
                </div>
              )}
            </BoardFlow>
          </BoardActions.Provider>
        ) : (
          <div className="board-canvas-empty">
            <strong>
              {store.loading ? "Загрузка досок…" : "Аналитическая доска"}
            </strong>
            <span>
              {editable
                ? "Создайте доску и добавьте результат SQL-запроса."
                : "В рабочем пространстве пока нет досок."}
            </span>
            {editable && !store.loading && (
              <button onClick={() => openDialog("new")}>Создать доску</button>
            )}
          </div>
        )}
        {editable && selectedIds.size >= 2 && (
          <AlignmentToolbar count={selectedIds.size} onAlign={alignSelection} />
        )}
        {selectedNode && inspecting && board && (
          <Inspector
            node={selectedNode}
            result={
              selectedNode.data.resultSetId
                ? metadata[selectedNode.data.resultSetId]
                : undefined
            }
            editable={editable}
            close={() => setInspecting(false)}
            change={(node) =>
              change({
                ...board.document,
                nodes: board.document.nodes.map((n) =>
                  n.id === node.id ? node : n,
                ),
              })
            }
            openSource={() => actionContext.openSource(selectedNode.id)}
          />
        )}
      </div>
      <footer className="board-footer">
        <span>
          {board
            ? `${board.document.nodes.length} блоков · ${board.document.edges.length} связей`
            : "Рабочая область"}
        </span>
        <span>
          Shift + клик: выбрать несколько · рамка: фон · панорама: пробел + фон
          · Alt: без привязки
        </span>
      </footer>
      <Dialog.Root
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open && !dialogBusy) setDialog(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="board-dialog-overlay" />
          <Dialog.Content
            className="board-dialog"
            onCloseAutoFocus={(event) => {
              if (dialogTrigger.current?.isConnected) {
                event.preventDefault();
                dialogTrigger.current.focus();
              }
            }}
          >
            <Dialog.Title>
              {dialog === "delete"
                ? "Удалить доску?"
                : dialog === "rename"
                  ? "Название доски"
                  : dialog === "copy"
                    ? "Копия вашего черновика"
                    : "Новая доска"}
            </Dialog.Title>
            <Dialog.Description>
              {dialog === "delete"
                ? `Доска «${board?.name}» будет удалена.`
                : dialog === "copy"
                  ? "Копия сохранит ваши блоки и закреплённые снимки."
                  : "Доска сохранится в вашей рабочей области."}
            </Dialog.Description>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {dialog !== "delete" && (
                <label>
                  Название
                  <input
                    autoFocus
                    value={name}
                    maxLength={200}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              )}
              {dialogError && (
                <ErrorBox
                  error={dialogError}
                  title={
                    dialog === "delete"
                      ? "Не удалось удалить доску."
                      : dialog === "rename"
                        ? "Не удалось переименовать доску."
                        : dialog === "copy"
                          ? "Не удалось сохранить копию."
                          : "Не удалось создать доску."
                  }
                  hint={
                    dialogError.message === "Введите название доски."
                      ? "Введите название и сохраните доску."
                      : dialog === "delete"
                        ? "Повторите удаление. Если доска изменилась, закройте диалог и загрузите актуальную версию."
                        : "Проверьте название и повторите сохранение."
                  }
                />
              )}
              <div className="board-dialog-actions">
                <button
                  type="button"
                  disabled={dialogBusy}
                  onClick={() => setDialog(null)}
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={dialogBusy}
                  className={
                    dialog === "delete" ? "board-danger" : "board-primary"
                  }
                >
                  {dialogBusy
                    ? "Сохранение…"
                    : dialog === "delete"
                      ? "Удалить"
                      : "Сохранить"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!rebind}
        onOpenChange={(open) => {
          if (!open) setRebind(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="board-dialog-overlay" />
          <Dialog.Content className="board-dialog">
            <Dialog.Title>Заменить источник блока?</Dialog.Title>
            <Dialog.Description>
              Блок «{selectedNode?.data.title}» получит последний добавленный
              результат и его SQL. Настройки графика будут сброшены. Другие
              блоки сохранят свои источники.
            </Dialog.Description>
            <div className="board-dialog-actions">
              <button onClick={() => setRebind(null)}>Отмена</button>
              <button
                className="board-primary"
                onClick={() => {
                  if (selectedNode && board && rebind)
                    change({
                      ...board.document,
                      nodes: board.document.nodes.map((node) =>
                        node.id === selectedNode.id
                          ? rebindResult(node, rebind)
                          : node,
                      ),
                    });
                  setRebind(null);
                }}
              >
                Заменить источник
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}
export default function BoardWorkspace(props: BoardWorkspaceProps) {
  return (
    <ReactFlowProvider>
      <Workspace {...props} />
    </ReactFlowProvider>
  );
}
