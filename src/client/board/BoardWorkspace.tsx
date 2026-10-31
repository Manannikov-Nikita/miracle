import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  ConnectionMode,
  MiniMap,
  applyEdgeChanges,
  useReactFlow,
  type NodeChange,
  type EdgeChange,
  type Connection as FlowConnection,
  type ResizeParams,
} from "@xyflow/react";
import * as Dialog from "@radix-ui/react-dialog";
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
import ArtifactNode, {
  BoardActions,
  type ArtifactFlowNode,
} from "./ArtifactNode";
import Inspector from "./Inspector";
import {
  applyRefresh,
  createResultNode,
  emptyDocument,
  rebindResult,
  removeNode,
} from "./model";
import { useBoard } from "./useBoard";
import { applyBoardNodeChanges, toArtifactFlowNode } from "./flow-nodes";
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
const nodeTypes = { artifact: ArtifactNode };
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
  const flow = useReactFlow<ArtifactFlowNode>();
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
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
  const [metadata, setMetadata] = useState<Record<string, ResultSet>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [dialog, setDialog] = useState<
    "new" | "rename" | "delete" | "copy" | null
  >(null);
  const [name, setName] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
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
    if (board?.document.viewport)
      void flow.setViewport(board.document.viewport);
    else if (board)
      requestAnimationFrame(() => void flow.fitView(boardFitOptions));
  }, [board?.id]);
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
  const onNodesChange = (changes: NodeChange<ArtifactFlowNode>[]) => {
    const current = store.current.current;
    if (!current) return;
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
        (e) => !removed.has(e.source) && !removed.has(e.target),
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
  const edge = board?.document.edges.find((e) => e.id === selectedEdge);
  const openDialog = (kind: NonNullable<typeof dialog>) => {
    setName(
      kind === "rename"
        ? (board?.name ?? "")
        : kind === "copy"
          ? `${board?.name ?? "Доска"} — копия`
          : "Новая доска",
    );
    setDialogError("");
    setDialog(kind);
  };
  const submit = async () => {
    setDialogBusy(true);
    setDialogError("");
    try {
      if (dialog === "delete") await store.remove();
      else if (!name.trim()) throw new Error("Введите название доски.");
      else if (dialog === "rename") await store.rename(name.trim());
      else if (dialog === "copy") {
        await store.create(name.trim(), board!.document);
      } else await store.create(name.trim());
      setDialog(null);
    } catch (e) {
      setDialogError((e as Error).message);
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
      className="board-workspace"
      aria-label="Аналитическая доска"
    >
      <div className="board-header">
        <span className="board-heading">ДОСКА</span>
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
        >
          {editable ? store.state : "Только просмотр"}
        </span>
        {editable && (
          <>
            <button onClick={() => openDialog("new")} title="Создать доску">
              ＋
            </button>
            {board && (
              <>
                <button
                  onClick={() => openDialog("rename")}
                  title="Переименовать доску"
                >
                  Имя
                </button>
                <button
                  onClick={() => openDialog("delete")}
                  title="Удалить доску"
                >
                  Удалить
                </button>
              </>
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
          <span>Добавить</span>
          <button disabled={!editable} onClick={() => addText("note")}>
            ▧ Заметка
          </button>
          <button disabled={!editable} onClick={() => addText("markdown")}>
            M↓ Markdown
          </button>
          <span className="board-tools-divider" />
          <button
            disabled={!editable || !store.canUndo}
            onClick={store.undo}
            aria-label="Отменить изменение"
            title="Отменить"
          >
            ↶
          </button>
          <button
            disabled={!editable || !store.canRedo}
            onClick={store.redo}
            aria-label="Повторить изменение"
            title="Повторить"
          >
            ↷
          </button>
          <button
            disabled={!selectedNode}
            onClick={() => setInspecting((value) => !value)}
          >
            Свойства
          </button>
          <button onClick={() => void flow.fitView(boardFitOptions)}>
            Вписать
          </button>
          {editable && selectedNode?.data.kind === "result" && (
            <button
              disabled={
                !latestResult ||
                latestResult.id === selectedNode.data.resultSetId
              }
              title="Заменить источник выбранного блока последним добавленным SQL-результатом"
              onClick={() => setRebind(latestResult)}
            >
              Перепривязать
            </button>
          )}
          {editable && store.state.includes("Не сохранено") && (
            <button onClick={() => void store.save()}>
              Повторить сохранение
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
            <ReactFlow<ArtifactFlowNode, BoardEdge>
              colorMode="dark"
              nodes={board.document.nodes.map((node) =>
                toArtifactFlowNode(node, selectedIds),
              )}
              edges={board.document.edges.map((e) => ({
                ...e,
                sourceHandle: e.sourceHandle ?? "right",
                targetHandle: e.targetHandle ?? "left",
                selected: e.id === selectedEdge,
                type: "smoothstep",
                markerEnd: { type: "arrowclosed" as never, color: "#8c95a7" },
                style: { stroke: "#8c95a7" },
                labelStyle: { fill: "#dfe3eb" },
                labelBgStyle: { fill: "#202329" },
              }))}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={(changes: EdgeChange<BoardEdge>[]) => {
                if (editable && changes.some((c) => c.type === "remove"))
                  change({
                    ...board.document,
                    edges: applyEdgeChanges<BoardEdge>(
                      changes,
                      board.document.edges,
                    ),
                  });
              }}
              onConnect={connect}
              connectionMode={ConnectionMode.Loose}
              isValidConnection={(connection) =>
                connection.source !== connection.target
              }
              onNodeClick={(_, node) => {
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
                if (editable) {
                  const current = store.current.current;
                  if (current) change({ ...current.document, viewport }, false);
                }
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
              defaultViewport={board.document.viewport}
              proOptions={{ hideAttribution: true }}
            >
              <AlignmentGuides guides={guides} />
              <Background
                variant={BackgroundVariant.Dots}
                gap={24}
                size={1}
                color="#343944"
              />
              <Controls
                showInteractive={false}
                fitViewOptions={boardFitOptions}
              />
              <MiniMap
                pannable
                zoomable
                nodeColor="#343944"
                maskColor="#181a1fb8"
              />
              {!board.document.nodes.length && (
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
            </ReactFlow>
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
        {edge && board && (
          <aside className="board-edge-editor" aria-label="Свойства стрелки">
            <label>
              Подпись стрелки
              <input
                maxLength={500}
                value={edge.label ?? ""}
                readOnly={!editable}
                onChange={(e) =>
                  change({
                    ...board.document,
                    edges: board.document.edges.map((item) =>
                      item.id === edge.id
                        ? { ...item, label: e.target.value }
                        : item,
                    ),
                  })
                }
              />
            </label>
            {editable && (
              <button
                onClick={() => {
                  change({
                    ...board.document,
                    edges: board.document.edges.filter(
                      (item) => item.id !== edge.id,
                    ),
                  });
                  setSelectedEdge(null);
                }}
              >
                Удалить стрелку
              </button>
            )}
          </aside>
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
          <Dialog.Content className="board-dialog">
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
                <p className="board-error" role="alert">
                  {dialogError}
                </p>
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
