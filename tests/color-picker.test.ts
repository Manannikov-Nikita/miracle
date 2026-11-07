// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import ColorPicker from "../src/client/colors/ColorPicker";
import { Modal } from "../src/client/components/UI";

describe("color picker", () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: string[];
  let current: string;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    changes = [];
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  async function render(
    value = "#ff0000",
    options: { disabled?: boolean; allowTransparent?: boolean } = {},
  ) {
    function Harness() {
      const [color, setColor] = useState(value);
      current = color;
      return createElement(ColorPicker, {
        value: color,
        label: "Цвет",
        ...options,
        onChange(next) {
          changes.push(next);
          setColor(next);
        },
      });
    }
    await act(async () => root.render(createElement(Harness)));
  }
  function element<T extends HTMLElement = HTMLElement>(label: string) {
    const target = document.querySelector<T>(`[aria-label="${label}"]`);
    expect(target, label).not.toBeNull();
    return target!;
  }
  async function click(label: string) {
    await act(async () => element<HTMLButtonElement>(label).click());
  }
  async function key(label: string, key: string, shiftKey = false) {
    await act(async () =>
      element(label).dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  }
  async function input(label: string, value: string) {
    await act(async () => {
      const target = element<HTMLInputElement>(label);
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(target, value);
      target.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function mode(value: string) {
    await act(async () => {
      const select = element<HTMLSelectElement>("Формат цвета");
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("opens a custom dialog and commits only valid HEX drafts", async () => {
    await render();
    await click("Цвет");
    expect(document.querySelector('input[type="color"]')).toBeNull();
    await input("HEX", "#12");
    await key("HEX", "Enter");
    expect(changes).toEqual([]);
    expect(element("HEX").getAttribute("aria-invalid")).toBe("true");
    await input("HEX", "AbC");
    await key("HEX", "Enter");
    expect(current).toBe("#aabbcc");
  });

  it("validates RGB/HSL channels without treating empty as zero", async () => {
    await render();
    await click("Цвет");
    await mode("RGB");
    await input("Красный (R)", "");
    await key("Красный (R)", "Enter");
    expect(changes).toEqual([]);
    await input("Красный (R)", "256");
    await key("Красный (R)", "Enter");
    expect(changes).toEqual([]);
    await input("Красный (R)", "128");
    await key("Красный (R)", "Enter");
    expect(current).toBe("#800000");
    await mode("HSL");
    await input("Оттенок (H)", "120");
    await input("Насыщенность (S)", "100");
    await input("Светлота (L)", "50");
    await key("Светлота (L)", "Enter");
    expect(current).toBe("#00ff00");
  });

  it("retains a chosen hue and saturation while passing through black", async () => {
    await render("#0000ff");
    await click("Цвет");
    await key("Насыщенность и яркость", "End");
    expect(current).toBe("#000000");
    await input("Оттенок", "120");
    expect(current).toBe("#000000");
    await key("Насыщенность и яркость", "ArrowUp", true);
    expect(current).toBe("#001a00");
  });

  it("applies base and saved colors and saves the current color", async () => {
    await render("#123456");
    await click("Цвет");
    await click("Сохранить текущий цвет");
    const saved = document.querySelector<HTMLElement>(
      '[aria-label="Сохранённые цвета"]',
    );
    expect(saved?.querySelectorAll("button")).toHaveLength(1);
    await click("Базовый цвет #DBEAFE");
    expect(current).toBe("#dbeafe");
    await act(async () =>
      saved!.querySelector<HTMLButtonElement>("button")!.click(),
    );
    expect(current).toBe("#123456");
  });

  it("restores trigger focus after Escape and isolates canvas shortcuts", async () => {
    const boardKey = vi.fn();
    document.addEventListener("keydown", boardKey);
    await render();
    await click("Цвет");
    await key("HEX", "Delete");
    document.removeEventListener("keydown", boardKey);
    expect(boardKey).not.toHaveBeenCalled();
    const boardMenu = vi.fn();
    document.addEventListener("contextmenu", boardMenu);
    await act(async () => {
      element("HEX").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true }),
      );
    });
    document.removeEventListener("contextmenu", boardMenu);
    expect(boardMenu).not.toHaveBeenCalled();
    await key("HEX", "Escape");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(element("Цвет"));
  });

  it("allows transparency only when requested and honors disabled state", async () => {
    await render("#ff0000", { allowTransparent: true });
    await click("Цвет");
    await click("Без заливки");
    expect(current).toBe("transparent");
    await click("Закрыть выбор цвета");
    await render("#ff0000", { disabled: true });
    await click("Цвет");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(element<HTMLButtonElement>("Цвет").disabled).toBe(true);
  });

  it("hides unsupported eyedropper and does not report cancellation as an error", async () => {
    await render();
    await click("Цвет");
    expect(document.querySelector('[aria-label="Пипетка"]')).toBeNull();
    await click("Закрыть выбор цвета");
    vi.stubGlobal(
      "EyeDropper",
      class {
        open() {
          return Promise.reject(new DOMException("Cancelled", "AbortError"));
        }
      },
    );
    await click("Цвет");
    await click("Пипетка");
    expect(changes).toEqual([]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("restores the controlled color when the owner rejects a change", async () => {
    await act(async () =>
      root.render(
        createElement(ColorPicker, {
          value: "#123456",
          label: "Цвет",
          onChange: () => false,
        }),
      ),
    );
    await click("Цвет");
    await input("HEX", "abcdef");
    expect(element<HTMLInputElement>("HEX").value).toBe("123456");
    expect(
      document.querySelector('[aria-label="Текущий цвет #123456"]'),
    ).not.toBeNull();
    await click("Базовый цвет #DBEAFE");
    expect(
      document.querySelector('[aria-label="Текущий цвет #123456"]'),
    ).not.toBeNull();
  });

  it("retains HSL hue intent for gray before saturation is increased", async () => {
    await render("#808080");
    await click("Цвет");
    await mode("HSL");
    await input("Оттенок (H)", "120");
    await key("Насыщенность и яркость", "ArrowRight", true);
    expect(current).toBe("#738073");
  });

  it("clamps captured pointer drags and stops updating after pointer cancellation", async () => {
    await render();
    await click("Цвет");
    const surface = element("Насыщенность и яркость");
    surface.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100,
      x: 0,
      y: 0,
      toJSON() {},
    });
    const captures = new Set<number>();
    surface.setPointerCapture = (id) => {
      captures.add(id);
    };
    surface.hasPointerCapture = (id) => captures.has(id);
    surface.releasePointerCapture = (id) => {
      captures.delete(id);
    };
    const pointer = async (type: string, x: number, y: number) =>
      act(async () => {
        const event = new MouseEvent(type, {
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
          button: 0,
        });
        Object.defineProperty(event, "pointerId", { value: 7 });
        surface.dispatchEvent(event);
      });
    await pointer("pointerdown", 50, 50);
    expect(current).toBe("#804040");
    await pointer("pointermove", -100, 150);
    expect(current).toBe("#000000");
    await pointer("pointercancel", 50, 50);
    expect(captures.size).toBe(0);
    await pointer("pointermove", 100, 0);
    expect(current).toBe("#000000");
  });

  it("anchors the panel on its first portal mount and clamps it inside the viewport", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const isPanel = this.classList.contains("miracle-color-picker");
        return {
          left: isPanel ? 0 : 1000,
          top: isPanel ? 0 : 600,
          right: isPanel ? 272 : 1030,
          bottom: isPanel ? 460 : 630,
          width: isPanel ? 272 : 30,
          height: isPanel ? 460 : 30,
          x: 0,
          y: 0,
          toJSON() {},
        };
      },
    );
    await render();
    await click("Цвет");
    const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel.style.left).toBe("744px");
    expect(panel.style.top).toBe("132px");
  });

  it("closes only the picker inside a parent modal and restores its trigger", async () => {
    await act(async () =>
      root.render(
        createElement(Modal, {
          open: true,
          onOpenChange() {},
          title: "Настройки",
          children: createElement(ColorPicker, {
            value: "#123456",
            label: "Цвет",
            onChange() {},
          }),
        }),
      ),
    );
    await click("Цвет");
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await key("HEX", "Escape");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(element("Цвет"));
  });

  it("ignores an eyedropper result received after the picker closes", async () => {
    let finish!: (value: { sRGBHex: string }) => void;
    vi.stubGlobal(
      "EyeDropper",
      class {
        open() {
          return new Promise<{ sRGBHex: string }>((resolve) => {
            finish = resolve;
          });
        }
      },
    );
    await render();
    await click("Цвет");
    await click("Пипетка");
    await click("Закрыть выбор цвета");
    await act(async () => {
      finish({ sRGBHex: "#123456" });
    });
    expect(changes).toEqual([]);
    expect(document.body.style.pointerEvents).toBe("");
  });

  it("retains HSL saturation intent at black until brightness increases", async () => {
    await render("#000000");
    await click("Цвет");
    await mode("HSL");
    await input("Оттенок (H)", "240");
    await input("Насыщенность (S)", "100");
    await key("Насыщенность и яркость", "ArrowUp", true);
    expect(current).toBe("#00001a");
  });
});
