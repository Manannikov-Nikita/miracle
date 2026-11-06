import { describe, expect, it } from "vitest";
import {
  boardChangedEntities,
  boardValuesEqual,
  mergeBoardDocuments,
} from "../src/shared/board-merge";
import type { BoardDocument, BoardNode } from "../src/shared/types";

const node = (id: string, text = id): BoardNode => ({
  id,
  type: "artifact",
  position: { x: 0, y: 0 },
  data: { kind: "note", title: id, text },
});
const doc = (
  nodes: BoardNode[],
  edges: BoardDocument["edges"] = [],
): BoardDocument => ({ schemaVersion: 1, nodes, edges });

describe("independent board changes", () => {
  it("combines changes to different blocks and preserves both additions", () => {
    const base = doc([node("a"), node("b")]);
    const local = doc([node("a"), node("b", "user"), node("c")]);
    const remote = doc([node("a", "agent"), node("b"), node("d")]);
    const result = mergeBoardDocuments(base, local, remote);
    expect(result.conflicts).toEqual([]);
    expect(
      Object.fromEntries(result.document.nodes.map((n) => [n.id, n.data.text])),
    ).toEqual({ a: "agent", b: "user", c: "c", d: "d" });
  });

  it("reports an actual competing edit without replacing the remote value", () => {
    const result = mergeBoardDocuments(
      doc([node("a")]),
      doc([node("a", "user")]),
      doc([node("a", "agent")]),
    );
    expect(result.conflicts).toEqual([{ kind: "node", id: "a" }]);
    expect(result.document.nodes[0].data.text).toBe("agent");
  });

  it("accepts identical edits and independent deletions", () => {
    const result = mergeBoardDocuments(
      doc([node("a"), node("b"), node("c")]),
      doc([node("a", "same"), node("c")]),
      doc([node("a", "same"), node("b")]),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.document.nodes).toEqual([node("a", "same")]);
  });

  it("rejects deletion of a block with a newly added remote edge", () => {
    const result = mergeBoardDocuments(
      doc([node("a"), node("b")]),
      doc([node("b")]),
      doc([node("a"), node("b")], [{ id: "edge", source: "a", target: "b" }]),
    );
    expect(result.conflicts).toContainEqual({ kind: "node", id: "a" });
    expect(result.document.nodes.map((n) => n.id)).toContain("a");
    expect(result.document.edges).toHaveLength(1);
  });

  it("rejects a local edge to a remotely removed block", () => {
    const result = mergeBoardDocuments(
      doc([node("a"), node("b")]),
      doc([node("a"), node("b")], [{ id: "edge", source: "a", target: "b" }]),
      doc([node("b")]),
    );
    expect(result.conflicts).toContainEqual({ kind: "edge", id: "edge" });
    expect(result.document.edges).toEqual([]);
    expect(result.document.nodes.map((n) => n.id)).toEqual(["b"]);
  });

  it("preserves local draw order while merging a remote content change", () => {
    const result = mergeBoardDocuments(
      doc([node("a"), node("b"), node("c")]),
      doc([node("b"), node("a"), node("c")]),
      doc([node("a"), node("b"), node("c", "agent")]),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.document.nodes.map((n) => n.id)).toEqual(["b", "a", "c"]);
    expect(result.document.nodes[2].data.text).toBe("agent");
  });

  it("reports competing draw orders and retains remote order", () => {
    const result = mergeBoardDocuments(
      doc([node("a"), node("b"), node("c")]),
      doc([node("b"), node("a"), node("c")]),
      doc([node("a"), node("c"), node("b")]),
    );
    expect(result.conflicts).toContainEqual({
      kind: "document",
      id: "nodes.order",
    });
    expect(result.document.nodes.map((n) => n.id)).toEqual(["a", "c", "b"]);
  });

  it("ignores object key order but counts reordered blocks as changed entities", () => {
    expect(boardValuesEqual({ x: 1, y: 2 }, { y: 2, x: 1 })).toBe(true);
    expect(
      boardChangedEntities(
        doc([node("a"), node("b"), node("c")]),
        doc([node("a"), node("c"), node("b")]),
      ),
    ).toEqual({ nodeIds: ["b", "c"], edgeIds: [] });
    expect(
      boardChangedEntities(
        doc([node("a"), node("b")]),
        doc([node("new"), node("a"), node("b")]),
      ),
    ).toEqual({ nodeIds: ["new"], edgeIds: [] });
  });
});
