import {
  createContext,
  memo,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type CSSProperties,
} from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useStore,
  useUpdateNodeInternals,
  type ReactFlowState,
  type OnResizeStart,
  type OnResize,
  type OnResizeEnd,
  type ResizeParams,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import {
  ArrowClockwise,
  ChartLine,
  Code,
  FileMd,
  SlidersHorizontal,
  Table,
  Trash,
} from "@phosphor-icons/react";
import type { BoardNodeData, ResultSet } from "../../shared/types";
import ResultView from "./ResultView";
import type { AgentEntityWork } from "../../shared/agent-work";
import { AgentWorkIndicator } from "../agents/AgentWorkIndicator";
import MarkdownEditor from "./MarkdownEditor";
import StickyNoteEditor from "./StickyNoteEditor";
import ShapeContent from "./ShapeContent";
import TextBlockContent from "./TextBlockContent";
import { boardHandleOptions } from "./connection-sides";
import type { ResizeSides } from "./resize-snapping";
import { presentationColors } from "./presentation-colors";
const handlePositions = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};
export type ArtifactFlowNode = Node<BoardNodeData, "artifact"> & {
  slideId?: string;
};
export const BoardActions = createContext<{
  boardId: string;
  editable: boolean;
  presentation?: boolean;
  slideBackground?: string;
  reportChartStatus?: boolean;
  canEditNode?: (id: string) => boolean;
  canRemoveNode?: (id: string) => boolean;
  nodeWork?: (id: string) => AgentEntityWork | undefined;
  update: (id: string, patch: Partial<BoardNodeData>) => void;
  remove: (id: string) => void;
  refresh: (id: string) => void;
  openSource: (id: string) => void;
  inspect: (id: string) => void;
  metadata: (result: ResultSet) => void;
  resizeStart: (id: string, sides: ResizeSides, raw: ResizeParams) => void;
  resize: (id: string, raw: ResizeParams, moved: boolean) => void;
  busy: Record<string, boolean>;
}>({
  boardId: "",
  editable: false,
  update: () => {},
  remove: () => {},
  refresh: () => {},
  openSource: () => {},
  inspect: () => {},
  metadata: () => {},
  resizeStart: () => {},
  resize: () => {},
  busy: {},
});
const selectZoom = (state: ReactFlowState) => state.transform[2];

function ArtifactNode({ id, data, selected }: NodeProps<ArtifactFlowNode>) {
  const actions = useContext(BoardActions);
  const editable = actions.editable && (actions.canEditNode?.(id) ?? true);
  const presentation = actions.presentation === true;
  const freeform = data.kind === "shape" || data.kind === "text";
  const inlineEditable = editable && !presentation;
  const colors = presentation
    ? presentationColors(actions.slideBackground ?? "#ffffff")
    : undefined;
  const work = actions.nodeWork?.(id);
  const zoom = useStore(selectZoom);
  const content = useRef<HTMLDivElement>(null);
  const updateNodeInternals = useUpdateNodeInternals();
  const shapeType = data.kind === "shape" ? data.shape?.type : undefined;
  const previousShapeType = useRef(shapeType);
  useLayoutEffect(() => {
    // A type switch can move anchors without changing the node's dimensions.
    if (previousShapeType.current !== shapeType) updateNodeInternals(id);
    previousShapeType.current = shapeType;
  }, [id, shapeType, updateNodeInternals]);
  useLayoutEffect(() => {
    const element = content.current;
    if (!presentation || !element) return;
    // Keep slide contents in the accessibility tree while the canvas owns
    // keyboard interaction. Snapshot tables/charts may mount asynchronously.
    const preventTabStops = () => {
      for (const control of element.querySelectorAll<HTMLElement>(
        "a[href],button,input,select,textarea,iframe,[tabindex],[contenteditable]",
      ))
        control.tabIndex = -1;
    };
    preventTabStops();
    const observer = new MutationObserver(preventTabStops);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [presentation]);
  // Keep these handlers stable: XYFlow installs its raw resize calculation in
  // an effect keyed by the callback identities, including during the gesture.
  const resizeStart = useCallback<OnResizeStart>(
    (event, raw) => {
      const target = event.sourceEvent.target;
      const control =
        target instanceof Element
          ? target.closest(".react-flow__resize-control")
          : null;
      if (!control) return;
      actions.resizeStart(
        id,
        {
          left: control.classList.contains("left"),
          right: control.classList.contains("right"),
          top: control.classList.contains("top"),
          bottom: control.classList.contains("bottom"),
        },
        raw,
      );
    },
    [id, actions.resizeStart],
  );
  const resize = useCallback<OnResize>(
    (_, raw) => actions.resize(id, raw, true),
    [id, actions.resize],
  );
  const resizeEnd = useCallback<OnResizeEnd>(
    (_, raw) => actions.resize(id, raw, false),
    [id, actions.resize],
  );
  return (
    <article
      className={`board-artifact board-artifact-${data.kind}${presentation ? " presentation-artifact" : ""}${selected ? " board-artifact-selected" : ""}${work ? " agent-work-active" : ""}`}
      aria-label={data.title}
      style={
        {
          "--board-resize-unit": `${1 / zoom}px`,
          ...(colors && {
            "--board-text": colors.text,
            "--board-muted": colors.muted,
            "--board-border": colors.grid,
            "--board-border-subtle": colors.grid,
            "--board-raised": colors.raised,
            "--board-accent": colors.accent,
          }),
        } as CSSProperties
      }
    >
      <NodeResizer
        minWidth={freeform ? 40 : data.kind === "markdown" ? 240 : 280}
        minHeight={freeform ? 40 : data.kind === "markdown" ? 140 : 180}
        isVisible={selected && editable}
        lineClassName="board-resize-line"
        handleClassName="board-resize-handle"
        autoScale={false}
        onResizeStart={resizeStart}
        onResize={resize}
        onResizeEnd={resizeEnd}
      />
      {boardHandleOptions.map(({ value, label }) => (
        <Handle
          key={value}
          id={value}
          type="source"
          position={handlePositions[value]}
          style={
            shapeType === "triangle" && value === "left"
              ? { left: "25%" }
              : shapeType === "triangle" && value === "right"
                ? { right: "25%" }
                : shapeType === "arrow" &&
                    (value === "top" || value === "bottom")
                  ? { left: "62%" }
                  : undefined
          }
          isConnectable={editable}
          title={`Соединить ${label.toLowerCase()}`}
          aria-label={`Соединить ${label.toLowerCase()}: ${data.title}`}
        />
      ))}
      {!presentation && !freeform && (
        <header className="board-node-header">
          <AgentWorkIndicator work={work} compact />
          {data.kind !== "note" && (
            <>
              <span className="board-node-kind" aria-hidden="true">
                {data.kind === "markdown" ? (
                  <FileMd size={16} />
                ) : data.view === "chart" || data.view === "custom" ? (
                  <ChartLine size={16} />
                ) : (
                  <Table size={16} />
                )}
              </span>
              <strong title={data.title}>{data.title}</strong>
            </>
          )}
          <span className="board-node-toolbar nodrag nopan">
            {data.kind !== "note" && (
              <button
                title="Свойства блока"
                aria-label={`Свойства: ${data.title}`}
                onClick={() => actions.inspect(id)}
              >
                <SlidersHorizontal size={16} aria-hidden="true" />
              </button>
            )}
            {data.source && (
              <button
                title="Открыть закреплённый SQL"
                aria-label="Открыть исходный SQL"
                onClick={() => actions.openSource(id)}
              >
                <Code size={16} aria-hidden="true" />
              </button>
            )}
            {editable && data.kind === "result" && (
              <button
                title="Обновить по закреплённому SQL"
                disabled={actions.busy[id]}
                aria-label={
                  actions.busy[id] ? "Обновление снимка" : "Обновить снимок"
                }
                aria-busy={actions.busy[id] || undefined}
                onClick={() => actions.refresh(id)}
              >
                <ArrowClockwise
                  size={15}
                  className={actions.busy[id] ? "board-refreshing" : undefined}
                  aria-hidden="true"
                />
              </button>
            )}
            {editable && (
              <button
                disabled={!(actions.canRemoveNode?.(id) ?? true)}
                title="Удалить блок"
                aria-label="Удалить блок"
                onClick={() => actions.remove(id)}
              >
                <Trash size={16} aria-hidden="true" />
              </button>
            )}
          </span>
        </header>
      )}
      <div
        ref={content}
        className={`board-node-body${presentation ? " presentation-node-content" : freeform ? "" : " nodrag nopan"}${freeform || (data.kind === "result" && data.view === "chart") ? "" : " nowheel"}`}
      >
        {data.kind === "result" && data.resultSetId && (
          <ResultView
            boardId={actions.boardId}
            nodeId={id}
            id={data.resultSetId}
            view={data.view ?? "table"}
            chart={data.chart}
            customChart={data.customChart}
            visibleColumns={data.visibleColumns}
            table={data.table}
            onMetadata={actions.metadata}
            reportChartStatus={actions.reportChartStatus}
            presentationBackground={
              presentation ? (actions.slideBackground ?? "#ffffff") : undefined
            }
            onTableChange={
              inlineEditable
                ? (table) => actions.update(id, { table })
                : undefined
            }
          />
        )}
        {data.kind === "note" && (
          <StickyNoteEditor
            value={data.text ?? ""}
            readOnly={!inlineEditable}
            onChange={(text) => actions.update(id, { text })}
          />
        )}
        {data.kind === "shape" && (
          <ShapeContent
            key={`${actions.boardId}:${id}`}
            text={data.text ?? ""}
            shape={data.shape}
            editable={inlineEditable}
            onChange={(text) => actions.update(id, { text })}
          />
        )}
        {data.kind === "text" && (
          <TextBlockContent
            key={`${actions.boardId}:${id}`}
            text={data.text ?? ""}
            textStyle={data.textStyle}
            editable={inlineEditable}
            onChange={(text) => actions.update(id, { text })}
          />
        )}
        {data.kind === "markdown" && (
          <MarkdownEditor
            key={`${actions.boardId}:${id}`}
            value={data.text ?? ""}
            readOnly={!inlineEditable}
            onChange={(text) => actions.update(id, { text })}
          />
        )}
      </div>
    </article>
  );
}

// Position, drag flags and measured dimensions belong to XYFlow's wrapper.
// The card consumes only these props; resizer/zoom subscriptions remain live.
export default memo(
  ArtifactNode,
  (previous, next) =>
    previous.id === next.id &&
    previous.data === next.data &&
    previous.selected === next.selected,
);
