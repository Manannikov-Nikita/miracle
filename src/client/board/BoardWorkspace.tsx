import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  ConnectionMode,
  MiniMap,
  ViewportPortal,
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
  CornersOut,
  PresentationChart,
  ProjectorScreen,
  FileMd,
  FloppyDisk,
  LinkSimple,
  Note,
  PencilSimple,
  Plus,
  SlidersHorizontal,
  Trash,
  TextT,
} from "@phosphor-icons/react";
import "@xyflow/react/dist/style.css";
import type {
  BoardDocument,
  BoardKind,
  PresentationSlide,
  BoardEdge,
  BoardNode,
  BoardNodeData,
  QueryRun,
  QuerySource,
  ResultSet,
} from "../../shared/types";
import { api, waitForRun } from "../api";
import {
  useCanvasWorkspace,
  type CanvasDestination,
  type CanvasHandle,
} from "../canvas-workspace";
import {
  PRESENTATION_HEIGHT,
  PRESENTATION_WIDTH,
} from "../../shared/presentation";
import { useProjectSync } from "../agents/ProjectSync";
import { useAgentWorkLocks } from "../agents/useAgentWork";
import { AgentWorkIndicator } from "../agents/AgentWorkIndicator";
import {
  boardWork,
  edgeWork,
  nodeWork,
  slideDeletionWork,
  slideWork,
} from "./agent-work";
import { Select } from "../components/Select";
import { ErrorBox } from "../components/UI";
import DateBatchProgress from "../components/DateBatchProgress";
import ArtifactNode, {
  BoardActions,
  type ArtifactFlowNode,
} from "./ArtifactNode";
import Inspector from "./Inspector";
import ShapePicker from "./ShapePicker";
import { presentationColors } from "./presentation-colors";
import { SHAPE_OPTIONS, type ShapeKind } from "../../shared/shapes";
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
import { preserveResizeAspect } from "./resize-aspect";
import {
  copyBoardSelection,
  createBoardFragment,
  type BoardFragment,
  nativeBoardClipboardTarget,
  pasteBoardFragment,
  readBoardClipboard,
} from "./clipboard";
import PresentationSlides from "./PresentationSlides";
import PresentationShow from "./PresentationShow";
import {
  addPresentationSlide,
  duplicatePresentationSlide,
  fitPresentationSlide,
  presentationSlideContent,
  removePresentationSlide,
  validateCanvasInsertion,
} from "./presentation-model";
import "./board.css";
const slideSnapFrame = {
  x: 0,
  y: 0,
  right: PRESENTATION_WIDTH,
  bottom: PRESENTATION_HEIGHT,
};
export { createResultNode } from "./model";
export interface BoardWorkspaceProps {
  workspaceId: string;
  incomingResult?: ResultSet | null;
  onIncomingConsumed?: () => void;
  kind?: BoardKind;
  active?: boolean;
  onActivate?: () => void;
  onOpenSource: (source: QuerySource, title: string) => void;
  onNotify: (message: string, tone?: "error" | "success" | "info") => void;
}
const nodeTypes = { artifact: ArtifactNode, "edge-anchor": () => null };
const edgeTypes = { board: BoardEdgeView };
// Documents store explicit sizes, while transient React Flow measurements are not persisted.
const boardFitOptions = { padding: 0.15, includeHiddenNodes: true };
function canvasFocusTarget(target: EventTarget | null): target is Element {
  return (
    target instanceof Element &&
    !target.closest(
      "a[href],button,input,select,textarea,[contenteditable=true],[role=textbox],.cm-editor,.monaco-editor",
    )
  );
}
type PendingBoardRefresh = {
  runId: string;
  boardId: string;
  nodeId: string;
  title: string;
  sourceRevision: number;
  resultSetId?: string;
};
const refreshStorageKey = (workspaceId: string, kind: BoardKind) =>
  `miracle:${kind}-refreshes:${workspaceId}`;
function readPendingRefreshes(
  workspaceId: string,
  kind: BoardKind,
): PendingBoardRefresh[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(refreshStorageKey(workspaceId, kind)) || "[]",
    );
    return Array.isArray(value)
      ? value.filter(
          (entry) =>
            entry &&
            [entry.runId, entry.boardId, entry.nodeId, entry.title].every(
              (part) => typeof part === "string",
            ) &&
            Number.isInteger(entry.sourceRevision) &&
            entry.sourceRevision >= 0 &&
            (entry.resultSetId === undefined ||
              typeof entry.resultSetId === "string"),
        )
      : [];
  } catch {
    return [];
  }
}
function Workspace({
  workspaceId,
  incomingResult,
  onIncomingConsumed,
  onOpenSource,
  onNotify,
  kind = "board",
  active = true,
  onActivate,
}: BoardWorkspaceProps) {
  const notifyRef = useRef(onNotify);
  notifyRef.current = onNotify;
  const notify = useCallback(
    (message: string, tone?: "error" | "success" | "info") =>
      notifyRef.current(message, tone),
    [],
  );
  const workspaceRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const registry = useCanvasWorkspace();
  const store = useBoard(workspaceId, notify, kind, false);
  const { board, editable, change, flushDraft } = store;
  const agentLocks = useAgentWorkLocks();
  const presentation = kind === "presentation";
  const canvasName = presentation ? "Презентация" : "Доска";
  const [slideSelections, setSlideSelections] = useState<
    Record<string, string>
  >({});
  const slide =
    board?.document.slides?.find(
      (slide) => slide.id === slideSelections[board.id],
    ) ?? board?.document.slides?.[0];
  const slideId = slide?.id;
  const activeRef = useRef(active);
  activeRef.current = active;
  const slideRef = useRef(slideId);
  slideRef.current = slideId;
  const selectSlide = (id: string) => {
    const current = store.current.current;
    if (!current) return;
    slideRef.current = id;
    setSlideSelections((values) => ({ ...values, [current.id]: id }));
  };
  const cameraId = board && (slideId ? `${board.id}:${slideId}` : board.id);
  // Choose the camera once per canvas or slide; incoming revisions leave it in place.
  const initialViewport = useMemo(
    () =>
      cameraId
        ? (readBoardViewport(workspaceId, cameraId) ??
          (presentation ? undefined : board?.document.viewport))
        : undefined,
    [workspaceId, cameraId],
  );
  const visibleContent = useMemo(
    () =>
      board
        ? slideId
          ? presentationSlideContent(board.document, slideId)
          : board.document
        : null,
    [board?.document, slideId],
  );
  const [previewNodes, setPreviewNodes] = useState<BoardNode[] | null>(null);
  const [localFocus, setLocalFocus] = useState(false);
  const [show, setShow] = useState<{
    boardId: string;
    slideId: string;
    trigger: HTMLElement;
  } | null>(null);
  const closeShow = useCallback(() => setShow(null), []);
  const showPending = useRef(false);
  const [startingShow, setStartingShow] = useState(false);
  const flow = useReactFlow<BoardCanvasNode, BoardFlowEdge>();
  const flowId = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const renderedBoard = useMemo(
    () =>
      board
        ? (() => {
            const rendered = toBoardFlow(
              {
                ...board.document,
                ...visibleContent,
                nodes: previewNodes ?? visibleContent!.nodes,
              },
              selectedIds,
            );
            return {
              ...rendered,
              nodes: rendered.nodes.map((original) => {
                const node =
                  presentation && original.type === "artifact"
                    ? { ...original, dragHandle: ".presentation-artifact" }
                    : original;
                return node.type === "artifact" &&
                  nodeWork(agentLocks, board.id, node.id)
                  ? {
                      ...node,
                      draggable: false,
                      connectable: false,
                      deletable: false,
                    }
                  : node.type === "artifact" && !store.canRemoveNode(node.id)
                    ? { ...node, deletable: false }
                    : node;
              }),
            };
          })()
        : { nodes: [], edges: [] },
    [
      board?.document,
      visibleContent,
      previewNodes,
      selectedIds,
      agentLocks,
      presentation,
    ],
  );
  const selectionRef = useRef<ReadonlySet<string>>(selectedIds);
  const projectSync = useProjectSync();
  useEffect(
    () =>
      projectSync?.register(`canvas-context:${kind}`, {
        context: () => {
          if (!activeRef.current) return {};
          const current = store.current.current;
          if (!current) return {};
          return {
            boardId: current.id,
            ...(slideRef.current ? { slideId: slideRef.current } : {}),
            boardNodes:
              current?.document.nodes
                .filter(
                  (node) =>
                    node.slideId === slideRef.current &&
                    selectionRef.current.has(node.id),
                )
                .map((node) => ({ id: node.id, title: node.data.title })) || [],
          };
        },
        // useBoard registers the board's pending writes separately.
        flush: async () => {},
      }),
    [projectSync, store.current, kind],
  );
  useEffect(() => {
    projectSync?.contextChanged();
  }, [
    projectSync,
    selectedIds,
    board?.id,
    board?.document.nodes,
    slideId,
    active,
  ]);
  const selectNodes = (ids: ReadonlySet<string>) => {
    selectionRef.current = ids;
    setSelectedIds(ids);
  };
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const movingIds = useRef<ReadonlySet<string> | null>(null);
  const altPressed = useRef(false);
  const shiftPressed = useRef(false);
  const duplicateDrag = useRef<{
    boardId: string;
    ids: Map<string, string>;
    edgeIds: Set<string>;
    cancelled: boolean;
  } | null>(null);
  const [copyDragging, setCopyDragging] = useState(false);
  const lastPaste = useRef<{
    copyId: string;
    boardId: string;
    slideId?: string;
    nextIndex: number;
  } | null>(null);
  const snapCancelled = useRef(false);
  const suppressDragClick = useRef(false);
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
  const [pendingRefreshes, setPendingRefreshes] = useState(() =>
    readPendingRefreshes(workspaceId, kind),
  );
  const pendingRefreshesRef = useRef(pendingRefreshes);
  const [refreshRuns, setRefreshRuns] = useState<Record<string, QueryRun>>({});
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>(
    {},
  );
  const [refreshActions, setRefreshActions] = useState<
    Record<string, "resume" | "cancel">
  >({});
  const refreshLocks = useRef(new Set<string>());
  const refreshStarts = useRef(new Set<string>());
  const refreshPollers = useRef(new Map<string, AbortController>());
  const conflictRef = useRef(store.conflict);
  conflictRef.current = store.conflict;
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
  const pointer = useRef({ x: 0, y: 0 });
  const transferDrag = useRef<{
    boardId: string;
    cancelled: boolean;
    viewport: ReturnType<typeof flow.getViewport>;
  } | null>(null);
  const restoreDragViewport = useCallback(
    (viewport: ReturnType<typeof flow.getViewport>) => {
      const current = flow.getViewport();
      if (
        current.x !== viewport.x ||
        current.y !== viewport.y ||
        current.zoom !== viewport.zoom
      )
        void flow.setViewport(viewport);
    },
    [flow],
  );
  const gestureNodes = useRef(new Set<string>());
  const gestureEdges = useRef(new Set<string>());
  const resizing = useRef<{
    boardId: string;
    id: string;
    sides: ResizeSides;
    start: ResizeParams;
    raw: ResizeParams;
    moved: boolean;
    canPreserveAspect: boolean;
    minimum?: { width: number; height: number };
    proportional: boolean;
  } | null>(null);
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const resizeStart = useCallback(
    (id: string, sides: ResizeSides, raw: ResizeParams) => {
      const current = store.current.current;
      if (!editableRef.current || !current || !store.canEditNode(id)) return;
      const node = current.document.nodes.find((item) => item.id === id);
      const corner =
        Boolean(sides.left) !== Boolean(sides.right) &&
        Boolean(sides.top) !== Boolean(sides.bottom);
      resizing.current = {
        boardId: current.id,
        id,
        sides,
        start: { ...raw },
        raw,
        moved: false,
        canPreserveAspect:
          corner &&
          (node?.data.kind === "shape" ||
            (node?.data.kind === "result" &&
              (node.data.view === "chart" || node.data.view === "custom"))),
        minimum:
          node?.data.kind === "shape" ? { width: 40, height: 40 } : undefined,
        proportional: false,
      };
      gesture.current = current.document;
      gestureNodes.current = new Set([id]);
      gestureEdges.current.clear();
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
        !store.canEditNode(id) ||
        !active ||
        active.id !== id ||
        active.boardId !== store.current.current?.id
      )
        return;
      active.raw = raw;
      active.moved ||= moved;
      // Latch the modifier for each actual movement, not mouseup: releasing
      // Shift just before the pointer must not undo the displayed proportion.
      if (moved)
        active.proportional = active.canPreserveAspect && shiftPressed.current;
      // onResizeEnd precedes XYFlow's final dimensions change. Keep the raw
      // rectangle until onNodesChange consumes it, so release cannot revert it.
    },
    [store.current],
  );
  const cancelDuplicateDrag = useCallback(() => {
    const active = duplicateDrag.current;
    const current = store.current.current;
    if (!active || active.cancelled || current?.id !== active.boardId) return;
    // XYFlow still owns the pointer gesture and may emit more changes after
    // Escape/blur. Keep the cancelled mapping until its final event or restart.
    active.cancelled = true;
    const copiedIds = new Set(active.ids.values());
    change(
      {
        ...current.document,
        nodes: current.document.nodes.filter((node) => !copiedIds.has(node.id)),
        edges: current.document.edges.filter(
          (edge) => !active.edgeIds.has(edge.id),
        ),
      },
      false,
    );
    selectNodes(new Set(active.ids.keys()));
    setSelected([...active.ids.keys()][0] ?? null);
    gesture.current = null;
    movingIds.current = null;
    setCopyDragging(false);
  }, [change, store.current]);
  useEffect(() => {
    if (
      !board ||
      !gesture.current ||
      ![...gestureNodes.current].some((id) =>
        nodeWork(agentLocks, board.id, id),
      )
    )
      return;
    gesture.current = null;
    resizing.current = null;
    movingIds.current = null;
    gestureNodes.current.clear();
    gestureEdges.current.clear();
    setGuides([]);
  }, [agentLocks, board?.id]);
  const processing = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  // XYFlow emits position changes before its drag callbacks. Capture modifiers
  // before those changes, including mouseup, to keep the final snap consistent.
  useEffect(() => {
    if (!active) return;
    const modifier = (event: MouseEvent | PointerEvent | KeyboardEvent) => {
      if ("clientX" in event)
        pointer.current = { x: event.clientX, y: event.clientY };
      altPressed.current = event.altKey;
      shiftPressed.current = event.shiftKey;
      if (event.altKey) setGuides([]);
    };
    const cancel = () => {
      altPressed.current = false;
      shiftPressed.current = false;
      snapCancelled.current = true;
      cancelDuplicateDrag();
      if (transferDrag.current) {
        transferDrag.current.cancelled = true;
        restoreDragViewport(transferDrag.current.viewport);
        setPreviewNodes(null);
      }
      flushDraft();
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
    window.addEventListener("pointerup", modifier, true);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("keyup", modifier, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("mousedown", modifier, true);
      window.removeEventListener("mousemove", modifier, true);
      window.removeEventListener("mouseup", modifier, true);
      window.removeEventListener("pointermove", modifier, true);
      window.removeEventListener("pointerup", modifier, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("keyup", modifier, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, [active, cancelDuplicateDrag, flushDraft, restoreDragViewport]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of controllers.current) controller.abort();
    };
  }, []);
  const fitSlide = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.clientWidth || !canvas.clientHeight) return;
    void flow.setViewport(
      fitPresentationSlide(canvas.clientWidth, canvas.clientHeight),
    );
  }, [flow]);
  const previousCamera = useRef<string | null>(null);
  const rememberedSelections = useRef(
    new Map<
      string,
      { ids: ReadonlySet<string>; primary: string | null; edge: string | null }
    >(),
  );
  useEffect(() => {
    if (presentation && previousCamera.current)
      rememberedSelections.current.set(previousCamera.current, {
        ids: selectionRef.current,
        primary: selected,
        edge: selectedEdge,
      });
    previousCamera.current = cameraId ?? null;
    const remembered = cameraId
      ? rememberedSelections.current.get(cameraId)
      : undefined;
    setSelected(remembered?.primary ?? null);
    selectNodes(remembered?.ids ?? new Set());
    setSelectedEdge(remembered?.edge ?? null);
    setGuides([]);
    gesture.current = null;
    resizing.current = null;
    movingIds.current = null;
    duplicateDrag.current = null;
    transferDrag.current = null;
    setPreviewNodes(null);
    setCopyDragging(false);
    snapCancelled.current = false;
    setInspecting(false);
    setEditingEdge(null);
    if (initialViewport) void flow.setViewport(initialViewport);
    else if (board && !presentation) {
      const frame = requestAnimationFrame(
        () => void flow.fitView(boardFitOptions),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [workspaceId, cameraId]);
  useEffect(() => {
    if (!presentation || !slideId || initialViewport) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const fitWhenVisible = () => {
      if (!canvas.clientWidth || !canvas.clientHeight) return;
      fitSlide();
      observer?.disconnect();
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(fitWhenVisible);
    observer?.observe(canvas);
    const frame = requestAnimationFrame(fitWhenVisible);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [cameraId, fitSlide]);
  useEffect(() => {
    const available = new Set(visibleContent?.nodes.map((node) => node.id));
    const ids = new Set(
      [...selectionRef.current].filter((id) => available.has(id)),
    );
    if (ids.size !== selectionRef.current.size) {
      selectNodes(ids);
      setSelected((primary) =>
        primary && ids.has(primary) ? primary : ([...ids].at(-1) ?? null),
      );
    }
    if (
      selectedEdge &&
      !visibleContent?.edges.some((edge) => edge.id === selectedEdge)
    )
      setSelectedEdge(null);
  }, [visibleContent]);
  const startShow = async (trigger: HTMLElement) => {
    const target = store.current.current;
    const id = slideRef.current;
    if (!target || !id || showPending.current) return;
    showPending.current = true;
    setStartingShow(true);
    try {
      await store.flush();
      const current = store.current.current;
      if (
        current?.id !== target.id ||
        !current.document.slides?.some((slide) => slide.id === id)
      )
        throw new Error("Слайд изменился перед показом. Выберите его снова.");
      setShow({ boardId: target.id, slideId: id, trigger });
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      showPending.current = false;
      setStartingShow(false);
    }
  };
  const slideMutation = (
    transform: (document: BoardDocument) => {
      document: BoardDocument;
      selection?: string;
    },
  ) => {
    const current = store.current.current;
    if (!current || !editable || store.conflict) return;
    try {
      const result = transform(current.document);
      change(result.document);
      const accepted = store.current.current?.document;
      if (
        result.selection &&
        accepted !== current.document &&
        accepted?.slides?.some((slide) => slide.id === result.selection)
      )
        selectSlide(result.selection);
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };
  const updateSlide = (
    id: string,
    patch: Pick<PresentationSlide, "title" | "background">,
  ) =>
    slideMutation((document) => ({
      document: {
        ...document,
        slides: document.slides?.map((slide) =>
          slide.id === id ? { ...slide, ...patch } : slide,
        ),
      },
    }));
  const reorderSlide = (from: string, to: string) =>
    slideMutation((document) => {
      const slides = [...(document.slides ?? [])];
      const a = slides.findIndex((slide) => slide.id === from);
      const b = slides.findIndex((slide) => slide.id === to);
      if (a < 0 || b < 0 || a === b) return { document };
      const [slide] = slides.splice(a, 1);
      slides.splice(b, 0, slide);
      return { document: { ...document, slides } };
    });
  const createSlide = (duplicate = false) =>
    slideMutation((document) => {
      const result =
        duplicate && slideRef.current
          ? duplicatePresentationSlide(document, slideRef.current)
          : addPresentationSlide(document);
      return { document: result.document, selection: result.slide.id };
    });
  const deleteSlide = (id: string) =>
    slideMutation((document) => {
      const index =
        document.slides?.findIndex((slide) => slide.id === id) ?? -1;
      if (index < 0) return { document };
      const result = removePresentationSlide(document, id);
      const slides = result.slides!;
      return {
        document: result,
        selection:
          slideRef.current === id
            ? slides[Math.min(index, slides.length - 1)].id
            : undefined,
      };
    });
  const canvasBounds = () => canvasRef.current?.getBoundingClientRect();
  const visibleCanvasBounds = () => {
    if (workspaceRef.current?.closest("[hidden], [inert]")) return undefined;
    const bounds = canvasBounds();
    return bounds && bounds.width > 0 && bounds.height > 0 ? bounds : undefined;
  };
  const canvasCenter = () => {
    const bounds = canvasBounds();
    return bounds
      ? flow.screenToFlowPosition({
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
        })
      : { x: 0, y: 0 };
  };
  const insertionSlide = (
    document: BoardDocument,
    destination: CanvasDestination | null,
  ) => {
    if (!presentation) return undefined;
    const id = destination ? destination.slideId : document.slides?.[0]?.id;
    if (!id || !document.slides?.some((slide) => slide.id === id))
      throw new Error("Слайд для вставки удалён.");
    return id;
  };
  const selectInserted = (
    ids: ReadonlySet<string>,
    destination: CanvasDestination | null,
    boardId: string,
  ) => {
    if (
      store.current.current?.id !== boardId ||
      (destination && destination.slideId !== slideRef.current)
    )
      return;
    const primary = [...ids][0] ?? null;
    const targetCamera = destination?.slideId
      ? `${boardId}:${destination.slideId}`
      : boardId;
    if (presentation && targetCamera !== previousCamera.current) {
      rememberedSelections.current.set(targetCamera, {
        ids,
        primary,
        edge: null,
      });
      return;
    }
    selectNodes(ids);
    setSelected(primary);
    setSelectedEdge(null);
    setInspecting(false);
  };
  const insertCanvasResult = async (
    result: ResultSet,
    destination: CanvasDestination | null,
    position?: { x: number; y: number },
    actionId?: string,
  ) => {
    if (!editable || (destination && destination.kind !== kind))
      throw new Error("Выбранная панель недоступна для записи.");
    const center = canvasCenter();
    const updated = await store.applyTo(
      destination?.boardId ?? null,
      (target) => {
        const id = insertionSlide(target.document, destination);
        const centerPoint = id
          ? {
              x: (PRESENTATION_WIDTH - 540) / 2,
              y: (PRESENTATION_HEIGHT - 350) / 2,
            }
          : destination
            ? center
            : { x: 80, y: 80 };
        const node = createResultNode(
          result,
          position ?? centerPoint,
          target.document.nodes,
        );
        node.slideId = id;
        const document = {
          ...target.document,
          nodes: [...target.document.nodes, node],
        };
        validateCanvasInsertion(document);
        return document;
      },
      actionId,
    );
    setLatestResult(result);
    setMetadata((values) => ({ ...values, [result.id]: result }));
    selectInserted(updated.ids, destination, updated.boardId);
  };
  const insertCanvasFragment = async (
    fragment: BoardFragment,
    destination: CanvasDestination | null,
    position?: { x: number; y: number },
    actionId?: string,
  ) => {
    if (!editable || (destination && destination.kind !== kind))
      throw new Error("Выбранная панель недоступна для записи.");
    if (fragment.workspaceId !== workspaceId)
      throw new Error("Нельзя вставить блоки из другого проекта.");
    const center = presentation
      ? { x: PRESENTATION_WIDTH / 2, y: PRESENTATION_HEIGHT / 2 }
      : canvasCenter();
    const originalSlide = slideRef.current;
    const selectionSequence = store.selectionSequence();
    const selectionUnchanged = () =>
      store.selectionSequence() === selectionSequence &&
      slideRef.current === originalSlide;
    const updated = await store.applyTo(
      destination?.boardId ?? null,
      (target) => {
        const pasted = pasteBoardFragment(
          fragment,
          target,
          position ?? center,
          0,
          {
            slideId: insertionSlide(target.document, destination),
            placement: position ? "pointer" : "center",
          },
        );
        return pasted.document;
      },
      actionId,
    );
    if (
      presentation &&
      destination?.slideId &&
      !position &&
      selectionUnchanged()
    ) {
      let expectedSequence = selectionSequence;
      if (store.current.current?.id !== updated.boardId) {
        try {
          await store.flush();
          if (selectionUnchanged()) {
            const opening = store.select(updated.boardId);
            expectedSequence = store.selectionSequence();
            await opening;
          }
        } catch (error) {
          notify((error as Error).message, "info");
        }
      }
      if (
        store.current.current?.id === updated.boardId &&
        store.selectionSequence() === expectedSequence &&
        store.current.current.document.slides?.some(
          (item) => item.id === destination.slideId,
        )
      ) {
        selectSlide(destination.slideId);
        store.recordInsertion(updated);
      }
    }
    selectInserted(updated.ids, destination, updated.boardId);
  };
  const registryHandle = useRef<CanvasHandle | null>(null);
  registryHandle.current = {
    destination: () => {
      const current = store.current.current;
      return current
        ? { kind, boardId: current.id, slideId: slideRef.current }
        : null;
    },
    ready: () => store.ready,
    visible: () => !!visibleCanvasBounds(),
    insertResult: (result, destination, actionId) =>
      insertCanvasResult(result, destination, undefined, actionId),
    insertFragment: insertCanvasFragment,
    containsPoint: ({ x, y }) => {
      const bounds = visibleCanvasBounds();
      return (
        !!bounds &&
        x >= bounds.left &&
        x <= bounds.right &&
        y >= bounds.top &&
        y <= bounds.bottom
      );
    },
    screenToCanvas: (point) => flow.screenToFlowPosition(point),
  };
  useEffect(
    () =>
      registry?.register(kind, {
        destination: () => registryHandle.current!.destination(),
        ready: () => registryHandle.current!.ready!(),
        visible: () => registryHandle.current!.visible!(),
        insertResult: (...args) =>
          registryHandle.current!.insertResult(...args),
        insertFragment: (...args) =>
          registryHandle.current!.insertFragment(...args),
        containsPoint: (point) => registryHandle.current!.containsPoint(point),
        screenToCanvas: (point) =>
          registryHandle.current!.screenToCanvas(point),
      }),
    [registry, kind],
  );
  const addResult = useCallback(
    async (result: ResultSet, position?: { x: number; y: number }) => {
      if (!editable) return;
      if (presentation) {
        await insertCanvasResult(
          result,
          registryHandle.current!.destination(),
          position,
        );
        return;
      }
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
    [editable, change, flow, store.create, presentation, insertCanvasResult],
  );
  useEffect(() => {
    if (!incomingResult || store.loading || processing.current) return;
    if (!editable) {
      onIncomingConsumed?.();
      notify("У наблюдателя нет прав на изменение доски.", "info");
      return;
    }
    processing.current = true;
    void addResult(incomingResult)
      .catch((e) => notify(e.message, "error"))
      .finally(() => {
        processing.current = false;
        onIncomingConsumed?.();
      });
  }, [incomingResult, store.loading, editable]);
  const update = useCallback(
    (id: string, patch: Partial<BoardNodeData>) => {
      const current = store.current.current;
      if (current && store.canEditNode(id))
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
      if (!current || !store.canRemoveNode(id)) return;
      change(removeNode(current.document, id));
      if (selected === id) setSelected(null);
      selectNodes(
        new Set([...selectionRef.current].filter((value) => value !== id)),
      );
    },
    [change, selected],
  );
  function updatePendingRefreshes(
    update: (current: PendingBoardRefresh[]) => PendingBoardRefresh[],
  ) {
    // Merge with current storage so another browser tab's pending runs are retained.
    let current = readPendingRefreshes(workspaceId, kind);
    for (const entry of pendingRefreshesRef.current)
      if (!current.some((other) => other.runId === entry.runId))
        current.push(entry);
    const next = update(current);
    pendingRefreshesRef.current = next;
    try {
      localStorage.setItem(
        refreshStorageKey(workspaceId, kind),
        JSON.stringify(next),
      );
    } catch {
      notify(
        "Не удалось сохранить состояние обновления в браузере. Продолжите серию до закрытия страницы.",
        "error",
      );
    }
    if (mounted.current) setPendingRefreshes(next);
  }
  function forgetRefresh(runId: string) {
    updatePendingRefreshes((items) =>
      items.filter((item) => item.runId !== runId),
    );
  }
  async function trackRefresh(pending: PendingBoardRefresh) {
    if (!mounted.current || refreshPollers.current.has(pending.runId)) return;
    const controller = new AbortController();
    refreshPollers.current.set(pending.runId, controller);
    controllers.current.add(controller);
    setBusy((value) => ({ ...value, [pending.nodeId]: true }));
    setRefreshErrors((value) => ({ ...value, [pending.runId]: "" }));
    try {
      const done = await waitForRun(
        pending.runId,
        (run) => {
          if (mounted.current && !controller.signal.aborted)
            setRefreshRuns((value) => ({ ...value, [pending.runId]: run }));
        },
        controller.signal,
      );
      if (
        !mounted.current ||
        controller.signal.aborted ||
        done.status === "paused"
      )
        return;
      if (done.status === "completed" && done.resultSetId) {
        const latest = store.current.current;
        // Keep the link until this board is opened again, or its conflict is resolved.
        if (
          latest?.id !== pending.boardId ||
          !editableRef.current ||
          !store.canEditNode(pending.nodeId) ||
          conflictRef.current
        )
          return;
        const node = latest.document.nodes.find(
          (item) => item.id === pending.nodeId,
        );
        if (
          node &&
          (node.data.sourceRevision ?? 0) === pending.sourceRevision &&
          node.data.resultSetId === pending.resultSetId
        ) {
          change(
            applyRefresh(
              latest.document,
              pending.nodeId,
              pending.sourceRevision,
              done.resultSetId,
            ),
          );
          notify("Снимок обновлён.", "success");
        } else if (node?.data.resultSetId !== done.resultSetId) {
          notify("Источник изменился; поздний результат не применён.", "info");
        }
      } else if (done.status !== "cancelled") {
        notify(
          done.error || "Обновление не завершено. Предыдущий снимок сохранён.",
          "error",
        );
      }
      forgetRefresh(pending.runId);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current)
        setRefreshErrors((value) => ({
          ...value,
          [pending.runId]: (error as Error).message,
        }));
    } finally {
      controllers.current.delete(controller);
      if (refreshPollers.current.get(pending.runId) === controller)
        refreshPollers.current.delete(pending.runId);
      if (mounted.current)
        setBusy((value) => ({ ...value, [pending.nodeId]: false }));
    }
  }
  useEffect(() => {
    if (!board || !editable || store.conflict || store.loading) return;
    for (const pending of pendingRefreshes) {
      const run = refreshRuns[pending.runId];
      if (
        pending.boardId === board.id &&
        store.canEditNode(pending.nodeId) &&
        !refreshErrors[pending.runId] &&
        (!run || ["running", "cancelling", "completed"].includes(run.status))
      )
        void trackRefresh(pending);
    }
  }, [
    board?.id,
    editable,
    store.conflict,
    store.loading,
    pendingRefreshes,
    refreshRuns,
    refreshErrors,
    agentLocks,
  ]);
  async function resolveRefresh(
    pending: PendingBoardRefresh,
    action: "resume" | "cancel",
  ) {
    if (refreshLocks.current.has(pending.runId)) return;
    refreshLocks.current.add(pending.runId);
    setRefreshActions((value) => ({ ...value, [pending.runId]: action }));
    setRefreshErrors((value) => ({ ...value, [pending.runId]: "" }));
    try {
      const run = await api<QueryRun>(
        `/api/query-runs/${pending.runId}/${action}`,
        { method: "POST" },
      );
      if (!mounted.current) return;
      setRefreshRuns((value) => ({ ...value, [pending.runId]: run }));
      await trackRefresh(pending);
    } catch (error) {
      if (mounted.current)
        setRefreshErrors((value) => ({
          ...value,
          [pending.runId]: (error as Error).message,
        }));
      // An accepted request may have lost its response or another tab may have resumed it.
      try {
        const current = await api<QueryRun>(`/api/query-runs/${pending.runId}`);
        if (mounted.current && current.status !== "paused") {
          setRefreshRuns((value) => ({ ...value, [pending.runId]: current }));
          await trackRefresh(pending);
        }
      } catch {}
    } finally {
      refreshLocks.current.delete(pending.runId);
      if (mounted.current)
        setRefreshActions((value) => {
          const next = { ...value };
          delete next[pending.runId];
          return next;
        });
    }
  }
  const refresh = useCallback(
    async (id: string) => {
      const current = store.current.current;
      const node = current?.document.nodes.find((n) => n.id === id);
      if (
        !current ||
        !node ||
        !editable ||
        !store.canEditNode(id) ||
        busy[id] ||
        store.conflict ||
        refreshStarts.current.has(`${current.id}:${id}`) ||
        pendingRefreshesRef.current.some(
          (pending) => pending.boardId === current.id && pending.nodeId === id,
        )
      )
        return;
      const sourceRevision = node.data.sourceRevision ?? 0;
      const boardId = current.id;
      const lock = `${boardId}:${id}`;
      refreshStarts.current.add(lock);
      setBusy((value) => ({ ...value, [id]: true }));
      try {
        await store.save();
        const live = store.current.current;
        const liveNode = live?.document.nodes.find((n) => n.id === id);
        if (
          !live ||
          live.id !== boardId ||
          !liveNode ||
          !store.canEditNode(id) ||
          (liveNode.data.sourceRevision ?? 0) !== sourceRevision
        )
          throw new Error("Источник изменился. Повторите обновление.");
        const run = await api<QueryRun>(
          `/api/boards/${boardId}/nodes/${id}/refresh`,
          {
            method: "POST",
            body: JSON.stringify({ sourceRevision }),
          },
        );
        const pending = {
          runId: run.id,
          boardId,
          nodeId: id,
          title: node.data.title,
          sourceRevision,
          resultSetId: node.data.resultSetId,
        };
        updatePendingRefreshes((items) => [...items, pending]);
        await trackRefresh(pending);
      } catch (e) {
        if (mounted.current) notify((e as Error).message, "error");
      } finally {
        refreshStarts.current.delete(lock);
        if (mounted.current) setBusy((value) => ({ ...value, [id]: false }));
      }
    },
    [editable, busy, change, store.save, notify],
  );
  const addShape = (type: ShapeKind) => {
    const current = store.current.current;
    if (!current || current.id !== board?.id || !editable || store.conflict)
      return;
    const width = type === "triangle" || type === "diamond" ? 180 : 240;
    const height = type === "triangle" || type === "diamond" ? 180 : 160;
    const bounds = canvasRef.current?.getBoundingClientRect();
    const center = slideId
      ? { x: PRESENTATION_WIDTH / 2, y: PRESENTATION_HEIGHT / 2 }
      : flow.screenToFlowPosition({
          x: bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2,
          y: bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2,
        });
    const node: BoardNode = {
      id: crypto.randomUUID(),
      type: "artifact",
      slideId,
      position: { x: center.x - width / 2, y: center.y - height / 2 },
      width,
      height,
      data: {
        kind: "shape",
        title: SHAPE_OPTIONS.find((option) => option.type === type)!.label,
        text: "",
        shape: { type },
      },
    };
    const document = {
      ...current.document,
      nodes: [...current.document.nodes, node],
    };
    try {
      validateCanvasInsertion(document);
      change(document);
    } catch (error) {
      notify((error as Error).message, "error");
      return;
    }
    setSelected(node.id);
    selectNodes(new Set([node.id]));
    setSelectedEdge(null);
    setInspecting(true);
  };
  const addText = (kind: "note" | "markdown" | "text") => {
    if (!board || !editable || store.conflict) return;
    const plainText = kind === "text";
    const width = 360;
    const height = plainText ? 120 : 260;
    const bounds = canvasRef.current?.getBoundingClientRect();
    const center =
      plainText && bounds
        ? flow.screenToFlowPosition({
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          })
        : null;
    const boardText = workspaceRef.current
      ? getComputedStyle(workspaceRef.current)
          .getPropertyValue("--board-text")
          .trim()
      : "";
    const node: BoardNode = {
      id: crypto.randomUUID(),
      type: "artifact",
      slideId,
      position: slideId
        ? {
            x: (PRESENTATION_WIDTH - width) / 2,
            y: (PRESENTATION_HEIGHT - height) / 2,
          }
        : center
          ? { x: center.x - width / 2, y: center.y - height / 2 }
          : flow.screenToFlowPosition({
              x: window.innerWidth * 0.65,
              y: window.innerHeight * 0.35,
            }),
      width,
      height,
      data: {
        kind,
        title: plainText ? "Текст" : kind === "note" ? "Заметка" : "Markdown",
        text:
          kind === "markdown"
            ? "## Наблюдение\n\nДобавьте контекст к данным."
            : plainText
              ? "Текст"
              : "",
        ...(plainText && {
          textStyle: {
            fontFamily: "sans" as const,
            fontSize: 32,
            textAlign: "left" as const,
            verticalAlign: "top" as const,
            textColor: slide
              ? presentationColors(slide.background).text
              : /^#[0-9a-f]{6}$/i.test(boardText)
                ? boardText
                : "#eeeff0",
          },
        }),
      },
    };
    const document = {
      ...board.document,
      nodes: [...board.document.nodes, node],
    };
    try {
      if (presentation || plainText) validateCanvasInsertion(document);
      change(document);
    } catch (error) {
      notify((error as Error).message, "error");
      return;
    }
    setSelected(node.id);
    selectNodes(new Set([node.id]));
    if (plainText) {
      setSelectedEdge(null);
      setInspecting(true);
    }
  };
  const onNodesChange = (incoming: NodeChange<BoardCanvasNode>[]) => {
    const current = store.current.current;
    if (!current || current.id !== board?.id) return;
    const slideNodes = current.document.nodes.filter(
      (node) => node.slideId === slideId,
    );
    const nodeIds = new Set(slideNodes.map((node) => node.id));
    const changes = incoming.filter(
      (item) =>
        item.type !== "add" && item.type !== "replace" && nodeIds.has(item.id),
    ) as NodeChange<ArtifactFlowNode>[];
    const selectionChanges = changes.filter(
      (c) =>
        c.type === "select" ||
        (c.type === "remove" && store.canRemoveNode(c.id)),
    );
    if (selectionChanges.length) {
      const ids = new Set(selectionRef.current);
      for (const item of selectionChanges) {
        if (item.type === "select" && item.selected) ids.add(item.id);
        else if ("id" in item) ids.delete(item.id);
      }
      selectNodes(ids);
      setSelected((primary) =>
        primary && ids.has(primary) ? primary : ([...ids].at(-1) ?? null),
      );
      if (ids.size) setSelectedEdge(null);
    }
    if (!editable) return;
    let meaningful = changes.filter(
      (c) =>
        c.type !== "select" &&
        !(c.type === "dimensions" && c.resizing === undefined) &&
        "id" in c &&
        store.canEditNode(c.id),
    );
    if (!meaningful.length) return;
    const positions = meaningful.flatMap((item) =>
      item.type === "position" && item.dragging !== undefined ? [item] : [],
    );
    const draggingAcross = positions.some((item) => item.dragging);
    const presentationTarget = registry?.getCanvas("presentation");
    if (
      !presentation &&
      presentationTarget &&
      draggingAcross &&
      !transferDrag.current &&
      !gesture.current &&
      !altPressed.current &&
      !resizing.current &&
      presentationTarget.visible?.() !== false
    )
      transferDrag.current = {
        boardId: current.id,
        cancelled: false,
        viewport: flow.getViewport(),
      };
    const transfer = transferDrag.current;
    if (transfer?.boardId === current.id && positions.length) {
      const finished = positions.some((item) => item.dragging === false);
      const point = pointer.current;
      const transferDrop =
        finished && registry && presentationTarget?.containsPoint(point);
      const outOfPane =
        finished && !registryHandle.current?.containsPoint(point);
      if (finished) {
        transferDrag.current = null;
        setPreviewNodes(null);
        setGuides([]);
        if (transfer.cancelled || transferDrop || outOfPane)
          restoreDragViewport(transfer.viewport);
      }
      if (transfer.cancelled) return;
      const ids = new Set(positions.map((item) => item.id));
      if (transferDrop) {
        const fragment = createBoardFragment(current, workspaceId, ids);
        if (fragment)
          void registry
            .drop(fragment, point)
            .catch((error) => notify(error.message, "error"));
        return;
      }
      if (outOfPane) return;
      let nodes = applyBoardNodeChanges(positions, slideNodes);
      if (!altPressed.current && !snapCancelled.current) {
        const snapped = snapBoardNodes(nodes, ids, flow.getZoom());
        nodes = snapped.nodes;
        if (!finished) setGuides(snapped.guides);
      }
      if (finished) change({ ...current.document, nodes });
      else setPreviewNodes(nodes);
      return;
    }
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
    if (ongoing && !gesture.current) {
      gesture.current = current.document;
      gestureNodes.current.clear();
      gestureEdges.current.clear();
    }
    if (gesture.current)
      for (const item of meaningful)
        if ("id" in item) gestureNodes.current.add(item.id);
    let dragging = meaningful.flatMap((c) =>
      c.type === "position" && c.dragging === true ? [c.id] : [],
    );
    const hasDragMovement = meaningful.some((item) => {
      if (item.type !== "position" || !item.dragging || !item.position)
        return false;
      const node = current.document.nodes.find((node) => node.id === item.id);
      return (
        node &&
        (node.position.x !== item.position.x ||
          node.position.y !== item.position.y)
      );
    });
    let workingDocument = current.document;
    if (
      !movingIds.current &&
      !duplicateDrag.current &&
      !resizing.current &&
      altPressed.current &&
      dragging.length &&
      hasDragMovement
    ) {
      // XYFlow keeps the original drag IDs for the complete gesture. Redirect
      // their position changes to copies rather than replacing original IDs.
      const ids = new Map(dragging.map((id) => [id, crypto.randomUUID()]));
      const copies = current.document.nodes
        .filter((node) => ids.has(node.id))
        .map((node) => ({ ...structuredClone(node), id: ids.get(node.id)! }));
      const edges = current.document.edges
        .filter(
          (edge) =>
            edge.source &&
            edge.target &&
            ids.has(edge.source) &&
            ids.has(edge.target),
        )
        .map((edge) => ({
          ...structuredClone(edge),
          id: crypto.randomUUID(),
          source: ids.get(edge.source!)!,
          target: ids.get(edge.target!)!,
        }));
      for (const id of ids.values()) gestureNodes.current.add(id);
      for (const edge of edges) gestureEdges.current.add(edge.id);
      duplicateDrag.current = {
        boardId: current.id,
        ids,
        edgeIds: new Set(edges.map((edge) => edge.id)),
        cancelled: false,
      };
      workingDocument = {
        ...current.document,
        nodes: [...current.document.nodes, ...copies],
        edges: [...current.document.edges, ...edges],
      };
      try {
        if (presentation) validateCanvasInsertion(workingDocument);
      } catch (error) {
        duplicateDrag.current.cancelled = true;
        gesture.current = null;
        notify((error as Error).message, "error");
        return;
      }
      selectNodes(new Set(ids.values()));
      setSelected([...ids.values()][0] ?? null);
      setSelectedEdge(null);
      setCopyDragging(true);
    }
    const duplication = duplicateDrag.current;
    if (duplication?.boardId === current.id) {
      if (duplication.cancelled) {
        meaningful = meaningful.filter(
          (item) => item.type !== "position" || !duplication.ids.has(item.id),
        );
        gesture.current = null;
        if (completed) duplicateDrag.current = null;
        if (!meaningful.length) return;
      } else {
        meaningful = meaningful.map((item) =>
          item.type === "position" && duplication.ids.has(item.id)
            ? { ...item, id: duplication.ids.get(item.id)! }
            : item,
        );
        dragging = dragging.map((id) => duplication.ids.get(id) ?? id);
      }
    }
    if (dragging.length && (hasDragMovement || movingIds.current)) {
      if (!movingIds.current) snapCancelled.current = false;
      movingIds.current = new Set(dragging);
    }
    let next = applyBoardNodeChanges(meaningful, workingDocument.nodes);
    const activeResize = resizing.current;
    const resizeChanges =
      activeResize?.boardId === current.id &&
      meaningful.some(
        (c) => c.type === "dimensions" && c.id === activeResize.id,
      );
    if (activeResize && resizeChanges && activeResize.moved) {
      const rectangle = activeResize.proportional
        ? preserveResizeAspect(
            activeResize.raw,
            activeResize.start,
            activeResize.sides,
            activeResize.minimum,
          )
        : activeResize.raw;
      // Raw callbacks contain the full rectangle; individual XYFlow changes
      // omit unchanged coordinates and final changes omit setAttributes.
      next = next.map((node) =>
        node.id === activeResize.id
          ? {
              ...node,
              position: { x: rectangle.x, y: rectangle.y },
              width: rectangle.width,
              height: rectangle.height,
            }
          : node,
      );
      if (
        !activeResize.proportional &&
        !altPressed.current &&
        !snapCancelled.current
      ) {
        const snapped = snapResizedNode(
          next.filter((node) => node.slideId === slideId),
          activeResize.id,
          activeResize.sides,
          flow.getZoom(),
          presentation ? slideSnapFrame : undefined,
        );
        const visible = new Map(snapped.nodes.map((node) => [node.id, node]));
        next = next.map((node) => visible.get(node.id) ?? node);
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
      const snapped = snapBoardNodes(
        next.filter((node) => node.slideId === slideId),
        movingIds.current,
        flow.getZoom(),
        presentation ? slideSnapFrame : undefined,
      );
      const visible = new Map(snapped.nodes.map((node) => [node.id, node]));
      next = next.map((node) => visible.get(node.id) ?? node);
      setGuides(completed ? [] : snapped.guides);
    } else if (dragPositions || completed) setGuides([]);
    const removed = new Set(
      meaningful.filter((c) => c.type === "remove").map((c) => c.id),
    );
    const document = {
      ...workingDocument,
      nodes: next,
      edges: workingDocument.edges.filter(
        (e) =>
          (!e.source || !removed.has(e.source)) &&
          (!e.target || !removed.has(e.target)),
      ),
    };
    change(document, !gesture.current, {
      deferDraft: Boolean(gesture.current) && !completed,
    });
    if (completed) flushDraft();
    if (completed && gesture.current) {
      if (JSON.stringify(gesture.current) !== JSON.stringify(document))
        store.recordHistory(gesture.current, {
          nodeIds: [...gestureNodes.current],
          edgeIds: [...gestureEdges.current],
        });
      gesture.current = null;
    }
    if (completed && movingIds.current) movingIds.current = null;
    if (completed && duplicateDrag.current) {
      duplicateDrag.current = null;
      setCopyDragging(false);
    }
    if (completed && resizeChanges) resizing.current = null;
  };
  const alignSelection = (action: AlignmentAction) => {
    const current = store.current.current;
    if (!current || !editable || selectionRef.current.size < 2) return;
    const nodes = alignBoardNodes(
      current.document.nodes,
      new Set([...selectionRef.current].filter((id) => store.canEditNode(id))),
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
      !store.canEditNode(connection.source) ||
      !store.canEditNode(connection.target) ||
      !document.nodes.some(
        (node) => node.id === connection.source && node.slideId === slideId,
      ) ||
      !document.nodes.some(
        (node) => node.id === connection.target && node.slideId === slideId,
      ) ||
      connection.source === connection.target
    )
      return;
    const connected = {
      ...document,
      edges: [
        ...document.edges,
        {
          id: crypto.randomUUID(),
          slideId,
          source: connection.source,
          target: connection.target,
          sourceHandle: boardHandleSide(connection.sourceHandle, "right"),
          targetHandle: boardHandleSide(connection.targetHandle, "left"),
          label: "label" in connection ? connection.label : undefined,
        },
      ],
    };
    try {
      if (presentation) validateCanvasInsertion(connected);
      change(connected);
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };
  const selectedNode = visibleContent?.nodes.find((n) => n.id === selected);
  const canInspectSelected =
    !!selectedNode && (presentation || selectedNode.data.kind !== "note");
  const updateEdge = (
    boardId: string,
    id: string,
    patch: Partial<Pick<BoardEdge, "label" | "appearance">>,
  ) => {
    const current = store.current.current;
    if (
      !editableRef.current ||
      !current ||
      current.id !== boardId ||
      !store.canEditEdge(id)
    )
      return;
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
    if (
      !editableRef.current ||
      !current ||
      current.id !== boardId ||
      !store.canEditEdge(id)
    )
      return;
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
    if (
      !editableRef.current ||
      !current ||
      current.id !== boardId ||
      !store.canEditEdge(id)
    )
      return;
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
          ? `${board?.name ?? canvasName} — копия`
          : presentation
            ? "Новая презентация"
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
      else if (!name.trim()) throw new Error("Введите название.");
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
  const refreshNode = useCallback((id: string) => void refresh(id), [refresh]);
  const openNodeSource = useCallback(
    (id: string) => {
      const node = store.current.current?.document.nodes.find(
        (n) => n.id === id,
      );
      if (node?.data.source) onOpenSource(node.data.source, node.data.title);
    },
    [store.current, onOpenSource],
  );
  const inspectNode = useCallback(
    (id: string) => {
      const node = store.current.current?.document.nodes.find(
        (n) => n.id === id,
      );
      if (!node || (!presentation && node.data.kind === "note")) return;
      setSelected(id);
      selectNodes(new Set([id]));
      setInspecting(true);
    },
    [store.current, presentation],
  );
  const recordMetadata = useCallback(
    (result: ResultSet) =>
      setMetadata((values) =>
        values[result.id] ? values : { ...values, [result.id]: result },
      ),
    [],
  );
  const nodeBusy = useMemo(
    () => ({
      ...busy,
      ...Object.fromEntries(
        pendingRefreshes
          .filter((pending) => pending.boardId === board?.id)
          .map((pending) => [pending.nodeId, true]),
      ),
    }),
    [busy, pendingRefreshes, board?.id],
  );
  const actionContext = useMemo(
    () => ({
      boardId: board?.id ?? "",
      editable,
      presentation,
      slideBackground: slide?.background,
      canEditNode: store.canEditNode,
      canRemoveNode: store.canRemoveNode,
      nodeWork: (id: string) =>
        board ? nodeWork(agentLocks, board.id, id) : undefined,
      resizeStart,
      resize,
      update,
      remove,
      refresh: refreshNode,
      openSource: openNodeSource,
      inspect: inspectNode,
      metadata: recordMetadata,
      busy: nodeBusy,
    }),
    [
      board?.id,
      agentLocks,
      editable,
      presentation,
      slide?.background,
      resizeStart,
      resize,
      update,
      remove,
      refreshNode,
      openNodeSource,
      inspectNode,
      recordMetadata,
      nodeBusy,
    ],
  );
  return (
    <section
      ref={workspaceRef}
      tabIndex={-1}
      onPointerDownCapture={() => {
        suppressDragClick.current = false;
        onActivate?.();
      }}
      onMouseDownCapture={(event) => {
        if (
          event.button !== 0 ||
          !canvasFocusTarget(event.target) ||
          !canvasRef.current?.contains(event.target) ||
          !event.target.closest(
            ".board-node-header,.board-shape-content,.board-text-content,.presentation-artifact,.react-flow__pane,.react-flow__nodesselection-rect",
          )
        )
          return;
        // The drag library can suppress the subsequent click. Prevent the
        // browser's mousedown focus default while leaving the drag listener live.
        event.preventDefault();
        workspaceRef.current?.focus({ preventScroll: true });
      }}
      onClickCapture={(event) => {
        if (
          canvasFocusTarget(event.target) &&
          canvasRef.current?.contains(event.target)
        )
          workspaceRef.current?.focus({ preventScroll: true });
      }}
      onFocusCapture={(event) => {
        if (!workspaceRef.current?.contains(event.target)) return;
        setLocalFocus(true);
        onActivate?.();
      }}
      onBlurCapture={(event) => {
        if (!workspaceRef.current?.contains(event.relatedTarget as Node | null))
          setLocalFocus(false);
      }}
      onCopy={(event) => {
        const current = store.current.current;
        if (
          event.defaultPrevented ||
          !active ||
          !current ||
          nativeBoardClipboardTarget(event.target)
        )
          return;
        try {
          if (
            copyBoardSelection(
              event.clipboardData,
              current,
              workspaceId,
              selectionRef.current,
              slideId,
            )
          )
            event.preventDefault();
        } catch (error) {
          notify((error as Error).message, "error");
        }
      }}
      onPaste={(event) => {
        const current = store.current.current;
        if (
          event.defaultPrevented ||
          !active ||
          !current ||
          !editable ||
          store.loading ||
          store.conflict ||
          gesture.current ||
          transferDrag.current ||
          nativeBoardClipboardTarget(event.target)
        )
          return;
        const fragment = readBoardClipboard(event.clipboardData);
        if (!fragment) return;
        event.preventDefault();
        if (fragment.workspaceId !== workspaceId) {
          notify("Нельзя вставить блоки из другого проекта.", "error");
          return;
        }
        const canvas = workspaceRef.current
          ?.querySelector(".board-canvas")
          ?.getBoundingClientRect();
        if (!canvas) return;
        const center = slideId
          ? { x: PRESENTATION_WIDTH / 2, y: PRESENTATION_HEIGHT / 2 }
          : flow.screenToFlowPosition({
              x: canvas.left + canvas.width / 2,
              y: canvas.top + canvas.height / 2,
            });
        const previous = lastPaste.current;
        const index =
          previous?.copyId === fragment.copyId &&
          previous.boardId === current.id &&
          previous.slideId === slideId
            ? previous.nextIndex
            : 0;
        try {
          const pasted = pasteBoardFragment(fragment, current, center, index, {
            slideId,
          });
          change(pasted.document);
          selectNodes(pasted.ids);
          setSelected([...pasted.ids][0] ?? null);
          setSelectedEdge(null);
          setInspecting(false);
          lastPaste.current = {
            copyId: fragment.copyId,
            boardId: current.id,
            slideId,
            nextIndex: pasted.nextIndex,
          };
          workspaceRef.current?.focus({ preventScroll: true });
        } catch (error) {
          notify((error as Error).message, "error");
        }
      }}
      onKeyDown={(e) => {
        if (
          e.defaultPrevented ||
          e.nativeEvent.isComposing ||
          !active ||
          !workspaceRef.current?.contains(e.target as Node) ||
          (e.target as HTMLElement).closest(
            "input,textarea,[contenteditable=true]",
          )
        )
          return;
        if (
          presentation &&
          editable &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          (e.key === "Backspace" || e.key === "Delete")
        ) {
          if (gesture.current || store.loading || store.conflict) return;
          const ids = [...selectionRef.current].filter((id) =>
            store.canRemoveNode(id),
          );
          if (ids.length) {
            e.preventDefault();
            onNodesChange(ids.map((id) => ({ type: "remove", id })));
          } else if (selectedEdge && board && store.canEditEdge(selectedEdge)) {
            e.preventDefault();
            removeEdge(board.id, selectedEdge);
          }
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) store.redo();
          else store.undo();
        } else if (e.ctrlKey && e.key.toLowerCase() === "y") {
          e.preventDefault();
          store.redo();
        }
      }}
      className={`board-workspace${presentation ? " presentation-workspace" : ""}${hasSelection ? " board-has-selection" : ""}${copyDragging ? " board-copy-dragging" : ""}`}
      aria-label={presentation ? "Презентация" : "Аналитическая доска"}
    >
      <div className="board-header">
        <span className="board-heading">{canvasName}</span>
        <AgentWorkIndicator
          work={board ? boardWork(agentLocks, board.id) : undefined}
          compact
        />
        <Select
          aria-label={presentation ? "Выбрать презентацию" : "Выбрать доску"}
          value={board?.id ?? ""}
          placeholder={presentation ? "Выберите презентацию" : "Выберите доску"}
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
        {slide && (
          <button
            className="board-header-icon presentation-show-button"
            title="Начать показ"
            aria-label="Начать показ"
            disabled={startingShow || store.loading || store.conflict}
            onClick={(event) => void startShow(event.currentTarget)}
          >
            <ProjectorScreen size={18} aria-hidden="true" />
          </button>
        )}
        {editable && (
          <>
            <button
              onClick={() => openDialog("new")}
              title={presentation ? "Создать презентацию" : "Создать доску"}
              aria-label={
                presentation ? "Создать презентацию" : "Создать доску"
              }
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
                    title={
                      presentation
                        ? "Действия с презентацией"
                        : "Действия с доской"
                    }
                    aria-label={
                      presentation
                        ? "Действия с презентацией"
                        : "Действия с доской"
                    }
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
                      disabled={!store.canRename()}
                      onSelect={() =>
                        openDialog("rename", boardMenuTrigger.current)
                      }
                    >
                      <PencilSimple size={16} aria-hidden="true" />
                      {presentation
                        ? "Переименовать презентацию"
                        : "Переименовать доску"}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item
                      className="board-menu-danger"
                      disabled={!store.canDelete()}
                      onSelect={() =>
                        openDialog("delete", boardMenuTrigger.current)
                      }
                    >
                      <Trash size={16} aria-hidden="true" />
                      {presentation ? "Удалить презентацию" : "Удалить доску"}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </>
        )}
      </div>
      {store.parkedDrafts.length > 0 && (
        <div className="board-agent-recovery" role="status">
          <span>
            Агент занял блок с вашим черновиком. Черновик сохранён отдельно;
            остальные блоки доступны.
          </span>
          <button
            onClick={() => {
              const blob = new Blob(
                [JSON.stringify(store.parkedDrafts, null, 2)],
                { type: "application/json" },
              );
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = "board-drafts.json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Скачать черновики
          </button>
          <button
            onClick={() =>
              void store
                .create(
                  `${board?.name || "Доска"} — черновик`,
                  store.parkedDrafts.at(-1)!.document,
                )
                .catch((error) => notify(error.message, "error"))
            }
          >
            Открыть последний как копию
          </button>
        </div>
      )}
      {store.conflict && (
        <div className="board-conflict" role="alert">
          <span>
            {presentation
              ? "Презентация изменена в другой вкладке."
              : "Доска изменена в другой вкладке."}{" "}
            Ваш черновик сохранён локально.
          </span>
          <button onClick={() => openDialog("copy")}>Сохранить копию</button>
          <button onClick={() => void store.reload()}>
            Загрузить серверную
          </button>
        </div>
      )}
      {board && (
        <div className="board-tools">
          <ShapePicker disabled={!editable} onSelect={addShape} />
          <button
            disabled={!editable}
            onClick={() => addText("text")}
            title="Добавить текст"
            aria-label="Добавить текст"
            className="board-tools-icon"
          >
            <TextT size={18} aria-hidden="true" />
          </button>
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
          {slide && (
            <button
              className="board-tools-icon"
              aria-label="Вписать слайд"
              title="Вписать слайд в окно"
              onClick={fitSlide}
            >
              <CornersOut size={17} aria-hidden="true" />
            </button>
          )}
          {!presentation && registry && (
            <button
              className="board-tools-icon"
              aria-label="Добавить в презентацию"
              title="Добавить в презентацию"
              disabled={!selectedIds.size}
              onClick={() => {
                const current = store.current.current;
                const fragment =
                  current &&
                  createBoardFragment(
                    current,
                    workspaceId,
                    selectionRef.current,
                  );
                if (fragment) registry.transfer(fragment);
              }}
            >
              <PresentationChart size={18} aria-hidden="true" />
            </button>
          )}
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
            disabled={!canInspectSelected}
            onClick={() => setInspecting((value) => !value)}
            className="board-tools-icon"
            aria-label="Свойства"
            aria-pressed={inspecting && canInspectSelected}
            title="Свойства выбранного блока"
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
          </button>
          {editable &&
            selectedNode?.data.kind === "result" &&
            store.canEditNode(selectedNode.id) && (
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
      {pendingRefreshes.some(
        (pending) =>
          pending.boardId === board?.id &&
          (refreshRuns[pending.runId]?.status === "paused" ||
            refreshErrors[pending.runId]),
      ) && (
        <div
          className="board-refresh-notices"
          aria-label="Приостановленные обновления доски"
        >
          {pendingRefreshes
            .filter(
              (pending) =>
                pending.boardId === board?.id &&
                (refreshRuns[pending.runId]?.status === "paused" ||
                  refreshErrors[pending.runId]),
            )
            .map((pending) => (
              <section
                key={pending.runId}
                aria-label={`Обновление: ${pending.title}`}
              >
                <strong>{pending.title}</strong>
                {refreshRuns[pending.runId]?.status === "paused" ? (
                  <DateBatchProgress
                    run={refreshRuns[pending.runId]}
                    onResume={() => void resolveRefresh(pending, "resume")}
                    onCancel={() => void resolveRefresh(pending, "cancel")}
                    action={refreshActions[pending.runId]}
                    actionError={refreshErrors[pending.runId]}
                  />
                ) : (
                  <>
                    <p role="alert">{refreshErrors[pending.runId]}</p>
                    <button onClick={() => void trackRefresh(pending)}>
                      Проверить состояние
                    </button>
                  </>
                )}
              </section>
            ))}
        </div>
      )}
      <div className="board-body">
        {board && slide && (
          <PresentationSlides
            key={board.id}
            boardId={board.id}
            document={board.document}
            selected={slide}
            structureEditable={
              editable && !store.conflict && !boardWork(agentLocks, board.id)
            }
            metadataEditable={
              editable &&
              !store.conflict &&
              !slideWork(agentLocks, board.id, slide.id)
            }
            deletionEditable={
              editable &&
              !store.conflict &&
              !slideDeletionWork(agentLocks, board.id, slide.id, board.document)
            }
            work={slideWork(agentLocks, board.id, slide.id)}
            onSelect={selectSlide}
            onAdd={() => createSlide()}
            onDuplicate={() => createSlide(true)}
            onUpdate={updateSlide}
            onRemove={deleteSlide}
            onReorder={reorderSlide}
          />
        )}
        <div
          ref={canvasRef}
          className="board-canvas"
          onDragOver={(e) => {
            if (
              editable &&
              (!registry || store.ready) &&
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
              const point = flow.screenToFlowPosition({
                x: e.clientX,
                y: e.clientY,
              });
              if (registry && !store.ready)
                throw new Error("Дождитесь загрузки документа.");
              const insertion = registry
                ? insertCanvasResult(
                    result,
                    registryHandle.current!.destination(),
                    point,
                  )
                : addResult(result, point);
              void insertion.catch((error) => notify(error.message, "error"));
            } catch (error) {
              notify((error as Error).message, "error");
            }
          }}
        >
          {board ? (
            <BoardActions.Provider value={actionContext}>
              <BoardFlow
                id={flowId}
                gestureScope={`${workspaceId}:${cameraId}`}
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
                      gestureScope: `${workspaceId}:${cameraId}`,
                      editable: store.canEditEdge(e.id),
                      work: edgeWork(
                        agentLocks,
                        board.id,
                        e.id,
                        board.document,
                      ),
                      editing: editingEdge === e.id,
                      onSelect: () => {
                        setSelectedEdge(e.id);
                        setSelected(null);
                        selectNodes(new Set());
                        setInspecting(false);
                      },
                      onEdit: () => {
                        if (!editable || !store.canEditEdge(e.id)) return;
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
                  // Marquee selection also reports links between selected nodes.
                  // Keep that node group; an explicit edge click selects it below.
                  if (
                    selection?.type === "select" &&
                    !selectionRef.current.size
                  ) {
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
                              item.type === "remove" &&
                              item.id === edge.id &&
                              store.canEditEdge(edge.id),
                          ),
                      ),
                    });
                }}
                onConnect={connect}
                connectionMode={ConnectionMode.Loose}
                isValidConnection={(connection) =>
                  connection.source !== connection.target &&
                  store.canEditNode(connection.source) &&
                  store.canEditNode(connection.target)
                }
                onNodeClick={(event, node) => {
                  if (node.type !== "artifact") return;
                  if (selectionRef.current.has(node.id)) setSelected(node.id);
                  setSelectedEdge(null);
                  if (
                    presentation ||
                    node.data.kind === "shape" ||
                    node.data.kind === "text"
                  ) {
                    if (!presentation && !canvasFocusTarget(event.target))
                      return;
                    // Some pointer adapters emit a click after drag-end. Keep
                    // the drag selection without opening editing for that click.
                    if (suppressDragClick.current) {
                      suppressDragClick.current = false;
                      return;
                    }
                    if (event.shiftKey || event.metaKey || event.ctrlKey) {
                      setInspecting(false);
                      return;
                    }
                    workspaceRef.current?.focus({ preventScroll: true });
                    inspectNode(node.id);
                  }
                }}
                onNodeDragStart={(event) => {
                  suppressDragClick.current = true;
                  if (canvasFocusTarget(event.target))
                    workspaceRef.current?.focus({ preventScroll: true });
                  duplicateDrag.current = null;
                  movingIds.current = null;
                  snapCancelled.current = false;
                }}
                onSelectionDragStart={() => {
                  suppressDragClick.current = true;
                  duplicateDrag.current = null;
                  movingIds.current = null;
                  snapCancelled.current = false;
                }}
                onNodeDragStop={() => {
                  transferDrag.current = null;
                  setPreviewNodes(null);
                  movingIds.current = null;
                  duplicateDrag.current = null;
                  setCopyDragging(false);
                  setGuides([]);
                }}
                onSelectionDragStop={() => {
                  transferDrag.current = null;
                  setPreviewNodes(null);
                  movingIds.current = null;
                  duplicateDrag.current = null;
                  setCopyDragging(false);
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
                  if (
                    cameraId &&
                    store.current.current?.id === board.id &&
                    slideId === slideRef.current
                  )
                    saveBoardViewport(workspaceId, cameraId, viewport);
                }}
                nodesDraggable={editable}
                autoPanOnNodeDrag={!transferDrag.current}
                nodesConnectable={editable}
                elementsSelectable
                selectionOnDrag
                selectionKeyCode={null}
                multiSelectionKeyCode={
                  active ? ["Shift", "Meta", "Control"] : null
                }
                panActivationKeyCode={active ? undefined : null}
                zoomActivationKeyCode={active ? undefined : null}
                panOnDrag={[1, 2]}
                panOnScroll
                zoomOnDoubleClick={false}
                deleteKeyCode={
                  !presentation &&
                  editable &&
                  active &&
                  (!registry || localFocus)
                    ? ["Backspace", "Delete"]
                    : null
                }
                minZoom={presentation ? 0.01 : 0.15}
                maxZoom={2}
                defaultViewport={initialViewport}
                proOptions={{ hideAttribution: true }}
              >
                {slide && (
                  <ViewportPortal>
                    <div
                      className="presentation-slide-background"
                      aria-hidden="true"
                      style={{
                        width: PRESENTATION_WIDTH,
                        height: PRESENTATION_HEIGHT,
                        background: slide.background,
                      }}
                    />
                  </ViewportPortal>
                )}
                <AlignmentGuides guides={guides} />
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={24}
                  size={1}
                  color="var(--board-border)"
                />
                <Controls
                  showInteractive={false}
                  showFitView={!slide}
                  fitViewOptions={boardFitOptions}
                />
                {!presentation && (
                  <MiniMap
                    style={{ width: 120, height: 75 }}
                    pannable
                    zoomable
                    nodeColor="var(--board-border)"
                    maskColor="color-mix(in srgb, var(--board-bg) 72%, transparent)"
                  />
                )}
                {!presentation &&
                  !board.document.nodes.length &&
                  !board.document.edges.length && (
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
                {store.loading
                  ? presentation
                    ? "Загрузка презентаций…"
                    : "Загрузка досок…"
                  : presentation
                    ? "Презентации"
                    : "Аналитическая доска"}
              </strong>
              <span>
                {presentation
                  ? "Создайте презентацию и добавьте блоки с доски или результаты SQL."
                  : editable
                    ? "Создайте доску и добавьте результат SQL-запроса."
                    : "В рабочем пространстве пока нет досок."}
              </span>
              {editable && !store.loading && (
                <button onClick={() => openDialog("new")}>
                  {presentation ? "Создать презентацию" : "Создать доску"}
                </button>
              )}
            </div>
          )}
          {editable && selectedIds.size >= 2 && (
            <AlignmentToolbar
              count={selectedIds.size}
              onAlign={alignSelection}
            />
          )}
          {selectedNode && canInspectSelected && inspecting && board && (
            <Inspector
              boardId={board.id}
              node={selectedNode}
              presentation={presentation}
              autoFocus={!presentation}
              refresh={() => actionContext.refresh(selectedNode.id)}
              refreshing={Boolean(nodeBusy[selectedNode.id])}
              result={
                selectedNode.data.resultSetId
                  ? metadata[selectedNode.data.resultSetId]
                  : undefined
              }
              editable={editable && store.canEditNode(selectedNode.id)}
              close={() => setInspecting(false)}
              change={(node) => {
                const current = store.current.current;
                if (
                  !current ||
                  current.id !== board.id ||
                  !store.canEditNode(node.id)
                )
                  return;
                change({
                  ...current.document,
                  nodes: current.document.nodes.map((n) =>
                    n.id === node.id ? node : n,
                  ),
                });
              }}
              openSource={() => actionContext.openSource(selectedNode.id)}
            />
          )}
        </div>
      </div>
      {show && store.persisted?.id === show.boardId && (
        <PresentationShow
          board={store.persisted}
          initialSlideId={show.slideId}
          onClose={closeShow}
          trigger={show.trigger}
        />
      )}
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
                ? presentation
                  ? "Удалить презентацию?"
                  : "Удалить доску?"
                : dialog === "rename"
                  ? presentation
                    ? "Название презентации"
                    : "Название доски"
                  : dialog === "copy"
                    ? "Копия вашего черновика"
                    : presentation
                      ? "Новая презентация"
                      : "Новая доска"}
            </Dialog.Title>
            <Dialog.Description>
              {dialog === "delete"
                ? `${canvasName} «${board?.name}» будет удалена.`
                : dialog === "copy"
                  ? "Копия сохранит ваши блоки и закреплённые снимки."
                  : `${canvasName} сохранится в вашей рабочей области.`}
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
                      ? presentation
                        ? "Не удалось удалить презентацию."
                        : "Не удалось удалить доску."
                      : dialog === "rename"
                        ? presentation
                          ? "Не удалось переименовать презентацию."
                          : "Не удалось переименовать доску."
                        : dialog === "copy"
                          ? "Не удалось сохранить копию."
                          : presentation
                            ? "Не удалось создать презентацию."
                            : "Не удалось создать доску."
                  }
                  hint={
                    dialogError.message === "Введите название."
                      ? "Введите название и сохраните документ."
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
                  if (
                    selectedNode &&
                    board &&
                    rebind &&
                    store.canEditNode(selectedNode.id)
                  )
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
      <Workspace
        key={`${props.workspaceId}:${props.kind ?? "board"}`}
        {...props}
      />
    </ReactFlowProvider>
  );
}
