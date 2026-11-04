import { z } from "zod";
import { boardDocumentSchema } from "../../shared/board-schema";
import { CUSTOM_CHART_LIMITS } from "../../shared/custom-charts";
import type { Board, BoardDocument } from "../../shared/types";

export const BOARD_CLIPBOARD_MIME = "application/x-miracle-board+json";
const TEXT_PREFIX = "MIRACLE_BOARD_V1\n";
const MAX_BYTES = 2 * 1024 * 1024;
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const fragmentSchema = z
  .object({
    version: z.literal(1),
    copyId: z.uuid(),
    workspaceId: z.string().min(1).max(200),
    boardId: z.string().min(1).max(200),
    document: boardDocumentSchema,
  })
  .strict();
type BoardFragment = z.infer<typeof fragmentSchema>;
type ClipboardData = Pick<DataTransfer, "getData" | "setData">;

export function nativeBoardClipboardTarget(target: EventTarget | null) {
  return (
    (target instanceof Element &&
      !!target.closest(
        'input,textarea,[contenteditable]:not([contenteditable="false"]),.monaco-editor,.cm-editor,[role="textbox"]',
      )) ||
    !!window.getSelection()?.toString()
  );
}

export function copyBoardSelection(
  clipboard: ClipboardData,
  board: Board,
  workspaceId: string,
  selected: ReadonlySet<string>,
) {
  const nodes = board.document.nodes.filter((node) => selected.has(node.id));
  if (!nodes.length) return false;
  const ids = new Set(nodes.map((node) => node.id));
  const fragment: BoardFragment = {
    version: 1,
    copyId: crypto.randomUUID(),
    workspaceId,
    boardId: board.id,
    document: {
      schemaVersion: 1,
      nodes,
      edges: board.document.edges.filter(
        (edge) =>
          edge.source &&
          edge.target &&
          ids.has(edge.source) &&
          ids.has(edge.target),
      ),
    },
  };
  const raw = JSON.stringify(fragment);
  if (byteLength(raw) > MAX_BYTES)
    throw new Error("Слишком много данных для буфера. Выделите меньше блоков.");
  // Text fallback survives browsers/OS clipboard bridges that strip custom MIME.
  clipboard.setData("text/plain", TEXT_PREFIX + raw);
  try {
    clipboard.setData(BOARD_CLIPBOARD_MIME, raw);
  } catch {
    /* Text fallback remains usable. */
  }
  return true;
}

export function readBoardClipboard(
  clipboard: ClipboardData,
): BoardFragment | null {
  const custom = clipboard.getData(BOARD_CLIPBOARD_MIME);
  const text = custom ? "" : clipboard.getData("text/plain");
  const raw =
    custom ||
    (text.startsWith(TEXT_PREFIX) ? text.slice(TEXT_PREFIX.length) : "");
  if (!raw || raw.length > MAX_BYTES || byteLength(raw) > MAX_BYTES)
    return null;
  try {
    const parsed = fragmentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !parsed.data.document.nodes.length) return null;
    const ids = new Set(parsed.data.document.nodes.map((node) => node.id));
    // A node fragment only contains links wholly inside its selection.
    if (
      parsed.data.document.edges.some(
        (edge) =>
          !edge.source ||
          !edge.target ||
          !ids.has(edge.source) ||
          !ids.has(edge.target),
      )
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function pasteBoardFragment(
  fragment: BoardFragment,
  board: Board,
  center: { x: number; y: number },
  pasteIndex: number,
) {
  const source = fragment.document;
  if (source.nodes.length + board.document.nodes.length > 200)
    throw new Error("На доске может быть не больше 200 блоков.");
  if (source.edges.length + board.document.edges.length > 500)
    throw new Error("На доске может быть не больше 500 связей.");
  const left = Math.min(...source.nodes.map((node) => node.position.x));
  const top = Math.min(...source.nodes.map((node) => node.position.y));
  const right = Math.max(
    ...source.nodes.map((node) => node.position.x + (node.width ?? 480)),
  );
  const bottom = Math.max(
    ...source.nodes.map((node) => node.position.y + (node.height ?? 300)),
  );
  const sameBoard = fragment.boardId === board.id;
  const base = sameBoard
    ? { x: 32, y: 32 }
    : { x: center.x - (left + right) / 2, y: center.y - (top + bottom) / 2 };
  const existingPositions = new Set(
    board.document.nodes.map((node) => `${node.position.x}:${node.position.y}`),
  );
  let index = pasteIndex;
  while (
    source.nodes.some((node) =>
      existingPositions.has(
        `${node.position.x + base.x + index * 32}:${node.position.y + base.y + index * 32}`,
      ),
    )
  )
    index++;
  const delta = { x: base.x + index * 32, y: base.y + index * 32 };
  const ids = new Map(
    source.nodes.map((node) => [node.id, crypto.randomUUID()]),
  );
  const nodes = source.nodes.map((node) => ({
    ...structuredClone(node),
    id: ids.get(node.id)!,
    position: { x: node.position.x + delta.x, y: node.position.y + delta.y },
  }));
  const edges = source.edges.map((edge) => ({
    ...structuredClone(edge),
    id: crypto.randomUUID(),
    source: ids.get(edge.source!)!,
    target: ids.get(edge.target!)!,
  }));
  const document: BoardDocument = {
    ...board.document,
    nodes: [...board.document.nodes, ...nodes],
    edges: [...board.document.edges, ...edges],
  };
  if (!boardDocumentSchema.safeParse(document).success)
    throw new Error("Не удалось вставить блоки в этой области доски.");
  const size = byteLength(JSON.stringify(document));
  if (
    size > MAX_BYTES - 1024 ||
    (document.nodes.some((node) => node.data.customChart) &&
      size > CUSTOM_CHART_LIMITS.boardBytes)
  )
    throw new Error("На доске слишком много данных для вставки этих блоков.");
  return { document, ids: new Set(ids.values()), nextIndex: index + 1 };
}
