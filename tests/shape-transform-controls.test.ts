// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShapeTransformControls, {
  type ShapeTransformPatch,
} from "../src/client/board/ShapeTransformControls";

describe("shape transform controls", () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: ShapeTransformPatch[];
  let endings: boolean[];
  let starts: number;
  let allowed: boolean;
  let current: {
    rotation: number;
    rectangle: { x: number; y: number; width: number; height: number };
  };

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

  async function render(rotation = 0, zoom = 1) {
    function Harness() {
      const [value, setValue] = useState({
        rotation,
        rectangle: { x: 10, y: 20, width: 200, height: 100 },
      });
      current = value;
      return createElement(
        "article",
        { className: "board-artifact" },
        createElement(ShapeTransformControls, {
          ...value,
          zoom,
          onStart() {
            starts++;
            return allowed;
          },
          onChange(patch) {
            changes.push(patch);
            setValue((previous) => ({ ...previous, ...patch }));
          },
          onEnd(cancelled) {
            endings.push(cancelled);
          },
        }),
      );
    }
    await act(async () => root.render(createElement(Harness)));
    host.querySelector("article")!.getBoundingClientRect = () => ({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 300,
      bottom: 200,
      width: 200,
      height: 100,
      toJSON() {},
    });
  }
  const rotationButton = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Повернуть фигуру"]')!;
  async function pointer(
    target: EventTarget,
    type: string,
    x: number,
    y: number,
    shiftKey = false,
    pointerId = 1,
  ) {
    await act(async () => {
      const event = new MouseEvent(type, {
        clientX: x,
        clientY: y,
        button: 0,
        bubbles: true,
        cancelable: true,
        shiftKey,
      });
      Object.defineProperty(event, "pointerId", { value: pointerId });
      target.dispatchEvent(event);
    });
  }
  async function key(
    target: EventTarget,
    type: string,
    key: string,
    shiftKey = false,
  ) {
    await act(async () =>
      target.dispatchEvent(
        new KeyboardEvent(type, {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }

  it("rotates without a jump from the pointer's initial angle and commits once", async () => {
    await render(30);
    await pointer(rotationButton(), "pointerdown", 200, 80);
    await pointer(window, "pointermove", 200, 80);
    expect(current.rotation).toBe(30);
    await pointer(window, "pointermove", 270, 150);
    expect(current.rotation).toBe(120);
    await pointer(window, "pointerup", 270, 150);
    await pointer(window, "pointermove", 200, 220);
    expect(current.rotation).toBe(120);
    expect(starts).toBe(1);
    expect(endings).toEqual([false]);
  });

  it("snaps to 15 degree steps with Shift and releases snapping without another movement", async () => {
    await render();
    await pointer(rotationButton(), "pointerdown", 200, 80);
    await pointer(window, "pointermove", 240, 100);
    expect(current.rotation).toBeCloseTo(38.659808, 5);
    await key(window, "keydown", "Shift", true);
    expect(current.rotation).toBe(45);
    await key(window, "keyup", "Shift", false);
    expect(current.rotation).toBeCloseTo(38.659808, 5);
    await pointer(window, "pointerup", 240, 100);
    expect(endings).toEqual([false]);
  });

  it.each(["escape", "cancel", "blur"])(
    "cancels on %s and ignores remaining pointer events",
    async (reason) => {
      await render();
      await pointer(rotationButton(), "pointerdown", 200, 80);
      await pointer(window, "pointermove", 270, 150);
      const count = changes.length;
      if (reason === "escape") await key(window, "keydown", "Escape");
      else if (reason === "cancel")
        await pointer(window, "pointercancel", 270, 150);
      else await act(async () => window.dispatchEvent(new Event("blur")));
      await pointer(window, "pointerup", 270, 150);
      await pointer(window, "pointermove", 200, 220);
      expect(changes).toHaveLength(count);
      expect(endings).toEqual([true]);
    },
  );

  it("does not start a rejected gesture or accept another pointer", async () => {
    await render();
    allowed = false;
    await pointer(rotationButton(), "pointerdown", 200, 80);
    await pointer(window, "pointermove", 270, 150);
    expect(changes).toEqual([]);
    expect(endings).toEqual([]);
    allowed = true;
    await pointer(rotationButton(), "pointerdown", 200, 80);
    await pointer(window, "pointermove", 270, 150, false, 2);
    expect(changes).toEqual([]);
    await pointer(window, "pointerup", 200, 80);
    expect(endings).toEqual([false]);
  });

  it("resizes on rotated axes at the current zoom while preserving the opposite side", async () => {
    await render(90, 2);
    const right = host.querySelector<HTMLButtonElement>(
      '[aria-label="Изменить размер справа"]',
    )!;
    expect(right).not.toBeNull();
    await pointer(right, "pointerdown", 200, 250);
    await pointer(window, "pointermove", 200, 330);
    expect(current.rectangle.x).toBeCloseTo(-10);
    expect(current.rectangle.y).toBeCloseTo(40);
    expect(current.rectangle.width).toBeCloseTo(240);
    expect(current.rectangle.height).toBeCloseTo(100);
    await pointer(window, "pointerup", 200, 330);
    expect(endings).toEqual([false]);
  });

  it("supports keyboard rotation, Shift steps and reset with one undo step each", async () => {
    await render(0);
    expect(host.querySelector(".shape-transform-resize")).toBeNull();
    await key(rotationButton(), "keydown", "ArrowRight");
    expect(current.rotation).toBe(1);
    await key(rotationButton(), "keydown", "ArrowRight", true);
    expect(current.rotation).toBe(15);
    await key(rotationButton(), "keydown", "ArrowLeft", true);
    expect(current.rotation).toBe(0);
    await key(rotationButton(), "keydown", "ArrowLeft");
    expect(current.rotation).toBe(359);
    await key(rotationButton(), "keydown", "Home");
    expect(current.rotation).toBe(0);
    expect(endings).toEqual([false, false, false, false, false]);
  });

  it("ends an active gesture on unmount", async () => {
    await render();
    await pointer(rotationButton(), "pointerdown", 200, 80);
    await act(async () => root.render(null));
    await pointer(window, "pointermove", 270, 150);
    expect(endings).toEqual([true]);
    expect(changes).toEqual([]);
  });
});
