// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import TextBlockContent from "../src/client/board/TextBlockContent";
import TextBlockSettings from "../src/client/board/TextBlockSettings";
import type { TextStyleSpec } from "../src/shared/text-style";
import BoardFlow from "../src/client/board/BoardFlow";
import ArtifactNode, { BoardActions } from "../src/client/board/ArtifactNode";

const nodeTypes = { artifact: ArtifactNode };

const style: TextStyleSpec = {
  fontFamily: "serif",
  fontSize: 42,
  textColor: "#123456",
  bold: true,
  italic: true,
  underline: true,
  textAlign: "right",
  verticalAlign: "bottom",
};

describe("standalone text content", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: { text: string; textStyle: TextStyleSpec };
  let lock: () => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

  async function render(settings = false, editable = true) {
    function Canvas() {
      const [value, setValue] = useState({
        text: "<b>Заголовок</b>\nВторая строка",
        textStyle: style,
      });
      const [canEdit, setCanEdit] = useState(editable);
      current = value;
      lock = () => setCanEdit(false);
      return settings
        ? createElement(TextBlockSettings, {
            ...value,
            disabled: !canEdit,
            onChange: (patch) =>
              setValue((previous) => ({ ...previous, ...patch })),
          })
        : createElement(TextBlockContent, {
            ...value,
            editable: canEdit,
            onChange: (text) => setValue((previous) => ({ ...previous, text })),
          });
    }
    await act(async () => root.render(createElement(Canvas)));
  }

  async function edit() {
    await act(async () =>
      host
        .querySelector(".board-text-content")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
  }

  async function input(
    target: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) {
    const prototype =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        target,
        value,
      );
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("renders literal multiline text with saved typography and no geometry", async () => {
    await render();
    const content = host.querySelector<HTMLElement>(".board-text-content")!;
    expect(content.textContent).toBe(current.text);
    expect(host.querySelector("b, svg, textarea")).toBeNull();
    expect(content.style.color).toBe("rgb(18, 52, 86)");
    expect(content.style.fontSize).toBe("42px");
    expect(content.style.fontFamily).toContain("Georgia");
    expect(content.style.fontWeight).toBe("700");
    expect(content.style.fontStyle).toBe("italic");
    expect(content.style.textDecoration).toBe("underline");
    expect(content.style.textAlign).toBe("right");
    expect(content.style.justifyContent).toBe("flex-end");
  });

  it("keeps text edits and canvas shortcuts separate, and finishes with Escape", async () => {
    await render();
    const keys = vi.fn();
    const clipboard = vi.fn();
    const pointer = vi.fn();
    host.addEventListener("keydown", keys);
    host.addEventListener("paste", clipboard);
    host.addEventListener("pointerdown", pointer);
    host
      .querySelector(".board-text-content")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pointer).toHaveBeenCalledTimes(1);
    await edit();
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(document.activeElement).toBe(editor);
    await input(editor, "Новый текст\nПродолжение");
    for (const key of ["Delete", "Backspace", "z", "c", "v"])
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true }),
      );
    editor.dispatchEvent(new Event("paste", { bubbles: true }));
    editor.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(keys).not.toHaveBeenCalled();
    expect(clipboard).not.toHaveBeenCalled();
    expect(pointer).toHaveBeenCalledTimes(1);
    expect(current.text).toBe("Новый текст\nПродолжение");
    expect(current.textStyle).toEqual(style);
    await act(async () =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toBe(current.text);
  });

  it("finishes inline editing when focus or edit permission is lost", async () => {
    await render();
    await edit();
    await act(async () =>
      host.querySelector<HTMLTextAreaElement>("textarea")!.blur(),
    );
    expect(host.querySelector("textarea")).toBeNull();
    await edit();
    await act(async () => lock());
    expect(host.querySelector("textarea")).toBeNull();
    await edit();
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("renders read-only presentations without an editable input", async () => {
    await render(false, false);
    await edit();
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.textContent).toBe(current.text);
  });

  it.each([false, true])(
    "renders text artifacts without a card header on presentation=%s",
    async (presentation) => {
      await act(async () =>
        root.render(
          createElement(
            BoardActions.Provider,
            {
              value: {
                boardId: "text-board",
                editable: true,
                presentation,
                slideBackground: "#ffffff",
                update() {},
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
                  id: "text",
                  type: "artifact",
                  position: { x: 0, y: 0 },
                  width: 360,
                  height: 96,
                  data: { kind: "text", title: "Заголовок", text: "Надпись" },
                },
              ],
            }),
          ),
        ),
      );
      expect(host.querySelector(".board-artifact-text")).not.toBeNull();
      expect(host.querySelector(".board-node-header")).toBeNull();
      expect(
        host.querySelector(".board-node-body")?.classList.contains("nodrag"),
      ).toBe(false);
      const content = host.querySelector<HTMLElement>(".board-text-content")!;
      expect(content.textContent).toBe("Надпись");
      expect(content.style.color).toBe("var(--board-text)");
      expect(content.style.fontSize).toBe("32px");
      if (presentation) {
        await edit();
        expect(host.querySelector("textarea")).toBeNull();
      }
    },
  );

  it("edits text and typography independently through text-only settings", async () => {
    await render(true);
    const editor = host.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Текст блока"]',
    )!;
    await input(editor, "Новый заголовок");
    expect(current.textStyle).toEqual(style);
    await input(
      host.querySelector<HTMLInputElement>(
        'input[aria-label="Размер текста"]',
      )!,
      "64",
    );
    await input(
      host.querySelector<HTMLInputElement>('input[aria-label="HEX · Текст"]')!,
      "#abcdef",
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Жирный"]')!
        .click(),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Текст по левому краю"]',
        )!
        .click(),
    );
    expect(current.text).toBe("Новый заголовок");
    expect(current.textStyle).toEqual({
      ...style,
      fontSize: 64,
      textColor: "#abcdef",
      bold: false,
      textAlign: "left",
    });
    expect(
      host.querySelector(
        '[aria-label="Вид фигуры"], [aria-label="Заливка"], [aria-label="Обводка"]',
      ),
    ).toBeNull();
    const keys = vi.fn();
    host.addEventListener("keydown", keys);
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    expect(keys).not.toHaveBeenCalled();
  });

  it("keeps locked settings readable while preventing text and style changes", async () => {
    await render(true, false);
    const editor = host.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(editor.readOnly).toBe(true);
    await input(editor, "Не сохранять");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-label="Жирный"]')!
        .click(),
    );
    expect(current.text).toBe("<b>Заголовок</b>\nВторая строка");
    expect(current.textStyle).toEqual(style);
    for (const control of host.querySelectorAll<
      HTMLInputElement | HTMLButtonElement
    >("input, button"))
      expect(control.disabled).toBe(true);
  });
});
