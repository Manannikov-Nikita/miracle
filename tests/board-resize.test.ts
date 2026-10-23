import { describe, expect, it } from "vitest";
import { adoptUserNodes, type NodeLookup } from "@xyflow/system";
import type { BoardNode } from "../src/shared/types";
import {
  applyBoardNodeChanges,
  toArtifactFlowNode,
} from "../src/client/board/flow-nodes";

const node: BoardNode = {
  id: "chart",
  type: "artifact",
  position: { x: 80, y: 80 },
  width: 540,
  height: 350,
  data: { kind: "result", title: "Chart", view: "chart" },
};

describe("board resize geometry", () => {
  it.each([null, "chart"])(
    "keeps the measured starting size across controlled renders (selection %s)",
    (selected) => {
      const lookup: NodeLookup = new Map();
      const parents = new Map();
      adoptUserNodes([toArtifactFlowNode(node, null)], lookup, parents);
      // The initial DOM observation has already measured the fixed-size node.
      lookup.get(node.id)!.measured = { width: 540, height: 350 };
      // Selection and metadata updates both recreate the controlled node object.
      adoptUserNodes([toArtifactFlowNode(node, selected)], lookup, parents);
      const measured = lookup.get(node.id)!.measured;
      expect({
        width: measured.width ?? 0,
        height: measured.height ?? 0,
      }).toEqual({
        width: 540,
        height: 350,
      });
    },
  );

  it("uses the displayed default size before the first DOM measurement", () => {
    const { width: _, height: __, ...unsized } = node;
    expect(toArtifactFlowNode(unsized, node.id).measured).toEqual({
      width: 480,
      height: 300,
    });
  });

  it("keeps resized geometry after reload and restores the starting geometry on undo", () => {
    const [resized] = applyBoardNodeChanges(
      [
        {
          id: node.id,
          type: "dimensions",
          dimensions: { width: 570, height: 380 },
          setAttributes: true,
          resizing: true,
        },
      ],
      [node],
    );
    const reloaded = JSON.parse(JSON.stringify(resized)) as BoardNode;
    expect(toArtifactFlowNode(reloaded, node.id).measured).toEqual({
      width: 570,
      height: 380,
    });
    expect(toArtifactFlowNode(node, node.id).measured).toEqual({
      width: 540,
      height: 350,
    });
  });

  it("does not store transient ReactFlow resize state in the board document", () => {
    const [resized] = applyBoardNodeChanges(
      [
        {
          id: node.id,
          type: "dimensions",
          dimensions: { width: 570, height: 380 },
          setAttributes: true,
          resizing: true,
        },
      ],
      [node],
    );
    expect(resized).toEqual({ ...node, width: 570, height: 380 });
  });
});
