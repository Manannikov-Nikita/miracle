import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  useViewport,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type { BoardEdge } from "../../shared/types";
import BoardEdgeToolbar from "./BoardEdgeToolbar";
import { edgeAppearance, edgeBendPoint, edgeGeometry } from "./edge-appearance";
import {
  canonicalEdgeGeometry,
  pointAlongPath,
  type BoardEdgeGeometryPatch,
} from "./edge-geometry";
import useEdgeGestures from "./useEdgeGestures";
import "./board-edge.css";

export type { BoardEdgeGeometryPatch } from "./edge-geometry";

export type BoardEdgeViewData = {
  edge: BoardEdge;
  editable: boolean;
  editing: boolean;
  gestureScope?: string;
  onEdit: () => void;
  onFinishEdit: () => void;
  onChange: (patch: Partial<Pick<BoardEdge, "label" | "appearance">>) => void;
  onGeometryChange: (
    patch: BoardEdgeGeometryPatch,
    expected?: BoardEdge,
  ) => void;
  onSelect?: () => void;
  onDelete: () => void;
  onClose: () => void;
};
export type BoardFlowEdge = Edge<BoardEdgeViewData, "board">;

function EdgeCaption({
  data,
  x,
  y,
  zoom,
  onKeyboardFinish,
  gestures,
  labelRef,
}: {
  data: BoardEdgeViewData;
  x: number;
  y: number;
  zoom: number;
  onKeyboardFinish: () => void;
  gestures: ReturnType<typeof useEdgeGestures>;
  labelRef: { current: HTMLElement | null };
}) {
  const label = data.edge.label ?? "";
  const [draft, setDraft] = useState(label);
  const input = useRef<HTMLInputElement>(null);
  const completed = useRef(false);
  const previousLabel = useRef(label);
  useEffect(() => {
    // A remote label wins over an unfinished local draft. Merely reading the
    // new version must never turn into a write of the previous version.
    const remoteChanged = previousLabel.current !== label;
    previousLabel.current = label;
    setDraft(label);
    completed.current = false;
    if (data.editing && data.editable && !remoteChanged) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [data.edge.id, data.editing, label, data.editable]);
  const finish = (save: boolean) => {
    if (completed.current || !data.editing || !data.editable) return;
    completed.current = true;
    if (save && draft !== label) data.onChange({ label: draft });
    data.onFinishEdit();
  };
  const position: CSSProperties = { left: x, top: y };
  if (data.editing && data.editable)
    return (
      <input
        ref={input}
        className="board-edge-input nodrag nopan nowheel nokey"
        aria-label="Подпись стрелки"
        placeholder="Подпись"
        maxLength={500}
        value={draft}
        style={{
          ...position,
          width: `${Math.min(320, Math.max(140, draft.length * 7 + 24))}px`,
          transform: `translate(-50%, -50%) scale(${1 / zoom})`,
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            finish(event.key === "Enter");
            onKeyboardFinish();
          }
        }}
      />
    );
  if (!label) return null;
  return data.editable ? (
    <button
      ref={(element) => {
        labelRef.current = element;
      }}
      type="button"
      className="board-edge-label nodrag nopan nokey"
      style={position}
      title="Перетащите подпись вдоль стрелки · нажмите для редактирования"
      onPointerDown={(event) => gestures.begin("label", event)}
      onKeyDown={(event) => gestures.keyboard("label", event)}
      onClick={(event) => {
        event.stopPropagation();
        if (gestures.consumeClick()) return;
        data.onEdit();
      }}
    >
      {label}
    </button>
  ) : (
    <span
      ref={(element) => {
        labelRef.current = element;
      }}
      className="board-edge-label"
      style={position}
    >
      {label}
    </span>
  );
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(value, Math.max(min, max)));

export default function BoardEdgeView(props: EdgeProps<BoardFlowEdge>) {
  const data = props.data;
  const markerId = `board-edge-arrow-${useId().replaceAll(":", "")}`;
  const viewport = useViewport();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const toolbar = useRef<HTMLDivElement>(null);
  const edgeGroup = useRef<SVGGElement>(null);
  const labelRef = useRef<HTMLElement | null>(null);
  const [labelHeight, setLabelHeight] = useState(18);
  const [toolbarHeight, setToolbarHeight] = useState(42);
  const canonical = canonicalEdgeGeometry(props, data?.edge);
  const measuredPath = () =>
    edgeGroup.current?.querySelector<SVGPathElement>(".react-flow__edge-path");
  const gestures = useEdgeGestures({
    edge: data?.edge,
    scope: data?.gestureScope,
    geometry: canonical,
    zoom: viewport.zoom,
    enabled: !!data?.editable && !data.editing,
    path: measuredPath,
    bendPoint: edgeBendPoint(canonical, data?.edge.appearance, data?.edge.bend),
    onCommit: data?.onGeometryChange,
    onSelect: data?.onSelect,
  });
  const geometry = gestures.preview?.geometry ?? canonical;
  const renderedAppearance = {
    ...data?.edge.appearance,
    path: gestures.preview?.path ?? data?.edge.appearance?.path,
  };
  const renderedBend = gestures.preview?.bend ?? data?.edge.bend;
  const bendPoint = edgeBendPoint(geometry, renderedAppearance, renderedBend);
  const gripOffset = data?.edge.label
    ? labelHeight / 2 + 20 / viewport.zoom
    : 0;
  const bendGrip = { x: bendPoint.x, y: bendPoint.y + gripOffset };
  const labelPosition =
    gestures.preview?.labelPosition ?? data?.edge.labelPosition ?? 0.5;
  const [path, fallbackX, fallbackY] = edgeGeometry(
    geometry,
    renderedAppearance,
    renderedBend,
  );
  const [labelPoint, setLabelPoint] = useState<{
    path: string;
    position: number;
    x: number;
    y: number;
  }>();
  useLayoutEffect(() => {
    const point = pointAlongPath(measuredPath(), labelPosition);
    if (point) setLabelPoint({ path, position: labelPosition, ...point });
  }, [path, labelPosition]);
  useLayoutEffect(() => {
    const height = labelRef.current?.offsetHeight;
    if (height) setLabelHeight(height);
  }, [data?.edge.label, data?.editing, path, viewport.zoom]);
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const measure = () => {
      if (element.offsetHeight) setToolbarHeight(element.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.selected, data?.editable, width]);
  if (!data) return null;
  const appearance = edgeAppearance(data.edge.appearance);
  const measured =
    labelPoint?.path === path && labelPoint.position === labelPosition;
  const x = measured ? labelPoint.x : fallbackX;
  const y = measured ? labelPoint.y : fallbackY;
  const centerX = x * viewport.zoom + viewport.x;
  const centerY = y * viewport.zoom + viewport.y;
  const toolbarWidth = Math.min(304, Math.max(168, width - 24));
  const toolbarX = clamp(
    centerX - toolbarWidth / 2,
    12,
    width - toolbarWidth - 12,
  );
  const toolbarY = clamp(
    centerY >= toolbarHeight + 36 ? centerY - toolbarHeight - 24 : centerY + 24,
    12,
    height - toolbarHeight - 12,
  );
  return (
    <>
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 8 8"
          markerWidth={8 + appearance.width * 2}
          markerHeight={8 + appearance.width * 2}
          refX="8"
          refY="4"
          orient="auto-start-reverse"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0 0L8 4L0 8Z" fill={appearance.color} />
        </marker>
      </defs>
      <g
        ref={edgeGroup}
        className={
          data.editable && !data.editing
            ? "board-edge-draggable nodrag nopan"
            : undefined
        }
        onPointerDown={(event) => gestures.begin("line", event)}
        onClickCapture={(event) => {
          if (gestures.consumeClick()) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onDoubleClick={(event) => {
          if (data.editable) {
            event.stopPropagation();
            data.onEdit();
          }
        }}
      >
        {props.selected && data.editable && !data.editing && gripOffset > 0 && (
          <line
            x1={bendPoint.x}
            y1={bendPoint.y}
            x2={bendGrip.x}
            y2={bendGrip.y}
            stroke="var(--board-accent)"
            strokeDasharray="2 3"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            opacity={0.6}
            pointerEvents="none"
          />
        )}
        {props.selected && (
          <path
            d={path}
            fill="none"
            stroke="var(--board-accent)"
            strokeWidth={appearance.width + 5}
            opacity={0.22}
            pointerEvents="none"
          />
        )}
        <BaseEdge
          id={props.id}
          path={path}
          interactionWidth={20}
          markerStart={appearance.startArrow ? `url(#${markerId})` : undefined}
          markerEnd={appearance.endArrow ? `url(#${markerId})` : undefined}
          style={{
            stroke: appearance.color,
            strokeWidth: appearance.width,
            strokeDasharray: appearance.dash,
            strokeLinecap: "round",
          }}
        />
      </g>
      <EdgeLabelRenderer>
        <EdgeCaption
          data={data}
          x={x}
          y={y}
          zoom={viewport.zoom}
          gestures={gestures}
          labelRef={labelRef}
          onKeyboardFinish={() => {
            const target =
              toolbar.current?.querySelector<HTMLButtonElement>(
                'button[aria-label="Изменить подпись стрелки"]',
              ) ??
              edgeGroup.current?.closest<SVGGraphicsElement>(
                ".react-flow__edge",
              );
            target?.focus({ preventScroll: true });
          }}
        />
        {props.selected && data.editable && !data.editing && (
          <button
            type="button"
            className="board-edge-bend nodrag nopan nowheel nokey"
            aria-label="Изгиб стрелки"
            title="Перетащите для изменения изгиба · стрелки клавиатуры для точной настройки"
            style={{
              left: bendGrip.x,
              top: bendGrip.y,
              transform: `translate(-50%, -50%) scale(${1 / viewport.zoom}) rotate(45deg)`,
            }}
            onPointerDown={(event) => gestures.begin("bend", event)}
            onKeyDown={(event) => gestures.keyboard("bend", event)}
            onClick={(event) => {
              event.stopPropagation();
              gestures.consumeClick();
            }}
          />
        )}
        {props.selected &&
          data.editable &&
          !data.editing &&
          (["source", "target"] as const).map((end) => (
            <button
              key={end}
              type="button"
              className={`board-edge-endpoint nodrag nopan nowheel nokey${gestures.preview?.snap && gestures.preview.kind === end ? " board-edge-endpoint-snapping" : ""}`}
              aria-label={end === "source" ? "Начало стрелки" : "Конец стрелки"}
              title="Перетащите конец стрелки · стрелки клавиатуры для точного перемещения"
              style={{
                left: geometry[`${end}X`],
                top: geometry[`${end}Y`],
                transform: `translate(-50%, -50%) scale(${1 / viewport.zoom})`,
              }}
              onPointerDown={(event) => gestures.begin(end, event)}
              onKeyDown={(event) => gestures.keyboard(end, event)}
              onClick={(event) => {
                event.stopPropagation();
                gestures.consumeClick();
              }}
            />
          ))}
        {props.selected && data.editable && (
          <div
            ref={toolbar}
            className="board-edge-toolbar-anchor"
            style={{
              left: (toolbarX - viewport.x) / viewport.zoom,
              top: (toolbarY - viewport.y) / viewport.zoom,
              width: toolbarWidth,
              transform: `scale(${1 / viewport.zoom})`,
            }}
          >
            <BoardEdgeToolbar
              appearance={data.edge.appearance}
              onEdit={data.onEdit}
              onClose={data.onClose}
              onDelete={data.onDelete}
              onChange={(appearance) => data.onChange({ appearance })}
            />
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
