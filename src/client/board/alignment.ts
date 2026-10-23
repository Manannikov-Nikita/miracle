import type { BoardNode } from "../../shared/types";

export type AlignmentAction =
  | "left"
  | "center-x"
  | "right"
  | "top"
  | "center-y"
  | "bottom"
  | "distribute-x"
  | "distribute-y";

export type AlignmentGuide = {
  axis: "x" | "y";
  coordinate: number;
  from: number;
  to: number;
};

type Axis = "x" | "y";
type Bounds = { x: number; y: number; right: number; bottom: number };

function size(node: BoardNode, axis: Axis): number {
  return axis === "x" ? (node.width ?? 480) : (node.height ?? 300);
}

function bounds(nodes: BoardNode[]): Bounds {
  return {
    x: Math.min(...nodes.map((node) => node.position.x)),
    y: Math.min(...nodes.map((node) => node.position.y)),
    right: Math.max(...nodes.map((node) => node.position.x + size(node, "x"))),
    bottom: Math.max(...nodes.map((node) => node.position.y + size(node, "y"))),
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
      (position.x === node.position.x && position.y === node.position.y)
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
  if (distribute) {
    const sorted = [...selected].sort(
      (a, b) => a.position[axis] - b.position[axis] || a.id.localeCompare(b.id),
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalSize = sorted.reduce(
      (total, node) => total + size(node, axis),
      0,
    );
    const gap =
      (last.position[axis] +
        size(last, axis) -
        first.position[axis] -
        totalSize) /
      (sorted.length - 1);
    let next = first.position[axis] + size(first, axis) + gap;
    // Keep the anchors untouched, including when arithmetic rounds fractional gaps.
    for (const node of sorted.slice(1, -1)) {
      positions.set(node.id, { ...node.position, [axis]: next });
      next += size(node, axis) + gap;
    }
  } else {
    const box = bounds(selected);
    const start = box[axis];
    const end = axis === "x" ? box.right : box.bottom;
    for (const node of selected) {
      const coordinate =
        action === "left" || action === "top"
          ? start
          : action === "right" || action === "bottom"
            ? end - size(node, axis)
            : (start + end - size(node, axis)) / 2;
      positions.set(node.id, { ...node.position, [axis]: coordinate });
    }
  }
  return updatePositions(nodes, positions);
}

type Snap = { delta: number; coordinate: number; target: BoardNode };

function anchors(box: Bounds, axis: Axis): number[] {
  const start = box[axis];
  const end = axis === "x" ? box.right : box.bottom;
  return [start, (start + end) / 2, end];
}

function nearestSnap(
  moving: Bounds,
  stationary: BoardNode[],
  axis: Axis,
  threshold: number,
): Snap | undefined {
  let best: Snap | undefined;
  for (const target of stationary) {
    for (const coordinate of anchors(bounds([target]), axis)) {
      for (const anchor of anchors(moving, axis)) {
        const delta = coordinate - anchor;
        if (Math.abs(delta) > threshold) continue;
        // Coordinate and id break equal-distance ties independently of document order.
        if (
          !best ||
          Math.abs(delta) < Math.abs(best.delta) ||
          (Math.abs(delta) === Math.abs(best.delta) &&
            (coordinate < best.coordinate ||
              (coordinate === best.coordinate &&
                target.id.localeCompare(best.target.id) < 0)))
        ) {
          best = { delta, coordinate, target };
        }
      }
    }
  }
  return best;
}

export function snapBoardNodes(
  nodes: BoardNode[],
  movingIds: ReadonlySet<string>,
  zoom: number,
): { nodes: BoardNode[]; guides: AlignmentGuide[] } {
  const moving = nodes.filter((node) => movingIds.has(node.id));
  const stationary = nodes.filter((node) => !movingIds.has(node.id));
  if (!moving.length || !stationary.length) return { nodes, guides: [] };

  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const box = bounds(moving);
  const snapX = nearestSnap(box, stationary, "x", 6 / scale);
  const snapY = nearestSnap(box, stationary, "y", 6 / scale);
  const dx = snapX?.delta ?? 0;
  const dy = snapY?.delta ?? 0;
  const positions = new Map(
    moving.map((node) => [
      node.id,
      { x: node.position.x + dx, y: node.position.y + dy },
    ]),
  );
  const result = updatePositions(nodes, positions);
  const padding = 8 / scale;
  const guides: AlignmentGuide[] = [];
  if (snapX) {
    const target = bounds([snapX.target]);
    guides.push({
      axis: "x",
      coordinate: snapX.coordinate,
      from: Math.min(box.y + dy, target.y) - padding,
      to: Math.max(box.bottom + dy, target.bottom) + padding,
    });
  }
  if (snapY) {
    const target = bounds([snapY.target]);
    guides.push({
      axis: "y",
      coordinate: snapY.coordinate,
      from: Math.min(box.x + dx, target.x) - padding,
      to: Math.max(box.right + dx, target.right) + padding,
    });
  }
  return { nodes: result, guides };
}
