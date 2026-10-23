import type { BoardNode } from "../../shared/types";
import type { AlignmentGuide } from "./alignment";

export type ResizeSides = {
  left?: boolean;
  right?: boolean;
  top?: boolean;
  bottom?: boolean;
};

type Axis = "x" | "y";
type Snap = { coordinate: number; delta: number; target: BoardNode };

function size(node: BoardNode, axis: Axis): number {
  return axis === "x" ? (node.width ?? 480) : (node.height ?? 300);
}

function nearestSnap(
  stationary: BoardNode[],
  axis: Axis,
  edge: number,
  opposite: number,
  isStart: boolean,
  minimum: number,
  threshold: number,
): Snap | undefined {
  let best: Snap | undefined;
  for (const target of stationary) {
    const start = target.position[axis];
    const length = size(target, axis);
    for (const coordinate of [start, start + length / 2, start + length]) {
      const delta = coordinate - edge;
      const nextSize = isStart ? opposite - coordinate : coordinate - opposite;
      if (Math.abs(delta) > threshold || nextSize < minimum) continue;
      if (
        !best ||
        Math.abs(delta) < Math.abs(best.delta) ||
        (Math.abs(delta) === Math.abs(best.delta) &&
          (coordinate < best.coordinate ||
            (coordinate === best.coordinate &&
              target.id.localeCompare(best.target.id) < 0)))
      ) {
        best = { coordinate, delta, target };
      }
    }
  }
  return best;
}

/** Snap a raw resize result while keeping the opposite edges anchored. */
export function snapResizedNode(
  nodes: BoardNode[],
  nodeId: string,
  sides: ResizeSides,
  zoom: number,
): { nodes: BoardNode[]; guides: AlignmentGuide[] } {
  const moving = nodes.find((node) => node.id === nodeId);
  const stationary = nodes.filter((node) => node.id !== nodeId);
  if (!moving || !stationary.length) return { nodes, guides: [] };

  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const width = size(moving, "x");
  const height = size(moving, "y");
  const right = moving.position.x + width;
  const bottom = moving.position.y + height;
  const markdown = moving.data.kind === "markdown";
  // A resize handle controls one edge on each axis at most.
  const snapX =
    Boolean(sides.left) !== Boolean(sides.right)
      ? nearestSnap(
          stationary,
          "x",
          sides.left ? moving.position.x : right,
          sides.left ? right : moving.position.x,
          Boolean(sides.left),
          markdown ? 240 : 280,
          6 / scale,
        )
      : undefined;
  const snapY =
    Boolean(sides.top) !== Boolean(sides.bottom)
      ? nearestSnap(
          stationary,
          "y",
          sides.top ? moving.position.y : bottom,
          sides.top ? bottom : moving.position.y,
          Boolean(sides.top),
          markdown ? 140 : 180,
          6 / scale,
        )
      : undefined;

  const x = sides.left && snapX ? snapX.coordinate : moving.position.x;
  const y = sides.top && snapY ? snapY.coordinate : moving.position.y;
  const nextWidth = snapX
    ? sides.left
      ? right - x
      : snapX.coordinate - x
    : width;
  const nextHeight = snapY
    ? sides.top
      ? bottom - y
      : snapY.coordinate - y
    : height;
  const changedX = Boolean(snapX && snapX.delta !== 0);
  const changedY = Boolean(snapY && snapY.delta !== 0);
  const resized =
    changedX || changedY
      ? {
          ...moving,
          position:
            x === moving.position.x && y === moving.position.y
              ? moving.position
              : { x, y },
          ...(changedX ? { width: nextWidth } : {}),
          ...(changedY ? { height: nextHeight } : {}),
        }
      : moving;
  const result =
    resized === moving
      ? nodes
      : nodes.map((node) => (node === moving ? resized : node));

  const padding = 8 / scale;
  const guides: AlignmentGuide[] = [];
  if (snapX) {
    guides.push({
      axis: "x",
      coordinate: snapX.coordinate,
      from: Math.min(y, snapX.target.position.y) - padding,
      to:
        Math.max(
          y + nextHeight,
          snapX.target.position.y + size(snapX.target, "y"),
        ) + padding,
    });
  }
  if (snapY) {
    guides.push({
      axis: "y",
      coordinate: snapY.coordinate,
      from: Math.min(x, snapY.target.position.x) - padding,
      to:
        Math.max(
          x + nextWidth,
          snapY.target.position.x + size(snapY.target, "x"),
        ) + padding,
    });
  }
  return { nodes: result, guides };
}
