import {
  Position,
  type EdgeProps,
  type InternalNode,
  type Node,
} from "@xyflow/react";
import type {
  BoardEdge,
  BoardEdgeAppearance,
  BoardHandleSide,
} from "../../shared/types";

export type EdgePoint = { x: number; y: number };
export type EdgeEnd = "source" | "target";
export type BoardEdgeGeometryPatch = Partial<
  Pick<
    BoardEdge,
    | "source"
    | "target"
    | "sourcePoint"
    | "targetPoint"
    | "sourceHandle"
    | "targetHandle"
    | "labelPosition"
    | "bend"
  >
> & { appearance?: Pick<BoardEdgeAppearance, "path"> };
export type EdgeGeometry = Pick<
  EdgeProps,
  | "sourceX"
  | "sourceY"
  | "targetX"
  | "targetY"
  | "sourcePosition"
  | "targetPosition"
>;
export type PathMeasurement = Pick<
  SVGPathElement,
  "getTotalLength" | "getPointAtLength"
>;
export type SnapHandle = {
  nodeId: string;
  side: BoardHandleSide;
  point: EdgePoint;
};

const LIMIT = 1_000_000;
export const clampFraction = (value: number) => Math.max(0, Math.min(1, value));
const clampCoordinate = (value: number) =>
  Math.max(-LIMIT, Math.min(LIMIT, value));
export const boundedPoint = (point: EdgePoint): EdgePoint => ({
  x: clampCoordinate(point.x),
  y: clampCoordinate(point.y),
});

export function directionToward(point: EdgePoint, other: EdgePoint): Position {
  const dx = other.x - point.x;
  const dy = other.y - point.y;
  return Math.abs(dx) >= Math.abs(dy)
    ? dx >= 0
      ? Position.Right
      : Position.Left
    : dy >= 0
      ? Position.Bottom
      : Position.Top;
}

export function canonicalEdgeGeometry(
  props: EdgeGeometry,
  edge?: BoardEdge,
): EdgeGeometry {
  const source = edge?.sourcePoint ?? { x: props.sourceX, y: props.sourceY };
  const target = edge?.targetPoint ?? { x: props.targetX, y: props.targetY };
  return {
    sourceX: source.x,
    sourceY: source.y,
    targetX: target.x,
    targetY: target.y,
    sourcePosition: edge?.sourcePoint
      ? ((edge.sourceHandle as Position | undefined) ??
        directionToward(source, target))
      : props.sourcePosition,
    targetPosition: edge?.targetPoint
      ? ((edge.targetHandle as Position | undefined) ??
        directionToward(target, source))
      : props.targetPosition,
  };
}

export function translateEdge(
  geometry: EdgeGeometry,
  delta: EdgePoint,
): EdgeGeometry {
  // Clamp the common delta, preserving the line's length at board limits.
  const dx = Math.max(
    -LIMIT - Math.min(geometry.sourceX, geometry.targetX),
    Math.min(delta.x, LIMIT - Math.max(geometry.sourceX, geometry.targetX)),
  );
  const dy = Math.max(
    -LIMIT - Math.min(geometry.sourceY, geometry.targetY),
    Math.min(delta.y, LIMIT - Math.max(geometry.sourceY, geometry.targetY)),
  );
  return {
    ...geometry,
    sourceX: geometry.sourceX + dx,
    sourceY: geometry.sourceY + dy,
    targetX: geometry.targetX + dx,
    targetY: geometry.targetY + dy,
  };
}

export function endpointPatch(
  end: EdgeEnd,
  point: EdgePoint,
  side: Position,
  nodeId?: string,
): BoardEdgeGeometryPatch {
  return {
    [end]: nodeId,
    [`${end}Point`]: nodeId ? undefined : point,
    [`${end}Handle`]: side as BoardHandleSide,
  };
}

export function closestHandle(
  point: EdgePoint,
  nodes: Node[],
  internal: (id: string) => InternalNode | undefined,
  radius: number,
): SnapHandle | undefined {
  let closest: SnapHandle | undefined;
  let distance = radius * radius;
  for (const node of nodes) {
    if (node.type !== "artifact" || node.hidden) continue;
    const measured = internal(node.id);
    if (!measured) continue;
    const origin = measured.internals.positionAbsolute;
    const bounds = measured.internals.handleBounds;
    for (const handle of [
      ...(bounds?.source ?? []),
      ...(bounds?.target ?? []),
    ]) {
      if (!handle.id || !["top", "right", "bottom", "left"].includes(handle.id))
        continue;
      const x = origin.x + handle.x;
      const y = origin.y + handle.y;
      // Match XYFlow's edge anchor: the outer tip, not the handle's centre.
      const tip = {
        x:
          x +
          (handle.position === Position.Right
            ? handle.width
            : handle.position === Position.Left
              ? 0
              : handle.width / 2),
        y:
          y +
          (handle.position === Position.Bottom
            ? handle.height
            : handle.position === Position.Top
              ? 0
              : handle.height / 2),
      };
      const squared = (point.x - tip.x) ** 2 + (point.y - tip.y) ** 2;
      if (squared > distance) continue;
      closest = {
        nodeId: node.id,
        side: handle.id as BoardHandleSide,
        point: tip,
      };
      distance = squared;
    }
  }
  return closest;
}

export function pointAlongPath(
  path: PathMeasurement | null | undefined,
  position: number,
): EdgePoint | undefined {
  if (!path || typeof path.getTotalLength !== "function") return;
  try {
    const point = path.getPointAtLength(
      path.getTotalLength() * clampFraction(position),
    );
    return { x: point.x, y: point.y };
  } catch {
    return;
  }
}

export function closestPathPosition(
  path: PathMeasurement | null | undefined,
  point: EdgePoint,
): number | undefined {
  if (!path || typeof path.getTotalLength !== "function") return;
  const length = path.getTotalLength();
  if (!Number.isFinite(length) || length <= 0) return;
  const distance = (at: number) => {
    const candidate = path.getPointAtLength(at);
    return (point.x - candidate.x) ** 2 + (point.y - candidate.y) ** 2;
  };
  const samples = Math.min(256, Math.max(32, Math.ceil(length / 8)));
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index <= samples; index++) {
    const at = (length * index) / samples;
    const candidateDistance = distance(at);
    if (candidateDistance < bestDistance) {
      best = at;
      bestDistance = candidateDistance;
    }
  }
  let low = Math.max(0, best - length / samples);
  let high = Math.min(length, best + length / samples);
  for (let index = 0; index < 18; index++) {
    const a = low + (high - low) / 3;
    const b = high - (high - low) / 3;
    if (distance(a) < distance(b)) high = b;
    else low = a;
  }
  const fraction = (low + high) / 2 / length;
  return Math.round(clampFraction(fraction) * 10000) / 10000;
}
