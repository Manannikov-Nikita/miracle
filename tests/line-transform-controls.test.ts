// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LineTransformControls, {
  lineEndpointPatch,
} from "../src/client/board/LineTransformControls";
import type { ShapeTransformPatch } from "../src/client/board/ShapeTransformControls";
import { getLineGeometry } from "../src/client/board/shape-geometry";
import { rotatePoint } from "../src/client/board/shape-rotation";
import type { ResizeRectangle } from "../src/client/board/resize-aspect";
import type { ShapeSpec } from "../src/shared/shapes";

function endpoints(shape: ShapeSpec, rectangle: ResizeRectangle) {
  const line = getLineGeometry(shape, rectangle.width, rectangle.height);
  const center = { x: rectangle.width / 2, y: rectangle.height / 2 };
  return Object.fromEntries(
    (["start", "end"] as const).map((name) => {
      const p = rotatePoint(line[name], center, shape.rotation ?? 0);
      return [name, { x: rectangle.x + p.x, y: rectangle.y + p.y }];
    }),
  ) as Record<"start" | "end", { x: number; y: number }>;
}
function expectPoint(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
) {
  expect(actual.x).toBeCloseTo(expected.x, 7);
  expect(actual.y).toBeCloseTo(expected.y, 7);
}

describe("line endpoint geometry", () => {
  const rectangle = { x: 100, y: 200, width: 320, height: 120 };
  it.each(["horizontal", "vertical", "diagonal-up", "diagonal-down"] as const)(
    "moves either %s endpoint without moving its opposite or changing arrowhead size",
    (lineDirection) => {
      const shape: ShapeSpec = {
        type: "line",
        lineDirection,
        rotation: 37,
        strokeWidth: 3,
        lineStart: "arrow",
        lineEnd: "arrow",
      };
      const before = endpoints(shape, rectangle);
      const oldHead = getLineGeometry(
        shape,
        rectangle.width,
        rectangle.height,
      ).endHead!;
      const headLength = (points: { x: number; y: number }[]) =>
        Math.hypot(
          points[0].x - (points[1].x + points[2].x) / 2,
          points[0].y - (points[1].y + points[2].y) / 2,
        );
      for (const side of ["start", "end"] as const) {
        const opposite = side === "start" ? "end" : "start";
        const direction = {
          x: before[side].x - before[opposite].x,
          y: before[side].y - before[opposite].y,
        };
        const requested = {
          x: before[side].x + direction.x * 0.5,
          y: before[side].y + direction.y * 0.5,
        };
        const patch = lineEndpointPatch(shape, rectangle, side, requested);
        const nextShape = {
          ...shape,
          rotation: patch.rotation,
          lineDirection: patch.lineDirection,
        };
        const after = endpoints(nextShape, patch.rectangle!);
        expectPoint(after[opposite], before[opposite]);
        expectPoint(after[side], requested);
        const newHead = getLineGeometry(
          nextShape,
          patch.rectangle!.width,
          patch.rectangle!.height,
        ).endHead!;
        expect(headLength(newHead)).toBeCloseTo(headLength(oldHead), 7);
      }
    },
  );

  it("keeps an existing vertical layout unchanged when its endpoint has not moved", () => {
    const shape: ShapeSpec = {
      type: "line",
      lineDirection: "vertical",
      rotation: 28,
    };
    const original = endpoints(shape, rectangle);
    expect(
      lineEndpointPatch(shape, rectangle, "start", original.start),
    ).toEqual({ rectangle, rotation: 28, lineDirection: "vertical" });
  });

  it("retains thick double arrowheads while extending the line", () => {
    const shape: ShapeSpec = {
      type: "line",
      strokeWidth: 12,
      lineStart: "arrow",
      lineEnd: "arrow",
    };
    const frame = { x: 100, y: 200, width: 400, height: 300 };
    const original = endpoints(shape, frame);
    const requested = { x: original.end.x + 100, y: original.end.y };
    const patch = lineEndpointPatch(shape, frame, "end", requested);
    const next = { ...shape, ...patch };
    const geometry = getLineGeometry(
      next,
      patch.rectangle!.width,
      patch.rectangle!.height,
    );
    expect(geometry.endHead![0].x - geometry.endHead![1].x).toBeCloseTo(48);
    expectPoint(endpoints(next, patch.rectangle!).start, original.start);
    expectPoint(endpoints(next, patch.rectangle!).end, requested);
  });

  it("snaps the direction to 15 degrees while holding the opposite endpoint fixed", () => {
    const shape: ShapeSpec = { type: "line" };
    const before = endpoints(shape, rectangle);
    const patch = lineEndpointPatch(
      shape,
      rectangle,
      "end",
      { x: before.start.x + 200, y: before.start.y + 80 },
      true,
    );
    expect(patch.rotation).toBe(15);
    expectPoint(
      endpoints({ ...shape, ...patch }, patch.rectangle!).start,
      before.start,
    );
  });

  it("clamps a collapsed or oversized line without moving the fixed end", () => {
    const shape: ShapeSpec = {
      type: "line",
      lineStart: "arrow",
      lineEnd: "arrow",
      strokeWidth: 12,
    };
    const before = endpoints(shape, rectangle);
    for (const requested of [before.end, { x: -20000, y: before.end.y }]) {
      const patch = lineEndpointPatch(shape, rectangle, "start", requested);
      expect(patch.rectangle!.width).toBeGreaterThanOrEqual(40);
      expect(patch.rectangle!.width).toBeLessThanOrEqual(10000);
      expectPoint(
        endpoints({ ...shape, ...patch }, patch.rectangle!).end,
        before.end,
      );
    }
  });
});

describe("line endpoint controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: ShapeTransformPatch[];
  let endings: boolean[];
  let starts: number;
  let allowed: boolean;
  let current: { shape: ShapeSpec; rectangle: ResizeRectangle };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    changes = [];
    endings = [];
    starts = 0;
    allowed = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(
    shape: ShapeSpec = { type: "line", rotation: 90 },
    zoom = 2,
  ) {
    function Harness() {
      const [value, setValue] = useState({
        shape,
        rectangle: { x: 100, y: 200, width: 260, height: 40 },
      });
      current = value;
      return createElement(LineTransformControls, {
        ...value,
        zoom,
        onStart() {
          starts++;
          return allowed;
        },
        onChange(patch) {
          changes.push(patch);
          setValue((previous) => ({
            shape: {
              ...previous.shape,
              rotation: patch.rotation,
              lineDirection: patch.lineDirection,
            },
            rectangle: patch.rectangle!,
          }));
        },
        onEnd(cancelled) {
          endings.push(cancelled);
        },
      });
    }
    await act(async () => root.render(createElement(Harness)));
  }
  const button = (side: "start" | "end" = "end") =>
    host.querySelector<HTMLButtonElement>(`[data-line-endpoint="${side}"]`)!;
  async function pointer(
    target: EventTarget,
    type: string,
    x: number,
    y: number,
    pointerId = 1,
  ) {
    await act(async () => {
      const event = new MouseEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "pointerId", { value: pointerId });
      target.dispatchEvent(event);
    });
  }
  async function key(target: EventTarget, key: string, shiftKey = false) {
    await act(async () =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }

  it("renders just two compact endpoint handles at visible line tips", async () => {
    await render();
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(
      host.querySelector(".shape-transform-frame, .shape-transform-resize"),
    ).toBeNull();
    const line = getLineGeometry(current.shape, 260, 40);
    expect(button().style.left).toBe(`${line.end.x}px`);
    expect(button().style.top).toBe(`${line.end.y}px`);
  });

  it("drags at the current zoom without a jump and commits once", async () => {
    await render();
    const before = endpoints(current.shape, current.rectangle);
    await pointer(button(), "pointerdown", 300, 400);
    await pointer(window, "pointermove", 300, 400);
    expect(changes).toEqual([]);
    await pointer(window, "pointermove", 340, 480);
    const after = endpoints(current.shape, current.rectangle);
    expectPoint(after.start, before.start);
    expectPoint(after.end, { x: before.end.x + 20, y: before.end.y + 40 });
    await pointer(window, "pointerup", 340, 480);
    expect(starts).toBe(1);
    expect(endings).toEqual([false]);
  });

  it.each(["escape", "cancel", "blur", "unmount"])(
    "cancels on %s and removes pointer listeners",
    async (reason) => {
      await render();
      await pointer(button(), "pointerdown", 0, 0);
      await pointer(window, "pointermove", 20, 40);
      const count = changes.length;
      if (reason === "escape") await key(window, "Escape");
      else if (reason === "cancel")
        await pointer(window, "pointercancel", 20, 40);
      else if (reason === "blur")
        await act(async () => window.dispatchEvent(new Event("blur")));
      else await act(async () => root.render(null));
      await pointer(window, "pointermove", 100, 200);
      await pointer(window, "pointerup", 100, 200);
      expect(changes).toHaveLength(count);
      expect(endings).toEqual([true]);
    },
  );

  it("rejects locked gestures and ignores unrelated or simultaneous pointers", async () => {
    await render();
    allowed = false;
    await pointer(button(), "pointerdown", 0, 0);
    await pointer(window, "pointermove", 40, 40);
    expect(changes).toEqual([]);
    allowed = true;
    await pointer(button(), "pointerdown", 0, 0);
    await pointer(button("start"), "pointerdown", 0, 0, 2);
    await pointer(window, "pointermove", 40, 40, 2);
    expect(changes).toEqual([]);
    await pointer(window, "pointerup", 0, 0);
    expect(starts).toBe(2);
    expect(endings).toEqual([false]);
  });

  it("supports keyboard movement in board coordinates with a larger Shift step", async () => {
    await render();
    const before = endpoints(current.shape, current.rectangle);
    await key(button("start"), "ArrowRight");
    await key(button("start"), "ArrowUp", true);
    const after = endpoints(current.shape, current.rectangle);
    expectPoint(after.end, before.end);
    expectPoint(after.start, { x: before.start.x + 1, y: before.start.y - 10 });
    expect(endings).toEqual([false, false]);
  });
});
