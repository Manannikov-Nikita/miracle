import {
  createContext,
  useCallback,
  useContext,
  type CSSProperties,
} from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useViewport,
  type OnResizeStart,
  type OnResize,
  type OnResizeEnd,
  type ResizeParams,
  type NodeProps,
  type Node,
} from "@xyflow/react";
import type { BoardNodeData, ResultSet } from "../../shared/types";
import ResultView from "./ResultView";
import MarkdownEditor from "./MarkdownEditor";
import { boardHandleOptions } from "./connection-sides";
import type { ResizeSides } from "./resize-snapping";
const handlePositions = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};
export type ArtifactFlowNode = Node<BoardNodeData, "artifact">;
export const BoardActions = createContext<{
  boardId: string;
  editable: boolean;
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
export default function ArtifactNode({
  id,
  data,
  selected,
}: NodeProps<ArtifactFlowNode>) {
  const actions = useContext(BoardActions);
  const { zoom } = useViewport();
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
      className={`board-artifact board-artifact-${data.kind}${selected ? " board-artifact-selected" : ""}`}
      aria-label={data.title}
      style={{ "--board-resize-unit": `${1 / zoom}px` } as CSSProperties}
    >
      <NodeResizer
        minWidth={data.kind === "markdown" ? 240 : 280}
        minHeight={data.kind === "markdown" ? 140 : 180}
        isVisible={selected && actions.editable}
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
          isConnectable={actions.editable}
          title={`Соединить ${label.toLowerCase()}`}
          aria-label={`Соединить ${label.toLowerCase()}: ${data.title}`}
        />
      ))}
      <header className="board-node-header">
        <span className="board-node-kind" aria-hidden="true">
          {data.kind === "result" ? "▤" : data.kind === "markdown" ? "M↓" : "▧"}
        </span>
        <strong title={data.title}>{data.title}</strong>
        <span className="board-node-toolbar nodrag nopan">
          <button
            title="Свойства блока"
            aria-label={`Свойства: ${data.title}`}
            onClick={() => actions.inspect(id)}
          >
            ⋯
          </button>
          {data.source && (
            <button
              title="Открыть закреплённый SQL"
              aria-label="Открыть исходный SQL"
              onClick={() => actions.openSource(id)}
            >
              SQL
            </button>
          )}
          {actions.editable && data.kind === "result" && (
            <button
              title="Обновить по закреплённому SQL"
              disabled={actions.busy[id]}
              aria-label="Обновить снимок"
              onClick={() => actions.refresh(id)}
            >
              {actions.busy[id] ? "…" : "↻"}
            </button>
          )}
          {actions.editable && (
            <button
              title="Удалить блок"
              aria-label="Удалить блок"
              onClick={() => actions.remove(id)}
            >
              ×
            </button>
          )}
        </span>
      </header>
      <div className="board-node-body nodrag nopan nowheel">
        {data.kind === "result" && data.resultSetId && (
          <ResultView
            id={data.resultSetId}
            view={data.view ?? "table"}
            chart={data.chart}
            visibleColumns={data.visibleColumns}
            table={data.table}
            onTableChange={
              actions.editable
                ? (table) => actions.update(id, { table })
                : undefined
            }
            onMetadata={actions.metadata}
          />
        )}
        {data.kind === "note" && (
          <textarea
            maxLength={200000}
            aria-label="Текст заметки"
            value={data.text ?? ""}
            readOnly={!actions.editable}
            onChange={(e) => actions.update(id, { text: e.target.value })}
            placeholder="Запишите наблюдение…"
            className="board-note-text"
          />
        )}
        {data.kind === "markdown" && (
          <MarkdownEditor
            key={`${actions.boardId}:${id}`}
            value={data.text ?? ""}
            readOnly={!actions.editable}
            onChange={(text) => actions.update(id, { text })}
          />
        )}
      </div>
    </article>
  );
}
