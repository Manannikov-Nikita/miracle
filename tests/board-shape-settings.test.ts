// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import Inspector from "../src/client/board/Inspector";
import type { BoardNode } from "../src/shared/types";

const styledShape = {
  type: "rounded-rectangle" as const,
  fill: "#fef3c7",
  stroke: "#dc2626",
  strokeWidth: 4,
  strokeStyle: "dashed" as const,
  opacity: 0.7,
  cornerRadius: 22,
  textColor: "#172033",
  fontFamily: "serif" as const,
  fontSize: 30,
  bold: true,
  italic: true,
  underline: true,
  textAlign: "right" as const,
  verticalAlign: "bottom" as const,
};

describe("shape inspector", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: BoardNode;
  let changes: BoardNode[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    changes = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  });

  async function render(
    editable = true,
    presentation = false,
    shape: BoardNode["data"]["shape"] = styledShape,
  ) {
    function Board() {
      const [node, setNode] = useState<BoardNode>({
        id: "shape-1",
        type: "artifact",
        position: { x: 15, y: 30 },
        width: 240,
        height: 160,
        data: {
          title: "План",
          kind: "shape",
          text: "Первый шаг\nПродолжение",
          shape,
        },
      });
      current = node;
      return createElement(Inspector, {
        node,
        editable,
        presentation,
        change(next) {
          changes.push(next);
          setNode(next);
        },
        close() {},
        openSource() {},
      });
    }
    await act(async () => root.render(createElement(Board)));
  }

  function field(label: string) {
    const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      `input[aria-label="${label}"], textarea[aria-label="${label}"]`,
    );
    expect(input, label).not.toBeNull();
    return input!;
  }

  function button(label: string) {
    const result = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(result, label).not.toBeNull();
    return result!;
  }

  async function input(label: string, value: string) {
    const target = field(label);
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

  async function click(label: string) {
    await act(async () => button(label).click());
  }

  async function choose(label: string, optionLabel: string) {
    await act(async () => {
      button(label).focus();
      button(label).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent?.trim() === optionLabel);
    expect(option, optionLabel).toBeDefined();
    await act(async () => {
      option!.focus();
      option!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  it.each([false, true])(
    "edits plain text on presentation=%s without changing style or node identity",
    async (presentation) => {
      await render(true, presentation);
      await input("Текст фигуры", "<b>Новый текст</b>\nВторая строка");
      expect(current.data.text).toBe("<b>Новый текст</b>\nВторая строка");
      expect(current.data.shape).toEqual(styledShape);
      expect(current.id).toBe("shape-1");
      expect(current.position).toEqual({ x: 15, y: 30 });
      expect(current.data.title).toBe("План");
      expect(field("Текст фигуры").maxLength).toBe(200000);
    },
  );

  it("edits each shape's styling without changing its type, title or text", async () => {
    for (const type of [
      "rectangle",
      "rounded-rectangle",
      "ellipse",
      "triangle",
      "diamond",
      "hexagon",
      "arrow",
    ] as const) {
      await render(true, false, { ...styledShape, type });
      await input("Непрозрачность, %", "50");
      expect(current.data.shape).toEqual({
        ...styledShape,
        type,
        opacity: 0.5,
      });
      expect(current.data.title).toBe("План");
      expect(current.data.text).toBe("Первый шаг\nПродолжение");
      expect(Boolean(host.querySelector('[aria-label="Скругление, %"]'))).toBe(
        type === "rectangle" || type === "rounded-rectangle",
      );
    }
  });

  it("updates fill, stroke, opacity and corners without losing other settings", async () => {
    await render();
    await click("Цвет · Заливка");
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Без заливки"]')!
        .click(),
    );
    const closePicker = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Закрыть выбор цвета"]',
    );
    if (closePicker) await act(async () => closePicker.click());
    expect(current.data.shape).toEqual({ ...styledShape, fill: "transparent" });
    await input("HEX · Заливка", "#abcdef");
    await input("HEX · Обводка", "#102030");
    await input("Толщина обводки", "0");
    await choose("Стиль обводки", "Точечная");
    await input("Непрозрачность, %", "45.5");
    expect(field("Непрозрачность, %").value).toBe("45.5");
    await input("Скругление, %", "50");
    expect(current.data.shape).toEqual({
      ...styledShape,
      fill: "#abcdef",
      stroke: "#102030",
      strokeWidth: 0,
      strokeStyle: "dotted",
      opacity: 0.455,
      cornerRadius: 50,
    });
  });

  it("edits line arrowheads while retaining legacy direction, rotation and styling", async () => {
    const lineShape = {
      ...styledShape,
      type: "line" as const,
      lineDirection: "diagonal-up" as const,
      rotation: 37,
    };
    await render(true, false, lineShape);
    expect(host.querySelector('[aria-label="Текст фигуры"]')).toBeNull();
    expect(host.querySelector('[aria-label="Цвет · Заливка"]')).toBeNull();
    await choose("Конец линии", "Стрелка");
    await choose("Начало линии", "Стрелка");
    expect(current.data.kind).toBe("shape");
    expect(current.data.shape).toEqual({
      ...lineShape,
      lineStart: "arrow",
      lineEnd: "arrow",
    });
    expect(current.position).toEqual({ x: 15, y: 30 });
    await choose("Конец линии", "Без стрелки");
    expect(current.data.shape).toEqual({
      ...lineShape,
      lineStart: "arrow",
      lineEnd: "none",
    });
    expect(current.data.title).toBe("План");
    expect(current.data.text).toBe("Первый шаг\nПродолжение");
  });

  it("opens the shared color picker instead of a system color input", async () => {
    await render();
    expect(host.querySelector('input[type="color"]')).toBeNull();
    await click("Цвет · Текст");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Сохранённые цвета");
  });

  it("updates text formatting and both alignments without dropping shape styling", async () => {
    await render();
    await choose("Шрифт", "Моноширинный");
    await input("Размер текста", "42");
    await input("HEX · Текст", "#112233");
    await click("Жирный");
    await click("Курсив");
    await click("Подчёркнутый");
    await click("Текст по левому краю");
    await click("Текст сверху");
    expect(current.data.shape).toEqual({
      ...styledShape,
      fontFamily: "mono",
      fontSize: 42,
      textColor: "#112233",
      bold: false,
      italic: false,
      underline: false,
      textAlign: "left",
      verticalAlign: "top",
    });
  });

  it("keeps invalid colors and numeric drafts out of saved data", async () => {
    await render();
    await input("HEX · Заливка", "#zzzzzz");
    await input("Толщина обводки", "13");
    await input("Непрозрачность, %", "101");
    await input("Скругление, %", "51");
    await input("Размер текста", "7");
    await input("Размер текста", "");
    expect(changes).toHaveLength(0);
    expect(current.data.shape).toEqual(styledShape);
  });

  it("blocks locked shape edits while leaving text available for reading", async () => {
    await render(false);
    expect(field("Текст фигуры").readOnly).toBe(true);
    for (const target of host.querySelectorAll<
      HTMLButtonElement | HTMLInputElement
    >(".shape-settings button, .shape-settings input"))
      expect(target.disabled).toBe(true);
    await click("Жирный");
    await click("Цвет · Заливка");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await input("Текст фигуры", "Не сохранить");
    expect(changes).toHaveLength(0);
    expect(current.data.title).toBe("План");
    expect(current.data.shape).toEqual(styledShape);
    expect(current.data.text).toBe("Первый шаг\nПродолжение");
  });

  it("keeps keyboard and clipboard events in shape controls", async () => {
    await render();
    const keys = vi.fn();
    const paste = vi.fn();
    document.addEventListener("keydown", keys);
    document.addEventListener("paste", paste);
    const target = field("Текст фигуры");
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
    );
    target.dispatchEvent(new Event("paste", { bubbles: true }));
    expect(keys).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
    document.removeEventListener("keydown", keys);
    document.removeEventListener("paste", paste);
  });
});
