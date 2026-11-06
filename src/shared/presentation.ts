import type { BoardDocument, BoardKind } from "./types.js";

export const PRESENTATION_WIDTH = 1600;
export const PRESENTATION_HEIGHT = 900;
export const PRESENTATION_MAX_SLIDES = 100;
export const PRESENTATION_BACKGROUND = "#ffffff";

export function boardKind(document: Pick<BoardDocument, "kind">): BoardKind {
  return document.kind ?? "board";
}

export function emptyPresentationDocument(): BoardDocument {
  return {
    schemaVersion: 1,
    kind: "presentation",
    slides: [
      {
        id: crypto.randomUUID(),
        title: "Слайд 1",
        background: PRESENTATION_BACKGROUND,
      },
    ],
    nodes: [],
    edges: [],
  };
}
