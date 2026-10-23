import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import type { BoardNode } from "../../shared/types";
import type { ArtifactFlowNode } from "./ArtifactNode";

export function toArtifactFlowNode(
  node: BoardNode,
  selected: string | null | ReadonlySet<string>,
): ArtifactFlowNode {
  const width = node.width ?? 480;
  const height = node.height ?? 300;
  return {
    ...node,
    selected:
      typeof selected === "string"
        ? node.id === selected
        : !!selected?.has(node.id),
    dragHandle: ".board-node-header",
    // These nodes have explicit sizes. React Flow resets internal measurements
    // when controlled nodes change, so the resizer needs them on every render.
    measured: { width, height },
    style: { width, height },
  };
}

export function applyBoardNodeChanges(
  changes: NodeChange<ArtifactFlowNode>[],
  nodes: BoardNode[],
): BoardNode[] {
  return applyNodeChanges(changes, nodes as ArtifactFlowNode[]).map(
    ({ selected: _, dragging: __, measured: ___, resizing: ____, ...node }) =>
      node as BoardNode,
  );
}
