// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import BoardFlow from "../src/client/board/BoardFlow";
import ArtifactNode, { BoardActions } from "../src/client/board/ArtifactNode";
import { boardDocumentSchema } from "../src/shared/board-schema";
import {
  createBoardFragment,
  pasteBoardFragment,
} from "../src/client/board/clipboard";
import { duplicatePresentationSlide } from "../src/client/board/presentation-model";
import type { Board, BoardNode } from "../src/shared/types";
const image = {
  id: "a".repeat(64),
  name: "forest.png",
  mimeType: "image/png" as const,
  size: 100,
  alt: "Forest in sunlight",
};
const node: BoardNode = {
  id: "picture",
  type: "artifact",
  position: { x: 20, y: 30 },
  width: 320,
  height: 180,
  data: { kind: "image", title: "Forest", image },
};
let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  "renders an image as a frameless, non-native-draggable canvas item (presentation=%s)",
  async (presentation) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    cleanup = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    const noop = () => {};
    await act(async () =>
      root.render(
        createElement(
          BoardActions.Provider,
          {
            value: {
              boardId: "b",
              editable: true,
              presentation,
              update: noop,
              remove: noop,
              refresh: noop,
              openSource: noop,
              inspect: noop,
              metadata: noop,
              resizeStart: noop,
              resize: noop,
              busy: {},
            },
          },
          createElement(BoardFlow, {
            width: 800,
            height: 600,
            nodeTypes: { artifact: ArtifactNode },
            nodes: [node],
            edges: [],
          }),
        ),
      ),
    );
    const picture = host.querySelector("img");
    expect(picture).not.toBeNull();
    expect(picture!.getAttribute("src")).toBe(`/api/board-images/${image.id}`);
    expect(picture!.alt).toBe(image.alt);
    expect(picture!.draggable).toBe(false);
    expect(host.querySelector(".board-node-header")).toBeNull();
  },
);
it("retains immutable image references across clipboard and slide duplication", () => {
  const board: Board = {
    id: "b",
    name: "B",
    revision: 1,
    updatedAt: "",
    document: { schemaVersion: 1, nodes: [node], edges: [] },
  };
  expect(boardDocumentSchema.safeParse(board.document).success).toBe(true);
  const fragment = createBoardFragment(board, "w", new Set([node.id]))!;
  const pasted = pasteBoardFragment(fragment, board, { x: 400, y: 400 }, 0);
  expect(pasted.document.nodes[1].data.image).toEqual(image);
  const deck = {
    ...board.document,
    kind: "presentation" as const,
    slides: [{ id: "slide", title: "Slide", background: "#ffffff" }],
    nodes: [{ ...node, slideId: "slide" }],
  };
  expect(
    duplicatePresentationSlide(deck, "slide").document.nodes[1].data.image,
  ).toEqual(image);
});
