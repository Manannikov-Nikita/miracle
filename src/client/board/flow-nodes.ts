import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import type { BoardNode } from "../../shared/types";
import type { ArtifactFlowNode } from "./ArtifactNode";
import { getNodeVisualBounds } from "./shape-geometry";

// Board nodes are immutable. Retain at most the two selection variants per
// live node without keeping discarded documents or history entries alive.
const flowNodes = new WeakMap<
  BoardNode,
  { selected?: ArtifactFlowNode; unselected?: ArtifactFlowNode }
>();

export function toArtifactFlowNode(
  node: BoardNode,
  selected: string | null | ReadonlySet<string>,
): ArtifactFlowNode {
  const isSelected =
    typeof selected === "string"
      ? node.id === selected
      : !!selected?.has(node.id);
  const variant = isSelected ? "selected" : "unselected";
  let cached = flowNodes.get(node);
  if (cached?.[variant]) return cached[variant];
  const width = node.width ?? 480;
  const height = node.height ?? 300;
  const visible = getNodeVisualBounds(node);
  const shape = node.data.kind === "shape";
  const renderedWidth = shape
    ? Math.max(0.001, visible.right - visible.x)
    : width;
  const renderedHeight = shape
    ? Math.max(0.001, visible.bottom - visible.y)
    : height;
  const result: ArtifactFlowNode = {
    ...node,
    ...(shape && {
      position: { x: visible.x, y: visible.y },
      width: renderedWidth,
      height: renderedHeight,
      data: {
        ...node.data,
        // Runtime only: original local frame inside the tight painted bounds.
        shapeFrame: {
          x: node.position.x - visible.x,
          y: node.position.y - visible.y,
          width,
          height,
        },
      },
      className: "board-flow-shape",
    }),
    selected: isSelected,
    dragHandle:
      node.data.kind === "shape"
        ? ".board-shape-content"
        : node.data.kind === "image"
          ? ".board-image-content"
          : node.data.kind === "text"
            ? ".board-text-content"
            : ".board-node-header",
    // These nodes have explicit sizes. React Flow resets internal measurements
    // when controlled nodes change, so the resizer needs them on every render.
    measured: { width: renderedWidth, height: renderedHeight },
    style: {
      width: renderedWidth,
      height: renderedHeight,
      // XYFlow sets this inline; CSS alone cannot disable its empty hit box.
      ...(shape && { pointerEvents: "none" }),
    },
  };
  if (!cached) {
    cached = {};
    flowNodes.set(node, cached);
  }
  cached[variant] = result;
  return result;
}

export function applyBoardNodeChanges(
  changes: NodeChange<ArtifactFlowNode>[],
  nodes: BoardNode[],
): BoardNode[] {
  if (!changes.length) return nodes;
  const previous = new Map(nodes.map((node) => [node.id, node]));
  const layoutChanges = changes.map((change) => {
    if (change.type !== "position" || !change.position) return change;
    const node = previous.get(change.id);
    if (!node || node.data.kind !== "shape") return change;
    const visible = getNodeVisualBounds(node);
    const dx = change.position.x - visible.x;
    const dy = change.position.y - visible.y;
    return {
      ...change,
      position: {
        x: node.position.x + dx,
        y: node.position.y + dy,
      },
    };
  });
  const result = applyNodeChanges(
    layoutChanges,
    nodes as ArtifactFlowNode[],
  ).map((changed) => {
    const old = previous.get(changed.id);
    if (changed === old) return old;
    const {
      selected: _,
      dragging: __,
      measured: ___,
      resizing: ____,
      ...node
    } = changed;
    const keys = Object.keys(node) as (keyof BoardNode)[];
    // Runtime selection/measurement/drag flags and identical coordinates do
    // not constitute a persisted edit, including the final drag callback.
    if (
      old &&
      keys.length === Object.keys(old).length &&
      keys.every((key) =>
        key === "position"
          ? node.position.x === old.position.x &&
            node.position.y === old.position.y
          : node[key] === old[key],
      )
    )
      return old;
    return node as BoardNode;
  });
  return result.length === nodes.length &&
    result.every((node, index) => node === nodes[index])
    ? nodes
    : result;
}
