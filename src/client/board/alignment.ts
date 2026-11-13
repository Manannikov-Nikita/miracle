import type { BoardNode } from "../../shared/types";
import { getNodeVisualBounds } from "./shape-geometry";
import {
  nearestSpacingSnap,
  spacingGuides,
  type SnapAxis,
  type SnapBounds,
  type SnapTarget,
  type SpacingGuide,
  type SpacingSnap,
} from "./equal-spacing";

export type AlignmentAction =
  | "left"
  | "center-x"
  | "right"
  | "top"
  | "center-y"
  | "bottom"
  | "distribute-x"
  | "distribute-y";

export type AlignmentGuide =
  | {
      kind?: never;
      distance?: never;
      axis: SnapAxis;
      coordinate: number;
      from: number;
      to: number;
    }
  | SpacingGuide;

type Axis = SnapAxis;
export type SnapFrame = SnapBounds;
type Bounds = SnapBounds;

function size(box: Bounds, axis: Axis): number {
  return axis === "x" ? box.right - box.x : box.bottom - box.y;
}

function bounds(boxes: Bounds[]): Bounds {
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

function updatePositions(
  nodes: BoardNode[],
  positions: ReadonlyMap<string, BoardNode["position"]>,
): BoardNode[] {
  let changed = false;
  const result = nodes.map((node) => {
    const position = positions.get(node.id);
    if (
      !position ||
      (Math.abs(position.x - node.position.x) < 1e-9 &&
        Math.abs(position.y - node.position.y) < 1e-9)
    )
      return node;
    changed = true;
    return { ...node, position };
  });
  return changed ? result : nodes;
}

export function alignBoardNodes(
  nodes: BoardNode[],
  selectedIds: ReadonlySet<string>,
  action: AlignmentAction,
): BoardNode[] {
  const selected = nodes.filter((node) => selectedIds.has(node.id));
  const distribute = action === "distribute-x" || action === "distribute-y";
  if (selected.length < (distribute ? 3 : 2)) return nodes;

  const axis: Axis =
    action === "left" ||
    action === "center-x" ||
    action === "right" ||
    action === "distribute-x"
      ? "x"
      : "y";
  const positions = new Map<string, BoardNode["position"]>();
  const boxes = new Map(
    selected.map((node) => [node.id, getNodeVisualBounds(node)]),
  );
  if (distribute) {
    const sorted = [...selected].sort(
      (a, b) =>
        boxes.get(a.id)![axis] - boxes.get(b.id)![axis] ||
        a.id.localeCompare(b.id),
    );
    const first = boxes.get(sorted[0].id)!;
    const last = boxes.get(sorted[sorted.length - 1].id)!;
    const totalSize = sorted.reduce(
      (total, node) => total + size(boxes.get(node.id)!, axis),
      0,
    );
    const gap =
      (last[axis] + size(last, axis) - first[axis] - totalSize) /
      (sorted.length - 1);
    let next = first[axis] + size(first, axis) + gap;
    // Keep the anchors untouched, including when arithmetic rounds fractional gaps.
    for (const node of sorted.slice(1, -1)) {
      const box = boxes.get(node.id)!;
      positions.set(node.id, {
        ...node.position,
        [axis]: node.position[axis] + next - box[axis],
      });
      next += size(box, axis) + gap;
    }
  } else {
    const box = bounds([...boxes.values()]);
    const start = box[axis];
    const end = axis === "x" ? box.right : box.bottom;
    for (const node of selected) {
      const visual = boxes.get(node.id)!;
      const coordinate =
        action === "left" || action === "top"
          ? start
          : action === "right" || action === "bottom"
            ? end - size(visual, axis)
            : (start + end - size(visual, axis)) / 2;
      positions.set(node.id, {
        ...node.position,
        [axis]: node.position[axis] + coordinate - visual[axis],
      });
    }
  }
  return updatePositions(nodes, positions);
}

type Snap = {
  delta: number;
  coordinate: number;
  target: Bounds;
  id: string;
  frame?: boolean;
};

function anchors(box: Bounds, axis: Axis): number[] {
  const start = box[axis];
  const end = axis === "x" ? box.right : box.bottom;
  return [start, (start + end) / 2, end];
}

function nearestSnap(
  moving: Bounds,
  stationary: readonly SnapTarget[],
  axis: Axis,
  threshold: number,
  frame?: SnapFrame,
): Snap | undefined {
  let best: Snap | undefined;
  const movingAnchors = anchors(moving, axis);
  for (const { id, bounds: targetBounds } of stationary) {
    for (const coordinate of anchors(targetBounds, axis)) {
      for (const anchor of movingAnchors) {
        const delta = coordinate - anchor;
        if (Math.abs(delta) > threshold) continue;
        // Coordinate and id break equal-distance ties independently of document order.
        if (
          !best ||
          Math.abs(delta) < Math.abs(best.delta) ||
          (Math.abs(delta) === Math.abs(best.delta) &&
            (coordinate < best.coordinate ||
              (coordinate === best.coordinate &&
                id.localeCompare(best.id) < 0)))
        ) {
          best = { delta, coordinate, target: targetBounds, id };
        }
      }
    }
  }
  if (frame) {
    const end = axis === "x" ? "right" : "bottom";
    for (const coordinate of [frame[axis], frame[end]]) {
      for (const anchor of [moving[axis], moving[end]]) {
        const delta = coordinate - anchor;
        if (Math.abs(delta) > threshold) continue;
        if (
          !best ||
          Math.abs(delta) < Math.abs(best.delta) ||
          (Math.abs(delta) === Math.abs(best.delta) &&
            (!best.frame || coordinate < best.coordinate))
        )
          best = { delta, coordinate, target: frame, id: "", frame: true };
      }
    }
  }
  return best;
}

export function snapBoardNodes(
  nodes: BoardNode[],
  movingIds: ReadonlySet<string>,
  zoom: number,
  frame?: SnapFrame,
): { nodes: BoardNode[]; guides: AlignmentGuide[] } {
  const moving = nodes.filter((node) => movingIds.has(node.id));
  const stationary = nodes.filter((node) => !movingIds.has(node.id));
  if (!moving.length || (!stationary.length && !frame))
    return { nodes, guides: [] };

  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const threshold = 6 / scale;
  const box = bounds(moving.map(getNodeVisualBounds));
  const targets = stationary.map((node) => ({
    id: node.id,
    bounds: getNodeVisualBounds(node),
  }));
  const snapX = nearestSnap(box, targets, "x", threshold, frame);
  const snapY = nearestSnap(box, targets, "y", threshold, frame);
  const preferredSpacing = (
    spacing: SpacingSnap | undefined,
    anchor: Snap | undefined,
  ) =>
    spacing &&
    (!anchor || Math.abs(spacing.delta) + 1e-9 < Math.abs(anchor.delta))
      ? spacing
      : undefined;
  const candidateX = nearestSpacingSnap(box, targets, "x", threshold);
  const candidateY = nearestSpacingSnap(box, targets, "y", threshold);
  let spacingX = preferredSpacing(candidateX, snapX);
  let spacingY = preferredSpacing(candidateY, snapY);
  let dx: number;
  let dy: number;
  let xGuides: SpacingGuide[];
  let yGuides: SpacingGuide[];
  // A perpendicular correction can close the shared strip. Revert any
  // invalid spacing candidate and validate the remaining one again.
  for (;;) {
    dx = spacingX?.delta ?? snapX?.delta ?? 0;
    dy = spacingY?.delta ?? snapY?.delta ?? 0;
    const final = {
      x: box.x + dx,
      y: box.y + dy,
      right: box.right + dx,
      bottom: box.bottom + dy,
    };
    // A gap can share an anchor's exact position without overriding it.
    const x = candidateX && Math.abs(candidateX.delta - dx) <= 1e-9;
    const y = candidateY && Math.abs(candidateY.delta - dy) <= 1e-9;
    xGuides = x ? spacingGuides(candidateX, final, targets, "x") : [];
    yGuides = y ? spacingGuides(candidateY, final, targets, "y") : [];
    if (spacingX && !xGuides.length) spacingX = undefined;
    else if (spacingY && !yGuides.length) spacingY = undefined;
    else break;
  }
  const positions = new Map(
    moving.map((node) => [
      node.id,
      { x: node.position.x + dx, y: node.position.y + dy },
    ]),
  );
  const result = updatePositions(nodes, positions);
  const padding = 8 / scale;
  const guides: AlignmentGuide[] = [];
  if (!spacingX && snapX) {
    const target = snapX.target;
    guides.push({
      axis: "x",
      coordinate: snapX.coordinate,
      from: snapX.frame ? target.y : Math.min(box.y + dy, target.y) - padding,
      to: snapX.frame
        ? target.bottom
        : Math.max(box.bottom + dy, target.bottom) + padding,
    });
  }
  guides.push(...xGuides);
  if (!spacingY && snapY) {
    const target = snapY.target;
    guides.push({
      axis: "y",
      coordinate: snapY.coordinate,
      from: snapY.frame ? target.x : Math.min(box.x + dx, target.x) - padding,
      to: snapY.frame
        ? target.right
        : Math.max(box.right + dx, target.right) + padding,
    });
  }
  guides.push(...yGuides);
  return { nodes: result, guides };
}
