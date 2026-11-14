import type { AgentTargetContext } from "../../shared/agents.js";
import type { Board } from "../../shared/types.js";
import { boardKind } from "../../shared/presentation.js";

const short = (value: string, limit = 120) =>
  value.length > limit ? value.slice(0, limit - 1) + "…" : value;

/** Identity only; geometry and authored content are explicitly read on demand. */
export function compactBoardContext(board: Board, targets: AgentTargetContext) {
  const slideId = targets.slideId;
  const nodes = slideId
    ? board.document.nodes.filter((node) => node.slideId === slideId)
    : board.document.nodes;
  const edges = slideId
    ? board.document.edges.filter((edge) => edge.slideId === slideId)
    : board.document.edges;
  const selectedNodes = targets.boardNodes || [];
  const selectedEdges = targets.boardEdges || [];
  const slide = board.document.slides?.find((item) => item.id === slideId);
  return {
    id: board.id,
    name: short(board.name),
    kind: boardKind(board.document),
    revision: board.revision,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    ...(board.document.slides && { slideCount: board.document.slides.length }),
    ...(slideId && {
      slideId,
      slide: slide
        ? {
            id: slide.id,
            title: short(slide.title),
            background: slide.background,
          }
        : { id: slideId, missing: true },
    }),
    selectedNodes: selectedNodes.slice(0, 12).map((selected) => {
      const node = nodes.find((item) => item.id === selected.id);
      return node
        ? {
            id: node.id,
            title: short(node.data.title),
            kind: node.data.kind,
            view: node.data.view,
            ...(node.data.customChart && {
              customChart: {
                version: node.data.customChart.version,
                description: short(node.data.customChart.description || ""),
              },
            }),
          }
        : { id: selected.id, missing: true };
    }),
    selectedEdges: selectedEdges.slice(0, 12).map((selected) => {
      const edge = edges.find((item) => item.id === selected.id);
      return edge
        ? {
            id: edge.id,
            label: short(edge.label || selected.label),
            source: edge.source,
            target: edge.target,
          }
        : { id: selected.id, missing: true };
    }),
    ...(selectedNodes.length > 12 && {
      selectedNodeCount: selectedNodes.length,
      selectedNodesTruncated: true,
    }),
    ...(selectedEdges.length > 12 && {
      selectedEdgeCount: selectedEdges.length,
      selectedEdgesTruncated: true,
    }),
  };
}

export const boardAgentInstructions =
  "For board tasks start with read_board_scene: it supplies actual painted bounds, neighbors and relations without copying the board's content. Use board_spatial for moves, alignment, equal gaps and resizing; saved rectangles differ from visible shape/arrow bounds. Read only the specific content needed through read_board_items, keeping revision fixed across pages. Prefer board_patch response:'compact' for content/style changes. Full read_board is a fallback, not the default. targets.boardEdges identify selected connectors; do not substitute another edge when an ID is missing. Prefer delegate_board_task for independent groups of simple edits using exact existing node/edge IDs and a short objective, at most two concurrent workers on the same profile/model. Use these managed workers for board writes, not native provider subagents sharing your MCP identity. Batch related small edits per worker instead of spawning one process per trivial action. Release overlapping claims before delegating; never edit the same scope yourself while a worker owns it. Workers already reserve their scope. Inspect board_task_status for short outcomes and read the new scene before follow-up; failed/cancelled tasks may have committed some edits. Queue overlaps instead of repeatedly retrying a locked object. Do not copy full board JSON or parent conversation into task prompts. Do not declare success before every delegated task has settled and the resulting scene has been checked.";
