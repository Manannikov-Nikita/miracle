import { expect, it } from "vitest";
import { boardDocumentSchema } from "../src/shared/board-schema";
import {
  boardChangedEntities,
  mergeBoardDocuments,
} from "../src/shared/board-merge";
import type { BoardDocument } from "../src/shared/types";

const slide = (id: string, title = id) => ({
  id,
  title,
  background: "#ffffff",
});
const node = (id: string, slideId: string, text = id) => ({
  id,
  slideId,
  type: "artifact" as const,
  position: { x: 10, y: 20 },
  data: { title: id, kind: "note" as const, text },
});
const presentation = (
  nodes = [node("n", "a"), node("m", "b")],
): BoardDocument => ({
  schemaVersion: 1,
  kind: "presentation",
  slides: [slide("a"), slide("b")],
  nodes,
  edges: [],
});

it("round-trips slide metadata and free-ended edges in a version one document", () => {
  const doc = presentation();
  doc.edges.push({
    id: "arrow",
    slideId: "a",
    source: "n",
    targetPoint: { x: 40, y: 50 },
  });
  expect(boardDocumentSchema.parse(doc)).toEqual(doc);
});

it("rejects invalid slide membership and cross-slide edges", () => {
  const doc = presentation();
  for (const invalid of [
    { ...doc, slides: [] },
    { ...doc, slides: [slide("a"), slide("a")] },
    { ...doc, slides: Array.from({ length: 101 }, (_, i) => slide(String(i))) },
    { ...doc, nodes: [node("n", "missing")] },
    { ...doc, nodes: [{ ...doc.nodes[0], slideId: undefined }] },
    {
      ...doc,
      edges: [{ id: "arrow", source: "n", target: "m", slideId: "a" }],
    },
    {
      ...doc,
      edges: [
        {
          id: "arrow",
          sourcePoint: { x: 10, y: 20 },
          targetPoint: { x: 30, y: 40 },
        },
      ],
    },
    { ...doc, kind: "board" },
  ]) {
    expect(
      boardDocumentSchema.safeParse(invalid).success,
      JSON.stringify(invalid),
    ).toBe(false);
  }
});

it("merges slide metadata, order and block edits as separate changes", () => {
  const base = presentation();
  const local = { ...base, slides: [slide("b", "Renamed"), slide("a")] };
  const remote = presentation([node("n", "a", "edited"), node("m", "b")]);
  const result = mergeBoardDocuments(base, local, remote);
  expect(result.conflicts).toEqual([]);
  expect(result.document.slides).toEqual([slide("b", "Renamed"), slide("a")]);
  expect(result.document.nodes[0].data.text).toBe("edited");
  expect(boardChangedEntities(base, local)).toMatchObject({
    slideIds: ["b"],
    slidesStructureChanged: true,
  });
});

it("keeps the full remote slide when a local removal races with a remote child addition or edit", () => {
  const base = presentation();
  base.edges = [
    { id: "old", slideId: "a", source: "n", targetPoint: { x: 20, y: 30 } },
  ];
  const local = {
    ...base,
    slides: [slide("b")],
    nodes: [node("m", "b")],
    edges: [],
  };
  for (const remote of [
    { ...base, nodes: [...base.nodes, node("new", "a")] },
    { ...base, nodes: [node("n", "a", "remote edit"), node("m", "b")] },
    { ...base, edges: [...base.edges, { ...base.edges[0], id: "new" }] },
  ]) {
    const result = mergeBoardDocuments(base, local, remote);
    expect(result.conflicts).toContainEqual({ kind: "slide", id: "a" });
    expect(result.document).toEqual(remote);
  }
});

it("keeps a remote slide deletion when the local draft added a child", () => {
  const base = presentation();
  const local = { ...base, nodes: [...base.nodes, node("added", "a")] };
  const remote = { ...base, slides: [slide("b")], nodes: [node("m", "b")] };
  const result = mergeBoardDocuments(base, local, remote);
  expect(result.conflicts).toContainEqual({ kind: "slide", id: "a" });
  expect(result.document).toEqual(remote);
});

it("reports a conflict if independent deletes would remove the last slide", () => {
  const base = presentation();
  const local = { ...base, slides: [slide("b")], nodes: [node("m", "b")] };
  const remote = { ...base, slides: [slide("a")], nodes: [node("n", "a")] };
  const result = mergeBoardDocuments(base, local, remote);
  expect(result.conflicts).toContainEqual({
    kind: "document",
    id: "slides.order",
  });
  expect(result.document).toEqual(remote);
});

it("conflicts with reordering children on the slide being removed", () => {
  const base = presentation([
    node("n", "a"),
    node("second", "a"),
    node("m", "b"),
  ]);
  const local = { ...base, slides: [slide("b")], nodes: [node("m", "b")] };
  const remote = {
    ...base,
    nodes: [node("second", "a"), node("n", "a"), node("m", "b")],
  };
  const result = mergeBoardDocuments(base, local, remote);
  expect(result.conflicts).toContainEqual({ kind: "slide", id: "a" });
  expect(result.document).toEqual(remote);
});

it("merges independent block and edge draw orders on different slides", () => {
  const [a1, a2, b1, b2] = [
    node("a1", "a"),
    node("a2", "a"),
    node("b1", "b"),
    node("b2", "b"),
  ];
  const [ea1, ea2, eb1, eb2] = [a1, a2, b1, b2].map((block) => ({
    id: "edge-" + block.id,
    slideId: block.slideId,
    source: block.id,
    targetPoint: { x: 30, y: 40 },
  }));
  const base = {
    ...presentation([a1, a2, b1, b2]),
    edges: [ea1, ea2, eb1, eb2],
  };
  const local = {
    ...base,
    nodes: [a2, a1, b1, b2],
    edges: [ea2, ea1, eb1, eb2],
  };
  const remote = {
    ...base,
    nodes: [a1, a2, b2, b1],
    edges: [ea1, ea2, eb2, eb1],
  };
  const merged = mergeBoardDocuments(base, local, remote);
  expect(merged.conflicts).toEqual([]);
  expect(merged.document.nodes).toEqual([a2, a1, b2, b1]);
  expect(merged.document.edges).toEqual([ea2, ea1, eb2, eb1]);
});

it("conflicts on competing draw orders for the same slide", () => {
  const [a1, a2, a3, b1] = [
    node("a1", "a"),
    node("a2", "a"),
    node("a3", "a"),
    node("b1", "b"),
  ];
  const base = presentation([a1, a2, a3, b1]);
  const local = { ...base, nodes: [a2, a1, a3, b1] };
  const remote = { ...base, nodes: [a1, a3, a2, b1] };
  const merged = mergeBoardDocuments(base, local, remote);
  expect(merged.conflicts).toEqual([{ kind: "document", id: "nodes.order" }]);
  expect(merged.document.nodes).toEqual(remote.nodes);
});

it("ignores interleaving of slides when detecting blocks and edges that need claims", () => {
  const [a1, b1, a2, b2] = [
    node("a1", "a"),
    node("b1", "b"),
    node("a2", "a"),
    node("b2", "b"),
  ];
  const [ea1, eb1, ea2, eb2] = [a1, b1, a2, b2].map((block) => ({
    id: "edge-" + block.id,
    slideId: block.slideId,
    source: block.id,
    targetPoint: { x: 30, y: 40 },
  }));
  const base = {
    ...presentation([a1, b1, a2, b2]),
    edges: [ea1, eb1, ea2, eb2],
  };
  const local = {
    ...base,
    nodes: [b1, b2, a2, a1],
    edges: [eb1, eb2, ea1, ea2],
  };
  expect(boardChangedEntities(base, local)).toMatchObject({
    nodeIds: ["a1", "a2"],
    edgeIds: [],
    slidesStructureChanged: false,
  });
});
