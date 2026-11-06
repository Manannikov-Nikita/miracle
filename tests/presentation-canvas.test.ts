import { describe, expect, it } from "vitest";
import {
  containsBoardChanges,
  protectBoardChanges,
} from "../src/client/board/agent-work";
import type { AgentEntityWork } from "../src/shared/agent-work";
import type { Board, BoardNode } from "../src/shared/types";
import {
  createBoardFragment,
  pasteBoardFragment,
  readBoardClipboard,
  writeBoardClipboard,
} from "../src/client/board/clipboard";
import {
  duplicatePresentationSlide,
  presentationSlideContent,
  removePresentationSlide,
} from "../src/client/board/presentation-model";

const note = (id: string, x: number, slideId?: string): BoardNode => ({
  id,
  type: "artifact",
  slideId,
  position: { x, y: 50 },
  width: 400,
  height: 200,
  data: { kind: "note", title: id, text: "Context" },
});
const deck = (): Board => ({
  id: "deck",
  name: "Deck",
  revision: 1,
  updatedAt: "",
  document: {
    schemaVersion: 1,
    kind: "presentation",
    slides: [
      { id: "slide-a", title: "First", background: "#ffffff" },
      { id: "slide-b", title: "Second", background: "#aabbcc" },
    ],
    nodes: [
      note("a", 0, "slide-a"),
      note("b", 3000, "slide-a"),
      note("c", 50, "slide-b"),
    ],
    edges: [
      {
        id: "ab",
        source: "a",
        target: "b",
        slideId: "slide-a",
        label: "Internal",
      },
      {
        id: "free",
        sourcePoint: { x: 10, y: 10 },
        targetPoint: { x: 20, y: 20 },
        slideId: "slide-a",
      },
    ],
  },
});
describe("presentation canvas documents", () => {
  it("preserves editable shape content and styling when copied from a board and duplicated on a slide", () => {
    const source: Board = {
      ...deck(),
      id: "shape-board",
      document: {
        schemaVersion: 1,
        nodes: [
          {
            ...note("shape", 100),
            data: {
              kind: "shape",
              title: "Решение",
              text: "Продолжаем?\nДа / Нет",
              shape: {
                type: "diamond",
                fill: "#fef3c7",
                strokeStyle: "dashed",
                bold: true,
                fontSize: 32,
              },
            },
          },
        ],
        edges: [],
      },
    };
    const before = structuredClone(source);
    const fragment = createBoardFragment(
      source,
      "project",
      new Set(["shape"]),
    )!;
    const clipboard = new Map<string, string>();
    const transfer = {
      getData: (key: string) => clipboard.get(key) ?? "",
      setData: (key: string, value: string) => {
        clipboard.set(key, value);
      },
    };
    writeBoardClipboard(transfer, fragment);
    const pasted = pasteBoardFragment(
      readBoardClipboard(transfer)!,
      deck(),
      { x: 800, y: 450 },
      0,
      { slideId: "slide-b", placement: "center" },
    );
    const copy = pasted.document.nodes.find((node) => pasted.ids.has(node.id))!;
    expect(copy.id).not.toBe("shape");
    expect(copy.slideId).toBe("slide-b");
    expect(copy.data).toEqual(source.document.nodes[0].data);
    const duplicated = duplicatePresentationSlide(pasted.document, "slide-b");
    const duplicate = duplicated.document.nodes.find(
      (node) =>
        node.slideId === duplicated.slide.id && node.data.kind === "shape",
    )!;
    expect(duplicate.id).not.toBe(copy.id);
    expect(duplicate.data).toEqual(copy.data);
    expect(source).toEqual(before);
    const edited = structuredClone(pasted.document);
    edited.nodes.find((node) => node.id === copy.id)!.data.text = "Изменено";
    const locks = [
      { target: { kind: "board-node", boardId: "deck", id: copy.id } },
    ] as AgentEntityWork[];
    expect(
      protectBoardChanges("deck", pasted.document, edited, locks).nodes.find(
        (node) => node.id === copy.id,
      )?.data,
    ).toEqual(copy.data);
  });
  it("copies a slide fragment through the clipboard with fresh identities and bounded placement", () => {
    const source = deck();
    const snapshot = structuredClone(source);
    const copied = createBoardFragment(
      source,
      "project",
      new Set(["a", "b"]),
      "slide-a",
    )!;
    const values = new Map<string, string>();
    const clipboard = {
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => {
        values.set(type, value);
      },
    };
    writeBoardClipboard(clipboard, copied);
    const fragment = readBoardClipboard(clipboard)!;
    const pasted = pasteBoardFragment(fragment, source, { x: 800, y: 450 }, 0, {
      slideId: "slide-b",
      placement: "center",
    });
    const nodes = pasted.document.nodes.filter((node) =>
      pasted.ids.has(node.id),
    );
    expect(nodes.map((node) => node.slideId)).toEqual(["slide-b", "slide-b"]);
    expect(
      nodes.every(
        (node) =>
          node.position.x >= 32 && node.position.x + node.width! <= 1568,
      ),
    ).toBe(true);
    expect(nodes[0].data).toEqual(source.document.nodes[0].data);
    expect(pasted.ids.has("a")).toBe(false);
    expect(pasted.document.edges.at(-1)).toMatchObject({
      source: nodes[0].id,
      target: nodes[1].id,
      slideId: "slide-b",
      label: "Internal",
    });
    expect(source).toEqual(snapshot);
  });

  it("duplicates slide metadata and its free and attached arrows at the original coordinates", () => {
    const source = deck().document;
    const result = duplicatePresentationSlide(source, "slide-a");
    const copy = presentationSlideContent(result.document, result.slide.id);
    expect(result.document.slides?.map((slide) => slide.id)).toEqual([
      "slide-a",
      result.slide.id,
      "slide-b",
    ]);
    expect(result.slide.background).toBe("#ffffff");
    expect(copy.nodes.map((node) => node.position)).toEqual(
      source.nodes.slice(0, 2).map((node) => node.position),
    );
    expect(copy.edges).toMatchObject([
      { source: copy.nodes[0].id, target: copy.nodes[1].id },
      { sourcePoint: { x: 10, y: 10 }, targetPoint: { x: 20, y: 20 } },
    ]);
  });

  it("removes exactly one slide and prevents deleting the final slide", () => {
    const remaining = removePresentationSlide(deck().document, "slide-a");
    expect(remaining.nodes.map((node) => node.id)).toEqual(["c"]);
    expect(remaining.edges).toEqual([]);
    expect(() => removePresentationSlide(remaining, "slide-b")).toThrow();
  });

  it("protects a claimed slide deletion while applying disjoint block edits", () => {
    const base = deck().document;
    const next = removePresentationSlide(base, "slide-a");
    next.nodes = next.nodes.map((node) => ({
      ...node,
      position: { x: 72, y: 50 },
    }));
    const locks = [
      { target: { kind: "board-slide", boardId: "deck", id: "slide-a" } },
    ] as AgentEntityWork[];
    const protectedDoc = protectBoardChanges("deck", base, next, locks);
    expect(protectedDoc.slides).toEqual(base.slides);
    expect(protectedDoc.nodes.map((node) => node.position.x)).toEqual([
      0, 3000, 72,
    ]);
    expect(protectedDoc.edges).toEqual(base.edges);
  });

  it("requires slide changes to match before accepting a save echo", () => {
    const base = deck().document;
    const sent = { ...base, slides: [...base.slides!].reverse() };
    expect(containsBoardChanges(base, sent, base)).toBe(false);
    expect(containsBoardChanges(base, sent, sent)).toBe(true);
    const renamed = {
      ...base,
      slides: base.slides!.map((slide) => ({ ...slide, title: "New title" })),
    };
    expect(containsBoardChanges(base, renamed, base)).toBe(false);
  });
});
