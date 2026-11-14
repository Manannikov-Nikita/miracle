import type { BoardNode } from "./types.js";
import { getNodeVisualBounds, type VisualBounds } from "./board-geometry.js";

export type Axis = "x" | "y";
export type AlignmentAction =
  | "left"
  | "center-x"
  | "right"
  | "top"
  | "center-y"
  | "bottom"
  | "distribute-x"
  | "distribute-y";

function size(box: VisualBounds, axis: Axis): number {
  return axis === "x" ? box.right - box.x : box.bottom - box.y;
}

export function unionBounds(boxes: VisualBounds[]): VisualBounds {
  return {
    x: Math.min(...boxes.map((box) => box.x)),
    y: Math.min(...boxes.map((box) => box.y)),
    right: Math.max(...boxes.map((box) => box.right)),
    bottom: Math.max(...boxes.map((box) => box.bottom)),
  };
}

export function updatePositions(
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
  anchor?: BoardNode,
): BoardNode[] {
  const selected = nodes.filter((node) => selectedIds.has(node.id));
  const distribute = action === "distribute-x" || action === "distribute-y";
  if (selected.length < (distribute ? 3 : anchor ? 1 : 2)) return nodes;

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
    const box = anchor
      ? getNodeVisualBounds(anchor)
      : unionBounds([...boxes.values()]);
    const start = box[axis];
    const end = axis === "x" ? box.right : box.bottom;
    for (const node of selected) {
      if (node.id === anchor?.id) continue;
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

export type PaintedAnchor =
  "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";

function anchorPoint(box: VisualBounds, anchor: PaintedAnchor) {
  switch (anchor) {
    case "top-left":
      return { x: box.x, y: box.y };
    case "top-right":
      return { x: box.right, y: box.y };
    case "bottom-left":
      return { x: box.x, y: box.bottom };
    case "bottom-right":
      return { x: box.right, y: box.bottom };
    case "center":
      return { x: (box.x + box.right) / 2, y: (box.y + box.bottom) / 2 };
  }
}

export function translateBoardNode(node: BoardNode, dx: number, dy: number) {
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return node;
  return {
    ...node,
    position: { x: node.position.x + dx, y: node.position.y + dy },
  };
}

export function placeBoardNode(node: BoardNode, x: number, y: number) {
  const bounds = getNodeVisualBounds(node);
  return translateBoardNode(node, x - bounds.x, y - bounds.y);
}

export function resizeBoardNode(
  node: BoardNode,
  dimensions: { width?: number; height?: number },
  anchor: PaintedAnchor,
) {
  const original = anchorPoint(getNodeVisualBounds(node), anchor);
  const resized = {
    ...node,
    width: dimensions.width ?? node.width,
    height: dimensions.height ?? node.height,
  };
  const target = anchorPoint(getNodeVisualBounds(resized), anchor);
  return translateBoardNode(
    resized,
    original.x - target.x,
    original.y - target.y,
  );
}
