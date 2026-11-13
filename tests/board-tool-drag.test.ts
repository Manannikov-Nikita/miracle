// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToolDrag } from "../src/client/board/useToolDrag";

type DragOptions = Parameters<typeof useToolDrag<string>>[0];
type PointerOptions = {
  x?: number;
  y?: number;
  pointerId?: number;
  primary?: boolean;
  button?: number;
};

function pointerEvent(type: string, options: PointerOptions = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: options.button ?? 0,
    clientX: options.x ?? 10,
    clientY: options.y ?? 20,
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 1 },
    isPrimary: { value: options.primary ?? true },
    pointerType: { value: "mouse" },
  });
  return event;
}

describe("tool pointer dragging", () => {
  let host: HTMLDivElement;
  let root: Root;
  let drag: ReturnType<typeof useToolDrag<string>>;
  let options: DragOptions;
  const onDrop = vi.fn();
  const onMove = vi.fn();
  const onStart = vi.fn();
  const onEnd = vi.fn();
  const onClick = vi.fn();

  function Harness({ showTool = true }: { showTool?: boolean }) {
    drag = useToolDrag(options);
    return showTool
      ? createElement(
          "button",
          {
            onPointerDown: (event) => drag.begin(event, "rectangle"),
            onClick: (event) => {
              if (!drag.suppressClick(event)) onClick();
            },
          },
          "Shape",
        )
      : null;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    options = { onDrop, onMove, onStart, onEnd, resetKey: "board-a" };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render(showTool = true) {
    await act(async () => root.render(createElement(Harness, { showTool })));
  }

  async function pointer(
    type: string,
    values: PointerOptions = {},
    target: EventTarget = window,
  ) {
    const event = pointerEvent(type, values);
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  }

  async function begin(values: PointerOptions = {}) {
    return pointer("pointerdown", values, host.querySelector("button")!);
  }

  async function click(detail = 1) {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      detail,
    });
    await act(async () => {
      host.querySelector("button")!.dispatchEvent(event);
    });
    return event;
  }

  async function startDragging() {
    await begin();
    await pointer("pointermove", { x: 16, y: 20 });
    expect(drag.dragging).toBe(true);
  }

  it("preserves an ordinary click when movement stays below six pixels", async () => {
    const down = await begin();
    const move = await pointer("pointermove", { x: 13, y: 24 });
    const up = await pointer("pointerup", { x: 13, y: 24 });
    expect([down, move, up].every((event) => !event.defaultPrevented)).toBe(
      true,
    );
    expect(drag.preview).toBeNull();
    expect(drag.dragging).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect((await click()).defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts at six pixels, follows only the original pointer, and drops synchronously exactly once", async () => {
    const order: string[] = [];
    options = {
      ...options,
      onStart: (tool) => {
        order.push("start");
        onStart(tool);
      },
      onMove: (tool, point) => {
        order.push("move");
        onMove(tool, point);
      },
      onDrop: (tool, point) => {
        order.push("drop");
        onDrop(tool, point);
        // A reentrant release cannot repeat the completed drop.
        window.dispatchEvent(pointerEvent("pointerup", { x: 200, y: 300 }));
      },
      onEnd: () => {
        order.push("end");
        onEnd();
      },
    };
    await render();
    await startDragging();
    expect(order).toEqual(["start", "move"]);
    expect(drag.preview).toEqual({
      tool: "rectangle",
      point: { x: 16, y: 20 },
    });
    await pointer("pointermove", { x: 999, y: 999, pointerId: 2 });
    await pointer("pointercancel", { pointerId: 2 });
    await pointer("pointerup", { pointerId: 2 });
    await pointer("pointerup", { button: 2 });
    expect(drag.dragging).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
    await pointer("pointermove", { x: 30, y: 50 });
    expect(drag.preview).toEqual({
      tool: "rectangle",
      point: { x: 30, y: 50 },
    });
    await act(async () => {
      window.dispatchEvent(pointerEvent("pointerup", { x: 90, y: 110 }));
      expect(onDrop).toHaveBeenCalledExactlyOnceWith("rectangle", {
        x: 90,
        y: 110,
      });
      expect(onEnd).toHaveBeenCalledOnce();
    });
    expect(order).toEqual(["start", "move", "move", "drop", "end"]);
    expect(drag.preview).toBeNull();
    expect(drag.dragging).toBe(false);
    await pointer("pointerup");
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it("continues on window after the originating menu item unmounts and reads current callbacks", async () => {
    await begin();
    await render(false);
    const latestDrop = vi.fn();
    options = { ...options, onDrop: latestDrop };
    await render(false);
    await pointer("pointermove", { x: 30, y: 60 });
    expect(drag.dragging).toBe(true);
    await pointer("pointerup", { x: 70, y: 80 });
    expect(latestDrop).toHaveBeenCalledExactlyOnceWith("rectangle", {
      x: 70,
      y: 80,
    });
    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it("preserves the gesture across element focus changes but cancels when the window loses focus", async () => {
    const button = host.querySelector("button")!;
    const input = document.createElement("input");
    host.append(input);
    await act(async () => button.focus());
    await begin();
    await act(async () => input.focus());
    expect(onEnd).not.toHaveBeenCalled();
    await pointer("pointermove", { x: 16, y: 20 });
    expect(drag.dragging).toBe(true);
    await act(async () => button.focus());
    expect(drag.dragging).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new FocusEvent("blur"));
    });
    expect(drag.preview).toBeNull();
    expect(onEnd).toHaveBeenCalledOnce();
    await pointer("pointerup");
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("suppresses the followup pointer click, permits keyboard activation, and expires suppression", async () => {
    await startDragging();
    await pointer("pointerup");
    expect((await click()).defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect((await click(0)).defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(349));
    expect((await click()).defaultPrevented).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect((await click()).defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("clears prior suppression when a new primary press begins", async () => {
    await startDragging();
    await pointer("pointerup");
    await begin();
    await pointer("pointerup");
    expect((await click()).defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("suppresses release after holding a cancelled drag longer than the ordinary click timeout", async () => {
    await startDragging();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      vi.advanceTimersByTime(1000);
    });
    await pointer("pointerup");
    expect((await click()).defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    await begin();
    await pointer("pointerup");
    expect((await click()).defaultPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it.each(["right button", "secondary pointer", "disabled"])(
    "ignores a press from %s",
    async (reason) => {
      if (reason === "disabled") {
        options = { ...options, disabled: true };
        await render();
      }
      await begin({
        button: reason === "right button" ? 2 : 0,
        primary: reason !== "secondary pointer",
      });
      await pointer("pointermove", { x: 100, y: 100 });
      await pointer("pointerup");
      expect(drag.preview).toBeNull();
      expect(onStart).not.toHaveBeenCalled();
      expect(onDrop).not.toHaveBeenCalled();
      expect(onEnd).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    "Escape",
    "pointercancel",
    "blur",
    "resetKey",
    "disabled",
    "unmount",
  ])(
    "cancels on %s, removes gesture listeners, and keeps the current click suppressed",
    async (reason) => {
      await startDragging();
      const heldDrag = drag;
      if (reason === "Escape") {
        const bubble = vi.fn();
        const button = host.querySelector("button")!;
        button.addEventListener("keydown", bubble);
        const escape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        await act(async () => {
          button.dispatchEvent(escape);
        });
        expect(escape.defaultPrevented).toBe(true);
        expect(bubble).not.toHaveBeenCalled();
      } else if (reason === "resetKey" || reason === "disabled") {
        options = {
          ...options,
          ...(reason === "resetKey"
            ? { resetKey: "board-b" }
            : { disabled: true }),
        };
        await render();
      } else if (reason === "unmount") {
        await act(async () => root.render(null));
      } else {
        await act(async () => {
          window.dispatchEvent(
            reason === "blur"
              ? new Event("blur")
              : pointerEvent("pointercancel"),
          );
        });
      }
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onDrop).not.toHaveBeenCalled();
      const clickEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
      expect(heldDrag.suppressClick(clickEvent)).toBe(true);
      expect(clickEvent.preventDefault).toHaveBeenCalledOnce();
      expect(clickEvent.stopPropagation).toHaveBeenCalledOnce();
      if (reason !== "unmount") expect(drag.preview).toBeNull();
      await pointer("pointermove", { x: 200, y: 200 });
      await pointer("pointerup");
      const idleEscape = new KeyboardEvent("keydown", {
        key: "Escape",
        cancelable: true,
      });
      window.dispatchEvent(idleEscape);
      expect(idleEscape.defaultPrevented).toBe(false);
      expect(onEnd).toHaveBeenCalledOnce();
      expect(onDrop).not.toHaveBeenCalled();
      if (reason === "unmount") expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels a pending press with Escape without suppressing its ordinary click", async () => {
    await begin();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      host.querySelector("button")!.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledOnce();
    expect((await click()).defaultPrevented).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
