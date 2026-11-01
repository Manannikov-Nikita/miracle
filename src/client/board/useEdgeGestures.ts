import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Position, useReactFlow } from "@xyflow/react";
import type { BoardEdge } from "../../shared/types";
import {
  boundedPoint,
  clampFraction,
  closestHandle,
  closestPathPosition,
  directionToward,
  endpointPatch,
  pointAlongPath,
  translateEdge,
  type BoardEdgeGeometryPatch,
  type EdgeEnd,
  type EdgeGeometry,
  type EdgePoint,
  type PathMeasurement,
  type SnapHandle,
} from "./edge-geometry";

type GestureKind = "line" | "label" | "bend" | EdgeEnd;
type Preview = {
  kind: GestureKind;
  geometry: EdgeGeometry;
  labelPosition: number;
  snap?: SnapHandle;
  bend?: BoardEdge["bend"];
  path?: "smoothstep" | "straight" | "bezier";
};
type Options = {
  edge?: BoardEdge;
  scope?: string;
  geometry: EdgeGeometry;
  zoom: number;
  enabled: boolean;
  path: () => PathMeasurement | null | undefined;
  bendPoint?: EdgePoint;
  onSelect?: () => void;
  onCommit?: (patch: BoardEdgeGeometryPatch, expected?: BoardEdge) => void;
};
type Drag = {
  kind: GestureKind;
  pointerId: number;
  screenStart: EdgePoint;
  worldStart: EdgePoint;
  grabOffset?: EdgePoint;
  geometry: EdgeGeometry;
  expected: BoardEdge;
  onCommit: Options["onCommit"];
  moved: boolean;
  patch?: BoardEdgeGeometryPatch;
  cleanup: () => void;
};

function changesGeometry(
  patch: BoardEdgeGeometryPatch,
  edge: BoardEdge,
  geometry: EdgeGeometry,
) {
  return Object.entries(patch).some(([field, value]) => {
    const key = field as keyof BoardEdgeGeometryPatch;
    const previous =
      key === "labelPosition"
        ? (edge.labelPosition ?? 0.5)
        : key === "sourceHandle"
          ? (edge.sourceHandle ?? geometry.sourcePosition)
          : key === "targetHandle"
            ? (edge.targetHandle ?? geometry.targetPosition)
            : key === "appearance"
              ? { path: edge.appearance?.path ?? "smoothstep" }
              : edge[key];
    return JSON.stringify(previous) !== JSON.stringify(value);
  });
}

export default function useEdgeGestures(options: Options) {
  const flow = useReactFlow();
  const latest = useRef(options);
  latest.current = options;
  const active = useRef<Drag | undefined>(undefined);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<Preview>();
  const stop = useCallback((commit: boolean, unmount = false) => {
    const drag = active.current;
    if (!drag) return;
    active.current = undefined;
    drag.cleanup();
    if (drag.moved) suppressClick.current = true;
    if (!unmount) setPreview(undefined);
    if (
      commit &&
      drag.patch &&
      changesGeometry(drag.patch, drag.expected, drag.geometry)
    ) {
      drag.onCommit?.(drag.patch, drag.expected);
    }
  }, []);
  const edge = options.edge;
  const geometryKey = JSON.stringify([
    options.scope,
    edge?.id,
    edge?.source,
    edge?.target,
    edge?.sourcePoint,
    edge?.targetPoint,
    edge?.sourceHandle,
    edge?.targetHandle,
    edge?.labelPosition,
    edge?.bend,
    edge?.appearance?.path,
    options.geometry,
    options.zoom,
    options.enabled,
  ]);
  useEffect(() => {
    stop(false);
  }, [geometryKey, stop]);
  useEffect(() => () => stop(false, true), [stop]);

  const begin = (kind: GestureKind, event: ReactPointerEvent<Element>) => {
    const current = latest.current;
    if (
      !current.enabled ||
      !current.edge ||
      event.button !== 0 ||
      active.current
    )
      return;
    event.stopPropagation();
    const element = event.currentTarget;
    const screenStart = { x: event.clientX, y: event.clientY };
    const worldStart = flow.screenToFlowPosition(screenStart, {
      snapToGrid: false,
    });
    const pointerId = event.pointerId;
    suppressClick.current = false;
    const cancel = () => stop(false);
    const keydown = (key: KeyboardEvent) => {
      if (key.key !== "Escape") return;
      key.preventDefault();
      key.stopImmediatePropagation();
      cancel();
    };
    const move = (pointer: PointerEvent) => {
      const drag = active.current;
      if (!drag || pointer.pointerId !== drag.pointerId) return;
      const dx = pointer.clientX - drag.screenStart.x;
      const dy = pointer.clientY - drag.screenStart.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      pointer.preventDefault();
      const point = flow.screenToFlowPosition(
        { x: pointer.clientX, y: pointer.clientY },
        { snapToGrid: false },
      );
      const grabbedPoint = {
        x: point.x + (drag.grabOffset?.x ?? 0),
        y: point.y + (drag.grabOffset?.y ?? 0),
      };
      let geometry = drag.geometry;
      let labelPosition = drag.expected.labelPosition ?? 0.5;
      let snap: SnapHandle | undefined;
      let bend = drag.expected.bend;
      let path = drag.expected.appearance?.path;
      if (drag.kind === "line") {
        geometry = translateEdge(drag.geometry, {
          x: point.x - drag.worldStart.x,
          y: point.y - drag.worldStart.y,
        });
        drag.patch =
          geometry.sourceX === drag.geometry.sourceX &&
          geometry.sourceY === drag.geometry.sourceY
            ? undefined
            : {
                ...endpointPatch(
                  "source",
                  { x: geometry.sourceX, y: geometry.sourceY },
                  geometry.sourcePosition,
                ),
                ...endpointPatch(
                  "target",
                  { x: geometry.targetX, y: geometry.targetY },
                  geometry.targetPosition,
                ),
              };
      } else if (drag.kind === "label") {
        labelPosition =
          closestPathPosition(current.path(), grabbedPoint) ?? labelPosition;
        drag.patch = { labelPosition };
      } else if (drag.kind === "bend") {
        if (
          pointer.clientX === drag.screenStart.x &&
          pointer.clientY === drag.screenStart.y
        ) {
          drag.patch = undefined;
        } else {
          bend = boundedPoint({
            x: grabbedPoint.x - (geometry.sourceX + geometry.targetX) / 2,
            y: grabbedPoint.y - (geometry.sourceY + geometry.targetY) / 2,
          });
          path = path === "straight" ? "bezier" : path;
          drag.patch = {
            bend,
            ...(drag.expected.appearance?.path === "straight"
              ? { appearance: { path: "bezier" as const } }
              : {}),
          };
        }
      } else {
        const end = drag.kind;
        const oppositeNode =
          end === "source" ? drag.expected.target : drag.expected.source;
        snap = closestHandle(
          grabbedPoint,
          flow.getNodes().filter((node) => node.id !== oppositeNode),
          flow.getInternalNode,
          16 / current.zoom,
        );
        const next = snap?.point ?? boundedPoint(grabbedPoint);
        const other =
          end === "source"
            ? { x: geometry.targetX, y: geometry.targetY }
            : { x: geometry.sourceX, y: geometry.sourceY };
        const side =
          (snap?.side as Position | undefined) ?? directionToward(next, other);
        geometry = {
          ...geometry,
          [`${end}X`]: next.x,
          [`${end}Y`]: next.y,
          [`${end}Position`]: side,
        };
        drag.patch = endpointPatch(end, next, side, snap?.nodeId);
      }
      setPreview({
        kind: drag.kind,
        geometry,
        labelPosition,
        snap,
        bend,
        path,
      });
    };
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== active.current?.pointerId) return;
      move(pointer);
      stop(true);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", cancel);
      element.removeEventListener("lostpointercapture", cancel);
      if (element.hasPointerCapture?.(pointerId))
        element.releasePointerCapture(pointerId);
    };
    const grabbedAnchor =
      kind === "label"
        ? pointAlongPath(current.path(), current.edge.labelPosition ?? 0.5)
        : kind === "bend"
          ? current.bendPoint
          : kind === "line"
            ? undefined
            : {
                x: current.geometry[`${kind}X`],
                y: current.geometry[`${kind}Y`],
              };
    active.current = {
      kind,
      pointerId,
      screenStart,
      worldStart,
      grabOffset: grabbedAnchor
        ? {
            x: grabbedAnchor.x - worldStart.x,
            y: grabbedAnchor.y - worldStart.y,
          }
        : undefined,
      geometry: current.geometry,
      expected: current.edge,
      onCommit: current.onCommit,
      moved: false,
      cleanup,
    };
    element.setPointerCapture?.(pointerId);
    window.addEventListener("pointermove", move, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", cancel);
    element.addEventListener("lostpointercapture", cancel);
    current.onSelect?.();
  };

  const keyboard = (
    kind: Exclude<GestureKind, "line">,
    event: ReactKeyboardEvent<Element>,
  ) => {
    const current = latest.current;
    if (!current.enabled || !current.edge || active.current) return;
    const key = event.key;
    let patch: BoardEdgeGeometryPatch;
    if (kind === "label") {
      if (
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(key)
      )
        return;
      const step = event.shiftKey ? 0.1 : 0.025;
      const old = current.edge.labelPosition ?? 0.5;
      const value =
        key === "Home"
          ? 0
          : key === "End"
            ? 1
            : old + (["ArrowLeft", "ArrowUp"].includes(key) ? -step : step);
      patch = {
        labelPosition: Math.round(clampFraction(value) * 10000) / 10000,
      };
    } else if (kind === "bend") {
      if (key === "Delete" || key === "Backspace") {
        patch = { bend: undefined };
      } else {
        if (
          !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key) ||
          !current.bendPoint
        )
          return;
        const step = (event.shiftKey ? 10 : 1) / current.zoom;
        const point = current.bendPoint;
        const bend = boundedPoint({
          x:
            point.x -
            (current.geometry.sourceX + current.geometry.targetX) / 2 +
            (key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0),
          y:
            point.y -
            (current.geometry.sourceY + current.geometry.targetY) / 2 +
            (key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0),
        });
        patch = {
          bend,
          ...(current.edge.appearance?.path === "straight"
            ? { appearance: { path: "bezier" as const } }
            : {}),
        };
      }
    } else {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key))
        return;
      const step = (event.shiftKey ? 10 : 1) / current.zoom;
      const geometry = current.geometry;
      const point = boundedPoint({
        x:
          geometry[`${kind}X`] +
          (key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0),
        y:
          geometry[`${kind}Y`] +
          (key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0),
      });
      const other =
        kind === "source"
          ? { x: geometry.targetX, y: geometry.targetY }
          : { x: geometry.sourceX, y: geometry.sourceY };
      patch = endpointPatch(kind, point, directionToward(point, other));
    }
    event.preventDefault();
    event.stopPropagation();
    if (changesGeometry(patch, current.edge, current.geometry))
      current.onCommit?.(patch, current.edge);
  };

  const consumeClick = () => {
    const blocked = suppressClick.current;
    suppressClick.current = false;
    return blocked;
  };
  return { preview, begin, keyboard, consumeClick };
}
