import { z } from "zod";
import { boardDocumentSchema } from "../../shared/board-schema";
import {
  PRESENTATION_WIDTH,
  PRESENTATION_HEIGHT,
} from "../../shared/presentation";
import { validateCanvasInsertion } from "./presentation-model";
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
    slideId: z.string().min(1).max(200).optional(),
    document: boardDocumentSchema,
  })
  .strict();
export type BoardFragment = z.infer<typeof fragmentSchema>;
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

export function createBoardFragment(
  board: Board,
  workspaceId: string,
  selected: ReadonlySet<string>,
  slideId?: string,
): BoardFragment | null {
  const nodes = board.document.nodes
    .filter((node) => node.slideId === slideId && selected.has(node.id))
    .map(({ slideId: _, ...node }) => node);
  if (!nodes.length) return null;
  const ids = new Set(nodes.map((node) => node.id));
  return {
    version: 1,
    copyId: crypto.randomUUID(),
    workspaceId,
    boardId: board.id,
    slideId,
    document: {
      schemaVersion: 1,
      nodes,
      edges: board.document.edges
        .filter(
          (edge) =>
            edge.source &&
            edge.target &&
            ids.has(edge.source) &&
            ids.has(edge.target),
        )
        .map(({ slideId: _, ...edge }) => edge),
    },
  };
}

export function writeBoardClipboard(
  clipboard: ClipboardData,
  fragment: BoardFragment,
) {
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
}

export function copyBoardSelection(
  clipboard: ClipboardData,
  board: Board,
  workspaceId: string,
  selected: ReadonlySet<string>,
  slideId?: string,
) {
  const fragment = createBoardFragment(board, workspaceId, selected, slideId);
  if (!fragment) return false;
  writeBoardClipboard(clipboard, fragment);
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
  destination?: { slideId?: string; placement?: "center" | "pointer" },
) {
  const source = fragment.document;
  const slideId = destination?.slideId;
  if (
    board.document.kind === "presentation" &&
    !board.document.slides?.some((slide) => slide.id === slideId)
  )
    throw new Error("Слайд для вставки удалён.");
  const left = Math.min(...source.nodes.map((node) => node.position.x));
  const top = Math.min(...source.nodes.map((node) => node.position.y));
  const right = Math.max(
    ...source.nodes.map((node) => node.position.x + (node.width ?? 480)),
  );
  const bottom = Math.max(
    ...source.nodes.map((node) => node.position.y + (node.height ?? 300)),
  );
  const margin = 32;
  const width = right - left;
  const height = bottom - top;
  const scale = slideId
    ? Math.min(
        1,
        (PRESENTATION_WIDTH - 2 * margin) / width,
        (PRESENTATION_HEIGHT - 2 * margin) / height,
      )
    : 1;
  const sameCanvas =
    fragment.boardId === board.id && fragment.slideId === slideId;
  const base =
    sameCanvas && !destination?.placement
      ? { x: left + 32, y: top + 32 }
      : {
          x: center.x - (width * scale) / 2,
          y: center.y - (height * scale) / 2,
        };
  // An oversized group is scaled uniformly and kept within the slide.
  const clamp = (value: number, end: number) =>
    Math.max(margin, Math.min(value, end));
  const offset = (index: number) => {
    const x = base.x + index * 32;
    const y = base.y + index * 32;
    return scale < 1
      ? {
          x: clamp(x, PRESENTATION_WIDTH - margin - width * scale),
          y: clamp(y, PRESENTATION_HEIGHT - margin - height * scale),
        }
      : { x, y };
  };
  const existingPositions = new Set(
    board.document.nodes
      .filter((node) => node.slideId === slideId)
      .map((node) => `${node.position.x}:${node.position.y}`),
  );
  let index = pasteIndex;
  if (scale === 1 && !destination?.placement)
    while (
      source.nodes.some((node) =>
        existingPositions.has(
          `${node.position.x - left + offset(index).x}:${node.position.y - top + offset(index).y}`,
        ),
      )
    )
      index++;
  const origin = offset(index);
  const ids = new Map(
    source.nodes.map((node) => [node.id, crypto.randomUUID()]),
  );
  const nodes = source.nodes.map((node) => ({
    ...structuredClone(node),
    id: ids.get(node.id)!,
    slideId,
    position: {
      x: origin.x + (node.position.x - left) * scale,
      y: origin.y + (node.position.y - top) * scale,
    },
    width: scale === 1 ? node.width : (node.width ?? 480) * scale,
    height: scale === 1 ? node.height : (node.height ?? 300) * scale,
  }));
  const edges = source.edges.map((edge) => ({
    ...structuredClone(edge),
    id: crypto.randomUUID(),
    slideId,
    bend: edge.bend && { x: edge.bend.x * scale, y: edge.bend.y * scale },
    source: ids.get(edge.source!)!,
    target: ids.get(edge.target!)!,
  }));
  const document: BoardDocument = {
    ...board.document,
    nodes: [...board.document.nodes, ...nodes],
    edges: [...board.document.edges, ...edges],
  };
  validateCanvasInsertion(document);
  return { document, ids: new Set(ids.values()), nextIndex: index + 1 };
}
