import { PRESENTATION_HEIGHT, PRESENTATION_WIDTH } from "./presentation.js";
import type { BoardNode } from "./types.js";

export const DEFAULT_RESULT_SIZE = { width: 540, height: 350 } as const;
export const DEFAULT_CHART_SIZE = { width: 702, height: 455 } as const;

/** Keep a table's centre on the slide, including when it sits against an edge. */
function slideOrigin(
  start: number,
  oldSize: number,
  newSize: number,
  limit: number,
) {
  if (start < 0 || start + oldSize > limit) return start;
  return Math.max(
    0,
    Math.min(limit - newSize, start + (oldSize - newSize) / 2),
  );
}

export function firstChartFrame(
  node: BoardNode,
): Partial<Pick<BoardNode, "width" | "height" | "position">> {
  const defaultTable =
    node.width === DEFAULT_RESULT_SIZE.width &&
    node.height === DEFAULT_RESULT_SIZE.height;
  const implicitSize = node.width === undefined && node.height === undefined;
  if (
    node.data.kind !== "result" ||
    (node.data.view !== undefined && node.data.view !== "table") ||
    node.data.chart ||
    !(defaultTable || implicitSize)
  )
    return {};
  if (!node.slideId) return DEFAULT_CHART_SIZE;
  return {
    ...DEFAULT_CHART_SIZE,
    position: {
      x: slideOrigin(
        node.position.x,
        node.width ?? 480,
        DEFAULT_CHART_SIZE.width,
        PRESENTATION_WIDTH,
      ),
      y: slideOrigin(
        node.position.y,
        node.height ?? 300,
        DEFAULT_CHART_SIZE.height,
        PRESENTATION_HEIGHT,
      ),
    },
  };
}
