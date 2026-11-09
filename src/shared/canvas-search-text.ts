import type { Board } from "./types.js";
import type { SearchTarget } from "./workspace-search.js";

export type CanvasSearchTarget = Extract<
  SearchTarget,
  { kind: "board" | "presentation" }
>;

/** Search only user-authored fields; never stringify a board or its result data. */
export function readCanvasSearchText(
  board: Board,
  target: CanvasSearchTarget,
): string | undefined {
  if (target.field === "name") return board.name;
  if (target.field === "slide.title")
    return board.document.slides?.find((slide) => slide.id === target.slideId)
      ?.title;
  if (target.field === "edge.label")
    return board.document.edges.find((edge) => edge.id === target.edgeId)
      ?.label;
  const node = board.document.nodes.find((node) => node.id === target.nodeId);
  if (!node) return;
  switch (target.field) {
    case "node.title":
      return node.data.title;
    case "node.text":
      return node.data.text;
    case "node.source.sql":
      return node.data.source?.sql;
    case "node.chart.xLabel":
      return node.data.chart?.xLabel;
    case "node.chart.yLabel":
      return node.data.chart?.yLabel;
    case "node.customChart.description":
      return node.data.customChart?.description;
  }
}
