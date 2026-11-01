import type { BoardDocument } from "../../shared/types";

type BoardViewport = NonNullable<BoardDocument["viewport"]>;
const viewportKey = (workspaceId: string, boardId: string) =>
  `miracle:board-viewport:${workspaceId}:${boardId}`;

export function readBoardViewport(
  workspaceId: string,
  boardId: string,
): BoardViewport | undefined {
  try {
    const value = JSON.parse(
      localStorage.getItem(viewportKey(workspaceId, boardId)) ?? "null",
    );
    if (
      value &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.zoom) &&
      value.zoom > 0
    )
      return { x: value.x, y: value.y, zoom: value.zoom };
  } catch {}
}

export function saveBoardViewport(
  workspaceId: string,
  boardId: string,
  viewport: BoardViewport,
) {
  // Camera preferences never enter document drafts, revisions or sync events.
  try {
    localStorage.setItem(
      viewportKey(workspaceId, boardId),
      JSON.stringify(viewport),
    );
  } catch {}
}
