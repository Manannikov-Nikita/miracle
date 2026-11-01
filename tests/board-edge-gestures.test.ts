// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Position } from "@xyflow/react";
import BoardEdgeView, {
  type BoardEdgeViewData,
} from "../src/client/board/BoardEdgeView";
import type { BoardEdge } from "../src/shared/types";

const flow = vi.hoisted(() => ({ nodes: [] as any[] }));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return {
    ...actual,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) =>
      createPortal(children, document.body),
    useViewport: () => ({ x: 100, y: 50, zoom: 2 }),
    useStore: (select: (state: unknown) => unknown) =>
      select({ width: 1000, height: 700 }),
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
        x: (x - 100) / 2,
        y: (y - 50) / 2,
      }),
      getNodes: () => flow.nodes,
      getInternalNode: (id: string) =>
        flow.nodes.find((node) => node.id === id),
    }),
  };
});

describe("board arrow gestures", () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: any[];
  let nextOwnerChanges: any[];
  let external: (patch: Partial<BoardEdge>) => void;
  let switchOwner: (scope: string) => void;
  const initial: BoardEdge = {
    id: "edge",
    source: "a",
    target: "b",
    label: "Связь",
    appearance: { path: "straight" },
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    changes = [];
    nextOwnerChanges = [];
    flow.nodes = [];
    // jsdom has no SVG geometry API. This fixture is the exact measured
    // straight segment rendered by XYFlow, with world-space arc length.
    Object.defineProperty(SVGElement.prototype, "getTotalLength", {
      configurable: true,
      value() {
        return 500;
      },
    });
    Object.defineProperty(SVGElement.prototype, "getPointAtLength", {
      configurable: true,
      value(distance: number) {
        return { x: 100 + distance, y: 200 };
      },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (SVGElement.prototype as any).getTotalLength;
    delete (SVGElement.prototype as any).getPointAtLength;
    vi.unstubAllGlobals();
  });
  async function render(editable = true) {
    function Harness() {
      const [edge, setEdge] = useState(initial);
      const [editing, setEditing] = useState(false);
      const [owner, setOwner] = useState({
        scope: "workspace:board-a",
        changed: false,
      });
      switchOwner = (scope) => setOwner({ scope, changed: true });
      external = (patch) => setEdge((old) => ({ ...old, ...patch }));
      const data: BoardEdgeViewData = {
        edge,
        editable,
        editing,
        gestureScope: owner.scope,
        onEdit: () => setEditing(true),
        onFinishEdit: () => setEditing(false),
        onChange: (patch) => {
          changes.push(patch);
          external(patch);
        },
        onGeometryChange: (patch, expected) => {
          (owner.changed ? nextOwnerChanges : changes).push({
            patch,
            expected,
          });
          external(patch);
        },
        onClose: () => {},
        onDelete: () => {},
      };
      return createElement(
        "svg",
        null,
        createElement(BoardEdgeView, {
          id: "edge",
          source: edge.source ?? "free-source",
          target: edge.target ?? "free-target",
          sourceX: edge.sourcePoint?.x ?? 100,
          sourceY: edge.sourcePoint?.y ?? 200,
          targetX: edge.targetPoint?.x ?? 600,
          targetY: edge.targetPoint?.y ?? 200,
          sourcePosition: (edge.sourceHandle as Position) ?? Position.Right,
          targetPosition: (edge.targetHandle as Position) ?? Position.Left,
          selected: true,
          data,
        }),
      );
    }
    await act(async () => root.render(createElement(Harness)));
  }
  const line = () =>
    host.querySelector<SVGPathElement>(".react-flow__edge-interaction")!;
  const visiblePath = () =>
    host.querySelector<SVGPathElement>(".react-flow__edge-path")!;
  const endpoint = (name: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  async function pointer(
    target: EventTarget,
    type: string,
    x: number,
    y: number,
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    await act(async () => target.dispatchEvent(event));
  }
  it("previews translation in world coordinates and detaches both ends only on release", async () => {
    await render();
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 820, 490);
    expect(changes).toEqual([]);
    expect(visiblePath().getAttribute("d")).toBe("M 110,220L 610,220");
    await pointer(window, "pointerup", 820, 490);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      expected: initial,
      patch: {
        source: undefined,
        target: undefined,
        sourcePoint: { x: 110, y: 220 },
        targetPoint: { x: 610, y: 220 },
        sourceHandle: "right",
        targetHandle: "left",
      },
    });
  });
  it("does not turn a click or tiny pointer jitter into a document edit", async () => {
    await render();
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 801, 451);
    await pointer(window, "pointerup", 801, 451);
    expect(changes).toEqual([]);
  });
  it.each(["Escape", "pointercancel", "blur"])(
    "cancels the preview on %s",
    async (reason) => {
      await render();
      await pointer(line(), "pointerdown", 800, 450);
      await pointer(window, "pointermove", 820, 490);
      expect(visiblePath().getAttribute("d")).toBe("M 110,220L 610,220");
      await act(async () =>
        window.dispatchEvent(
          reason === "Escape"
            ? new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
            : new Event(reason),
        ),
      );
      await pointer(window, "pointerup", 820, 490);
      expect(changes).toEqual([]);
      expect(visiblePath().getAttribute("d")).toBe("M 100,200L 600,200");
    },
  );
  it("reconnects an endpoint to a real unselected block at its measured handle tip", async () => {
    flow.nodes = [
      {
        id: "runtime",
        type: "edge-anchor",
        hidden: true,
        position: { x: 488, y: 350 },
      },
      {
        id: "c",
        type: "artifact",
        position: { x: 500, y: 300 },
        measured: { width: 100, height: 100 },
        internals: {
          positionAbsolute: { x: 500, y: 300 },
          handleBounds: {
            source: [
              {
                id: "left",
                position: "left",
                x: -12,
                y: 44,
                width: 12,
                height: 12,
              },
            ],
            target: [],
          },
        },
      },
    ];
    await render();
    expect(endpoint("Конец стрелки")).not.toBeNull();
    await pointer(endpoint("Конец стрелки"), "pointerdown", 1300, 450);
    await pointer(window, "pointermove", 1078, 750);
    expect(changes).toEqual([]);
    expect(visiblePath().getAttribute("d")).toBe("M 100,200L 488,350");
    await pointer(window, "pointerup", 1078, 750);
    expect(changes[0].patch).toEqual({
      target: "c",
      targetHandle: "left",
      targetPoint: undefined,
    });
  });
  it("moves the label along the measured path without opening its editor after drag", async () => {
    await render();
    const label =
      document.querySelector<HTMLButtonElement>(".board-edge-label")!;
    await pointer(label, "pointerdown", 800, 450);
    await pointer(window, "pointermove", 1100, 450);
    expect(changes).toEqual([]);
    expect(Number.parseFloat(label.style.left)).toBeCloseTo(500);
    await pointer(window, "pointerup", 1100, 450);
    await act(async () => label.click());
    expect(changes).toHaveLength(1);
    expect(changes[0].patch.labelPosition).toBeCloseTo(0.8, 3);
    expect(document.querySelector("input")).toBeNull();
  });
  it("moves the label with keyboard keys and avoids saving again at the path limit", async () => {
    await render();
    const label =
      document.querySelector<HTMLButtonElement>(".board-edge-label")!;
    await act(async () =>
      label.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      ),
    );
    expect(changes[0].patch).toEqual({ labelPosition: 0.525 });
    await act(async () =>
      label.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    await act(async () =>
      label.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      ),
    );
    expect(changes).toHaveLength(2);
    expect(changes[1].patch).toEqual({ labelPosition: 1 });
  });
  it("preserves the grab offset when dragging from the edge of a label", async () => {
    await render();
    const label =
      document.querySelector<HTMLButtonElement>(".board-edge-label")!;
    // Grab 20 screen pixels left of the centre, then move 20 pixels right.
    await pointer(label, "pointerdown", 780, 450);
    await pointer(window, "pointermove", 800, 450);
    await pointer(window, "pointerup", 800, 450);
    expect(changes).toHaveLength(1);
    expect(changes[0].patch.labelPosition).toBeCloseTo(0.52, 3);
  });
  it("does not reconnect an endpoint back onto the block at the opposite end", async () => {
    flow.nodes = [
      {
        id: "a",
        type: "artifact",
        position: { x: 100, y: 200 },
        internals: {
          positionAbsolute: { x: 100, y: 200 },
          handleBounds: {
            source: [
              {
                id: "right",
                position: "right",
                x: -12,
                y: -6,
                width: 12,
                height: 12,
              },
            ],
            target: [],
          },
        },
      },
    ];
    await render();
    await pointer(endpoint("Конец стрелки"), "pointerdown", 1300, 450);
    await pointer(window, "pointermove", 300, 450);
    await pointer(window, "pointerup", 300, 450);
    expect(changes).toHaveLength(1);
    expect(changes[0].patch.target).toBeUndefined();
    expect(changes[0].patch.targetPoint).toEqual({ x: 100, y: 200 });
  });
  it("resizes a free end with the keyboard at a constant screen step", async () => {
    await render();
    const end = endpoint("Конец стрелки");
    await act(async () =>
      end.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          shiftKey: true,
        }),
      ),
    );
    expect(changes[0].patch).toEqual({
      target: undefined,
      targetPoint: { x: 605, y: 200 },
      targetHandle: "left",
    });
  });
  it("preserves the grab offset when resizing from the edge of an endpoint grip", async () => {
    await render();
    await pointer(endpoint("Конец стрелки"), "pointerdown", 1304, 450);
    await pointer(window, "pointermove", 1324, 450);
    await pointer(window, "pointerup", 1324, 450);
    expect(changes[0].patch.targetPoint).toEqual({ x: 610, y: 200 });
  });
  it("clamps translation to board limits while preserving the arrow length", async () => {
    await render();
    await act(async () =>
      external({
        source: undefined,
        target: undefined,
        sourcePoint: { x: 999980, y: -999990 },
        targetPoint: { x: 999990, y: -999990 },
      }),
    );
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 900, 350);
    await pointer(window, "pointerup", 900, 350);
    expect(changes[0].patch.sourcePoint).toEqual({ x: 999990, y: -1000000 });
    expect(changes[0].patch.targetPoint).toEqual({ x: 1000000, y: -1000000 });
  });
  it("does not save when a translated arrow is returned to its starting position", async () => {
    await render();
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 820, 490);
    await pointer(window, "pointerup", 800, 450);
    expect(changes).toEqual([]);
  });
  it("does not start geometry gestures while the label input is open", async () => {
    await render();
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".board-edge-label")!.click(),
    );
    expect(document.querySelector("input")).not.toBeNull();
    expect(endpoint("Конец стрелки")).toBeNull();
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 820, 490);
    await pointer(window, "pointerup", 820, 490);
    expect(changes).toEqual([]);
  });
  it("cancels a stale gesture when the canonical endpoint moves remotely", async () => {
    await render();
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 820, 490);
    await act(async () =>
      external({ source: undefined, sourcePoint: { x: 50, y: 50 } }),
    );
    await pointer(window, "pointerup", 820, 490);
    expect(changes).toEqual([]);
    expect(visiblePath().getAttribute("d")).toBe("M 50,50L 600,200");
  });
  it("cancels a gesture when switching boards with identical edge IDs and geometry", async () => {
    await render();
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 820, 490);
    expect(visiblePath().getAttribute("d")).toBe("M 110,220L 610,220");
    await act(async () => switchOwner("workspace:board-b"));
    expect(visiblePath().getAttribute("d")).toBe("M 100,200L 600,200");
    await pointer(window, "pointerup", 820, 490);
    expect(changes).toEqual([]);
    expect(nextOwnerChanges).toEqual([]);
  });
  it("commits through the callback captured at gesture start when only callback identity changes", async () => {
    await render();
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 820, 490);
    await act(async () => switchOwner("workspace:board-a"));
    await pointer(window, "pointerup", 820, 490);
    expect(changes).toHaveLength(1);
    expect(nextOwnerChanges).toEqual([]);
  });
  it("keeps read-only arrows free of endpoint controls and mutation gestures", async () => {
    await render(false);
    expect(endpoint("Конец стрелки")).toBeNull();
    await pointer(line(), "pointerdown", 800, 450);
    await pointer(window, "pointermove", 820, 490);
    await pointer(window, "pointerup", 820, 490);
    expect(changes).toEqual([]);
  });
  it("previews a bend and changes a straight arrow into a curve in a single commit", async () => {
    await render();
    const grip = endpoint("Изгиб стрелки");
    expect(grip).not.toBeNull();
    const startX = Number.parseFloat(grip.style.left) * 2 + 100;
    const startY = Number.parseFloat(grip.style.top) * 2 + 50;
    expect(Number.parseFloat(grip.style.top)).toBeGreaterThan(210);
    await pointer(grip, "pointerdown", startX, startY);
    await pointer(window, "pointermove", startX, startY + 100);
    expect(changes).toEqual([]);
    expect(visiblePath().getAttribute("d")).toContain("C");
    await pointer(window, "pointerup", startX, startY + 100);
    expect(changes).toHaveLength(1);
    expect(changes[0].patch).toEqual({
      bend: { x: 0, y: 50 },
      appearance: { path: "bezier" },
    });
  });
  it("cancels a bend preview without changing a straight arrow", async () => {
    await render();
    const grip = endpoint("Изгиб стрелки");
    expect(grip).not.toBeNull();
    const startX = Number.parseFloat(grip.style.left) * 2 + 100;
    const startY = Number.parseFloat(grip.style.top) * 2 + 50;
    await pointer(grip, "pointerdown", startX, startY);
    await pointer(window, "pointermove", startX, startY + 100);
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await pointer(window, "pointerup", startX, startY + 100);
    expect(changes).toEqual([]);
    expect(visiblePath().getAttribute("d")).toBe("M 100,200L 600,200");
  });
  it("adjusts a bend with the keyboard and resets it without deleting the arrow", async () => {
    await render();
    const grip = endpoint("Изгиб стрелки");
    expect(grip).not.toBeNull();
    await act(async () =>
      grip.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowUp",
          shiftKey: true,
          bubbles: true,
        }),
      ),
    );
    expect(changes[0].patch).toEqual({
      bend: { x: 0, y: -5 },
      appearance: { path: "bezier" },
    });
    await act(async () =>
      grip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      ),
    );
    expect(changes[1].patch).toEqual({ bend: undefined });
    expect(visiblePath()).not.toBeNull();
  });
});
