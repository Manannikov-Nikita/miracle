import { describe, expect, it } from "vitest";
import type { BoardDocument, BoardNode } from "../src/shared/types";
import { toBoardFlow } from "../src/client/board/edge-flow";
import {
  applyBoardNodeChanges,
  toArtifactFlowNode,
} from "../src/client/board/flow-nodes";

const block = (id: string, x: number): BoardNode => ({
  id,
  type: "artifact",
  position: { x, y: 40 },
  width: 480,
  height: 300,
  data: { kind: "note", title: id, text: "Keep this content mounted" },
});

describe("controlled board node identity", () => {
  it("uses the painted line extent as its runtime container without changing the saved frame", () => {
    const line: BoardNode = {
      ...block("line", 10),
      width: 260,
      height: 40,
      data: { title: "Line", kind: "shape", shape: { type: "line" } },
    };
    const rendered = toArtifactFlowNode(line, null);
    expect(rendered.position).toEqual({ x: 12, y: 59 });
    expect(rendered.measured).toEqual({ width: 256, height: 2 });
    expect(rendered.style?.pointerEvents).toBe("none");
    expect(line.position).toEqual({ x: 10, y: 40 });
    expect(line.height).toBe(40);
    const changed = applyBoardNodeChanges(
      [
        {
          id: "line",
          type: "position",
          dragging: true,
          position: { x: 22, y: 84 },
        },
      ],
      [line],
    );
    expect(changed[0].position).toEqual({ x: 20, y: 65 });
    expect(changed[0].height).toBe(40);
    expect(changed[0].data).toBe(line.data);
    expect(toArtifactFlowNode(changed[0], null).position).toEqual({
      x: 22,
      y: 84,
    });
  });

  it("does not save a shape's projected position when a drag finishes without movement", () => {
    const line: BoardNode = {
      ...block("line", 10),
      width: 260,
      height: 40,
      data: {
        title: "Line",
        kind: "shape",
        shape: { type: "line", rotation: 90 },
      },
    };
    const rendered = toArtifactFlowNode(line, null);
    expect(rendered.measured!.width).toBeCloseTo(2);
    expect(rendered.measured!.height).toBeCloseTo(256);
    const nodes = [line];
    expect(
      applyBoardNodeChanges(
        [
          {
            id: "line",
            type: "position",
            dragging: false,
            position: rendered.position,
          },
        ],
        nodes,
      ),
    ).toBe(nodes);
  });

  it("drags a shape by its visible content without requiring an artifact header", () => {
    const shape: BoardNode = {
      ...block("shape", 10),
      data: { title: "Фигура", kind: "shape", shape: { type: "ellipse" } },
    };
    expect(toArtifactFlowNode(shape, null).dragHandle).toBe(
      ".board-shape-content",
    );
  });
  it("only replaces the moving node through a controlled flow update", () => {
    const nodes = [block("moving", 20), block("stationary", 600)];
    const document: BoardDocument = { schemaVersion: 1, nodes, edges: [] };
    const before = toBoardFlow(document, new Set(["moving"]));
    const changed = applyBoardNodeChanges(
      [
        {
          id: "moving",
          type: "position",
          position: { x: 90, y: 60 },
          dragging: true,
        },
      ],
      nodes,
    );
    const after = toBoardFlow(
      { ...document, nodes: changed },
      new Set(["moving"]),
    );

    expect(changed[0]).toEqual({ ...nodes[0], position: { x: 90, y: 60 } });
    expect(changed[1]).toBe(nodes[1]);
    expect(after.nodes[0]).not.toBe(before.nodes[0]);
    expect(after.nodes[0].data).toBe(before.nodes[0].data);
    expect(after.nodes[1]).toBe(before.nodes[1]);
  });

  it("does not turn selection, drag completion, or DOM measurements into document edits", () => {
    const nodes = [block("block", 20)];
    const changed = applyBoardNodeChanges(
      [
        { id: "block", type: "select", selected: true },
        {
          id: "block",
          type: "position",
          position: { x: 20, y: 40 },
          dragging: false,
        },
        {
          id: "block",
          type: "dimensions",
          dimensions: { width: 480, height: 300 },
        },
      ],
      nodes,
    );
    expect(changed).toBe(nodes);
    expect(applyBoardNodeChanges([], nodes)).toBe(nodes);
  });

  it("updates selected state without invalidating other cards", () => {
    const nodes = [block("first", 20), block("second", 600)];
    const document: BoardDocument = { schemaVersion: 1, nodes, edges: [] };
    const before = toBoardFlow(document, new Set());
    const selected = toBoardFlow(document, new Set(["first"]));
    expect(selected.nodes[0]).toMatchObject({ selected: true });
    expect(selected.nodes[0]).not.toBe(before.nodes[0]);
    expect(selected.nodes[1]).toBe(before.nodes[1]);
    expect(toBoardFlow(document, new Set()).nodes[0]).toBe(before.nodes[0]);
  });

  it("keeps resize and content changes visible while preserving siblings", () => {
    const nodes = [block("changed", 20), block("stationary", 600)];
    const before = toArtifactFlowNode(nodes[0], null);
    const resized = applyBoardNodeChanges(
      [
        {
          id: "changed",
          type: "dimensions",
          dimensions: { width: 570, height: 380 },
          setAttributes: true,
          resizing: true,
        },
      ],
      nodes,
    );
    expect(resized[0]).toEqual({ ...nodes[0], width: 570, height: 380 });
    expect(resized[1]).toBe(nodes[1]);
    const after = toArtifactFlowNode(resized[0], null);
    expect(after).not.toBe(before);
    expect(after.measured).toEqual({ width: 570, height: 380 });
    expect(after.style).toEqual({ width: 570, height: 380 });
    const edited = {
      ...resized[0],
      data: { ...resized[0].data, text: "Edited" },
    };
    expect(toArtifactFlowNode(edited, null).data.text).toBe("Edited");
    expect(toArtifactFlowNode(edited, null)).not.toBe(after);
  });

  it("preserves untouched nodes when adding, removing, and replacing cards", () => {
    const nodes = [block("first", 20), block("second", 600)];
    const inserted = block("inserted", 1200);
    const replacement = {
      ...nodes[0],
      data: { ...nodes[0].data, title: "Replacement" },
    };
    const changed = applyBoardNodeChanges(
      [
        { type: "replace", id: "first", item: replacement },
        { type: "add", item: inserted, index: 1 },
      ],
      nodes,
    );
    expect(changed.map((node) => node.id)).toEqual([
      "first",
      "inserted",
      "second",
    ]);
    expect(changed[0].data.title).toBe("Replacement");
    expect(changed[2]).toBe(nodes[1]);
    const removed = applyBoardNodeChanges(
      [{ type: "remove", id: "first" }],
      changed,
    );
    expect(removed).toEqual([inserted, nodes[1]]);
    expect(removed[1]).toBe(nodes[1]);
  });

  it("does not reuse a cached card from a different board with the same id", () => {
    const first = block("same-id", 20);
    const second = {
      ...block("same-id", 600),
      data: { kind: "note" as const, title: "Other board" },
    };
    const a = toArtifactFlowNode(first, null);
    const b = toArtifactFlowNode(second, null);
    expect(b).not.toBe(a);
    expect(b.position).toEqual({ x: 600, y: 40 });
    expect(b.data.title).toBe("Other board");
  });
});
