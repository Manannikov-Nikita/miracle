// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ConnectionMode,
  MiniMap,
  Position,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import BoardFlow from "../src/client/board/BoardFlow";
import type { BoardFlowEdge } from "../src/client/board/BoardEdgeView";
import type { ArtifactFlowNode } from "../src/client/board/ArtifactNode";
import { toBoardFlow } from "../src/client/board/edge-flow";
import type { BoardDocument, BoardNode } from "../src/shared/types";

type Coordinates = Pick<
  EdgeProps<BoardFlowEdge>,
  | "sourceX"
  | "sourceY"
  | "targetX"
  | "targetY"
  | "sourcePosition"
  | "targetPosition"
>;
const rendered = new Map<string, Coordinates>();
function ProbeEdge(props: EdgeProps<BoardFlowEdge>) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  } = props;
  rendered.set(id, {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return createElement("path", {
    "data-testid": `line-${id}`,
    d: `M${sourceX},${sourceY} L${targetX},${targetY}`,
  });
}
const nodeTypes = {
  artifact: ({ data }: NodeProps<ArtifactFlowNode>) =>
    createElement("div", null, data.title),
  "edge-anchor": () => null,
};
const edgeTypes = { board: ProbeEdge };
const block: BoardNode = {
  id: "block",
  type: "artifact",
  position: { x: 100, y: 200 },
  width: 120,
  height: 80,
  data: { kind: "note", title: "Visible block" },
};

describe("board free endpoints through real React Flow", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onError = vi.fn();
  beforeEach(() => {
    rendered.clear();
    onError.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // jsdom has no layout; supply the platform observer, not XYFlow internals.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON() {},
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(document: BoardDocument) {
    const flow = toBoardFlow(document, new Set());
    // Visible blocks use XYFlow's public SSR geometry contract too; this avoids
    // inventing DOM measurements for handles in a layout-free environment.
    const nodes = flow.nodes.map((node) =>
      node.type === "artifact"
        ? {
            ...node,
            handles: [
              {
                id: "right",
                type: "source" as const,
                position: Position.Right,
                x: 120,
                y: 40,
                width: 0,
                height: 0,
              },
              {
                id: "left",
                type: "source" as const,
                position: Position.Left,
                x: 0,
                y: 40,
                width: 0,
                height: 0,
              },
            ],
          }
        : node,
    );
    const edges: BoardFlowEdge[] = flow.edges.map(
      ({ edge, source, target }) => ({
        id: edge.id,
        source,
        target,
        sourceHandle: edge.sourceHandle ?? "right",
        targetHandle: edge.targetHandle ?? "left",
        type: "board",
      }),
    );
    await act(async () =>
      root.render(
        createElement(
          BoardFlow,
          {
            gestureScope: "board",
            width: 800,
            height: 600,
            nodes,
            edges,
            nodeTypes,
            edgeTypes,
            connectionMode: ConnectionMode.Loose,
            onError,
          },
          createElement(MiniMap),
        ),
      ),
    );
  }

  it("renders a free-only board at exact points without visible anchor nodes", async () => {
    const document: BoardDocument = {
      schemaVersion: 1,
      nodes: [],
      edges: [
        {
          id: "free",
          sourcePoint: { x: -20.5, y: 30.25 },
          targetPoint: { x: 325.75, y: 180.5 },
          sourceHandle: "bottom",
          targetHandle: "top",
        },
      ],
    };
    await render(document);
    expect(rendered.get("free")).toEqual({
      sourceX: -20.5,
      sourceY: 30.25,
      targetX: 325.75,
      targetY: 180.5,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    });
    expect(host.querySelectorAll(".react-flow__edge")).toHaveLength(1);
    expect(host.querySelectorAll(".react-flow__node")).toHaveLength(0);
    expect(host.querySelectorAll(".react-flow__minimap-node")).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();

    await render({
      ...document,
      edges: [{ ...document.edges[0], targetPoint: { x: 400, y: -50 } }],
    });
    expect(rendered.get("free")).toMatchObject({ targetX: 400, targetY: -50 });
    expect(host.querySelectorAll(".react-flow__edge")).toHaveLength(1);
  });

  it("renders attached/free ends in either direction without adding visible blocks", async () => {
    await render({
      schemaVersion: 1,
      nodes: [block],
      edges: [
        {
          id: "outgoing",
          source: block.id,
          targetPoint: { x: 450, y: 300 },
        },
        {
          id: "incoming",
          sourcePoint: { x: -80, y: 90 },
          target: block.id,
        },
      ],
    });
    expect(rendered.get("outgoing")).toMatchObject({
      sourceX: 220,
      sourceY: 240,
      targetX: 450,
      targetY: 300,
    });
    expect(rendered.get("incoming")).toMatchObject({
      sourceX: -80,
      sourceY: 90,
      targetX: 100,
      targetY: 240,
    });
    expect(host.querySelectorAll(".react-flow__edge")).toHaveLength(2);
    expect(host.querySelectorAll(".react-flow__node")).toHaveLength(1);
    expect(host.querySelectorAll(".react-flow__minimap-node")).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps generated IDs stable and distinct from user block IDs without mutating the document", () => {
    const document: BoardDocument = {
      schemaVersion: 1,
      nodes: [{ ...block, id: "__edge-anchor:free:source" }],
      edges: [
        {
          id: "free",
          sourcePoint: { x: 10, y: 20 },
          targetPoint: { x: 50, y: 60 },
        },
      ],
    };
    const original = structuredClone(document);
    const first = toBoardFlow(document, new Set());
    const second = toBoardFlow(document, new Set());
    expect(first.edges.map(({ source, target }) => [source, target])).toEqual(
      second.edges.map(({ source, target }) => [source, target]),
    );
    expect(first.edges[0].source).not.toBe(document.nodes[0].id);
    expect(new Set(first.nodes.map((node) => node.id)).size).toBe(3);
    expect(document).toEqual(original);
  });
});
