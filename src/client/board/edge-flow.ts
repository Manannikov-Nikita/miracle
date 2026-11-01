import { Position, type Node } from "@xyflow/react";
import type {
  BoardDocument,
  BoardEdge,
  BoardHandleSide,
} from "../../shared/types";
import type { ArtifactFlowNode } from "./ArtifactNode";
import { toArtifactFlowNode } from "./flow-nodes";

export type EdgeAnchorFlowNode = Node<Record<string, never>, "edge-anchor">;
export type BoardCanvasNode = ArtifactFlowNode | EdgeAnchorFlowNode;

const positions: Record<BoardHandleSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

// React Flow requires two nodes to render an edge. Free ends use invisible,
// runtime-only anchors; the saved document contains only their coordinates.
export function toBoardFlow(
  document: BoardDocument,
  selected: ReadonlySet<string>,
) {
  const nodes: BoardCanvasNode[] = document.nodes.map((node) =>
    toArtifactFlowNode(node, selected),
  );
  const used = new Set(nodes.map((node) => node.id));
  const endpoint = (edge: BoardEdge, end: "source" | "target") => {
    const point = edge[end === "source" ? "sourcePoint" : "targetPoint"];
    if (!point) return edge[end]!;
    let id = `__edge-anchor:${edge.id}:${end}`;
    while (used.has(id)) id += ":";
    used.add(id);
    const side =
      edge[end === "source" ? "sourceHandle" : "targetHandle"] ??
      (end === "source" ? "right" : "left");
    nodes.push({
      id,
      type: "edge-anchor",
      position: { ...point },
      data: {},
      width: 1,
      height: 1,
      measured: { width: 1, height: 1 },
      hidden: true,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      focusable: false,
      handles: [
        {
          id: side,
          type: "source",
          position: positions[side],
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        },
      ],
    });
    return id;
  };
  const edges = document.edges.map((edge) => ({
    edge,
    source: endpoint(edge, "source"),
    target: endpoint(edge, "target"),
  }));
  return { nodes, edges };
}

// Key order and absent defaults are irrelevant when deciding whether a drag
// still applies to the same geometry after a remote document update.
export function edgeGeometryKey(edge: BoardEdge) {
  return JSON.stringify([
    edge.source ?? null,
    edge.target ?? null,
    edge.sourceHandle ?? "right",
    edge.targetHandle ?? "left",
    edge.sourcePoint?.x ?? null,
    edge.sourcePoint?.y ?? null,
    edge.targetPoint?.x ?? null,
    edge.targetPoint?.y ?? null,
    edge.labelPosition ?? 0.5,
    edge.bend?.x ?? null,
    edge.bend?.y ?? null,
    edge.appearance?.path ?? "smoothstep",
  ]);
}
