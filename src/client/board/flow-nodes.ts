import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import type { BoardNode } from "../../shared/types";
import type { ArtifactFlowNode } from "./ArtifactNode";

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
  const result: ArtifactFlowNode = {
    ...node,
    selected: isSelected,
    dragHandle:
      node.data.kind === "shape"
        ? ".board-shape-content"
        : node.data.kind === "text"
          ? ".board-text-content"
          : ".board-node-header",
    // These nodes have explicit sizes. React Flow resets internal measurements
    // when controlled nodes change, so the resizer needs them on every render.
    measured: { width, height },
    style: { width, height },
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
  const result = applyNodeChanges(changes, nodes as ArtifactFlowNode[]).map(
    (changed) => {
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
    },
  );
  return result.length === nodes.length &&
    result.every((node, index) => node === nodes[index])
    ? nodes
    : result;
}
