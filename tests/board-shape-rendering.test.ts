// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import BoardFlow from "../src/client/board/BoardFlow";
import ArtifactNode, { BoardActions } from "../src/client/board/ArtifactNode";
import type { BoardNodeData } from "../src/shared/types";
import type { ShapeSpec } from "../src/shared/shapes";

const nodeTypes = { artifact: ArtifactNode };

describe("shape artifact rendering", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: BoardNodeData;
  let change: (data: BoardNodeData) => void;
  let setEditable: (editable: boolean) => void;
  const updates: Partial<BoardNodeData>[] = [];

  beforeEach(() => {
    updates.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // XYFlow reads the canvas transform when a shape switch moves its anchors.
    // jsdom has no DOMMatrix implementation; these fixtures use zoom=1.
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        m22 = 1;
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host.appendChild(document.createElement("div")));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(
    shape: ShapeSpec,
    options: { text?: string; editable?: boolean; presentation?: boolean } = {},
  ) {
    function Canvas() {
      const [data, update] = useState<BoardNodeData>({
        kind: "shape",
        title: "Фигура",
        text: options.text ?? "Текст фигуры",
        shape,
      });
      const [editable, edit] = useState(options.editable ?? true);
      current = data;
      change = update;
      setEditable = edit;
      return createElement(
        BoardActions.Provider,
        {
          value: {
            boardId: "shape-board",
            editable,
            presentation: options.presentation,
            canEditNode: () => editable,
            update(_id, patch) {
              updates.push(patch);
              update((previous) => ({ ...previous, ...patch }));
            },
            remove() {},
            refresh() {},
            openSource() {},
            inspect() {},
            metadata() {},
            resizeStart() {},
            resize() {},
            busy: {},
          },
        },
        createElement(BoardFlow, {
          width: 1000,
          height: 800,
          nodeTypes,
          nodes: [
            {
              id: "shape",
              type: "artifact",
              position: { x: 0, y: 0 },
              width: 240,
              height: 160,
              data,
            },
          ],
          zoomOnDoubleClick: false,
        }),
      );
    }
    await act(async () => root.render(createElement(Canvas)));
  }

  async function doubleClick() {
    const shape = host.querySelector(".board-shape-content");
    expect(shape).not.toBeNull();
    await act(async () =>
      shape!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
  }

  it.each([
    ["rectangle", "rect"],
    ["rounded-rectangle", "rect"],
    ["ellipse", "ellipse"],
    ["triangle", "polygon"],
    ["diamond", "polygon"],
    ["hexagon", "polygon"],
    ["arrow", "polygon"],
  ] as const)(
    "renders %s as scalable geometry without an artifact card or header",
    async (type, geometry) => {
      await render({ type });
      const svg = host.querySelector(".board-shape-outline");
      expect(svg?.getAttribute("preserveAspectRatio")).toBe("none");
      expect(svg?.querySelector(geometry)).not.toBeNull();
      expect(host.querySelector(".board-node-header")).toBeNull();
      expect(host.querySelector(".board-shape-text")?.textContent).toBe(
        "Текст фигуры",
      );
      expect(
        host.querySelector(".board-node-body")?.classList.contains("nodrag"),
      ).toBe(false);
      expect(host.querySelector("textarea")).toBeNull();
    },
  );

  it("applies geometry and text settings while rendering HTML-like text literally", async () => {
    await render(
      {
        type: "rounded-rectangle",
        cornerRadius: 35,
        fill: "transparent",
        stroke: "#123456",
        strokeWidth: 6,
        strokeStyle: "dashed",
        opacity: 0.4,
        textColor: "#654321",
        fontSize: 36,
        fontFamily: "serif",
        bold: true,
        italic: true,
        underline: true,
        textAlign: "right",
        verticalAlign: "bottom",
      },
      { text: '<img src=x onerror="alert(1)">\nSecond line' },
    );
    const outline = host.querySelector(".board-shape-outline rect")!;
    expect(outline.getAttribute("fill")).toBe("transparent");
    expect(outline.getAttribute("stroke")).toBe("#123456");
    expect(outline.getAttribute("stroke-width")).toBe("6");
    expect(outline.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(outline.getAttribute("rx")).toBe("35");
    const content = host.querySelector<HTMLElement>(".board-shape-content")!;
    expect(content.style.opacity).toBe("0.4");
    const text = host.querySelector<HTMLElement>(".board-shape-text-area")!;
    expect(text.style.fontSize).toBe("36px");
    expect(text.style.fontWeight).toBe("700");
    expect(text.style.fontStyle).toBe("italic");
    expect(text.style.textDecoration).toBe("underline");
    expect(text.style.textAlign).toBe("right");
    expect(text.style.justifyContent).toBe("flex-end");
    expect(host.querySelector("img")).toBeNull();
    expect(text.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("keeps connection handles on triangle and arrow outlines after switching shape", async () => {
    await render({ type: "triangle" });
    const handle = (side: string) =>
      host.querySelector<HTMLElement>(
        `.react-flow__handle[data-handleid="${side}"]`,
      )!;
    expect(handle("left").style.left).toBe("25%");
    expect(handle("right").style.right).toBe("25%");
    await act(async () => change({ ...current, shape: { type: "arrow" } }));
    expect(handle("left").style.left).toBe("");
    expect(handle("top").style.left).toBe("62%");
    expect(handle("bottom").style.left).toBe("62%");
    await act(async () => change({ ...current, shape: { type: "rectangle" } }));
    expect(handle("top").style.left).toBe("");
  });

  it("allows dragging before edit, then keeps typing, selection and shortcuts local", async () => {
    await render({ type: "diamond" });
    const pointer = vi.fn();
    const keyboard = vi.fn();
    const clipboard = vi.fn();
    host.addEventListener("pointerdown", pointer);
    host.addEventListener("keydown", keyboard);
    host.addEventListener("paste", clipboard);
    host
      .querySelector(".board-shape-content")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pointer).toHaveBeenCalledTimes(1);
    await doubleClick();
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(editor).not.toBeNull();
    expect(document.activeElement).toBe(editor);
    expect(editor.classList.contains("nodrag")).toBe(true);
    expect(editor.classList.contains("nokey")).toBe(true);
    expect(editor.maxLength).toBe(200000);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(editor, "Новый текст");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Backspace" }),
      );
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "z",
          ctrlKey: true,
        }),
      );
      editor.dispatchEvent(new Event("paste", { bubbles: true }));
    });
    expect(current.text).toBe("Новый текст");
    expect(updates).toEqual([{ text: "Новый текст" }]);
    expect(pointer).toHaveBeenCalledTimes(1);
    expect(keyboard).not.toHaveBeenCalled();
    expect(clipboard).not.toHaveBeenCalled();
    await act(async () =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      ),
    );
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector(".board-shape-text")?.textContent).toBe(
      "Новый текст",
    );
  });

  it("ends editing on blur and immediately when the edit lock is lost", async () => {
    await render({ type: "ellipse" });
    await doubleClick();
    await act(async () =>
      host.querySelector<HTMLTextAreaElement>("textarea")!.blur(),
    );
    expect(host.querySelector("textarea")).toBeNull();
    await doubleClick();
    await act(async () => setEditable(false));
    expect(host.querySelector("textarea")).toBeNull();
    await doubleClick();
    expect(host.querySelector("textarea")).toBeNull();
    expect(updates).toEqual([]);
  });

  it.each([{ editable: false }, { presentation: true }])(
    "shows immutable shape text for %j",
    async (options) => {
      await render({ type: "hexagon" }, options);
      await doubleClick();
      expect(host.querySelector("textarea")).toBeNull();
      expect(host.querySelector(".board-shape-text")?.textContent).toBe(
        "Текст фигуры",
      );
      await act(async () =>
        change({
          ...current,
          text: "Из свойств",
          shape: { ...current.shape!, type: "arrow" },
        }),
      );
      expect(host.querySelector(".board-shape-text")?.textContent).toBe(
        "Из свойств",
      );
      expect(updates).toEqual([]);
    },
  );
});
