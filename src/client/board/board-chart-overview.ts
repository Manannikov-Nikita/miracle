import { createContext } from "react";
import type { BoardNode } from "../../shared/types";

// Consumers outside the editable board (including slides and standalone charts)
// always render the full chart.
export const BoardChartOverviewContext = createContext(false);

export function isLargeChartBoard(nodes: readonly BoardNode[]) {
  let charts = 0;
  for (const { data } of nodes) {
    if (data.kind !== "result" || data.view !== "chart" || !data.resultSetId)
      continue;
    charts++;
    if (charts > 20) return true;
  }
  return false;
}

// A new "restore" value identifies a new zoom-in. Each visible chart can
// remember that it has been promoted during this particular transition.
type CanvasChartDetail = { readonly phase: "full" | "overview" | "restore" };
export const fullChartDetail: CanvasChartDetail = { phase: "full" };
export const CanvasChartDetailContext = createContext(fullChartDetail);

export function chartDetailAtZoom(
  previous: CanvasChartDetail,
  zoom: number,
): CanvasChartDetail {
  if (zoom <= 0.45 && previous.phase !== "overview")
    return { phase: "overview" };
  if (zoom >= 0.55 && previous.phase === "overview")
    return { phase: "restore" };
  return previous;
}
