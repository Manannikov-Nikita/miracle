// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BoardEdgeToolbar from "../src/client/board/BoardEdgeToolbar";
import type { BoardEdgeAppearance } from "../src/shared/types";

describe("compact arrow color palette", () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: BoardEdgeAppearance[];
  const closeToolbar = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    changes = [];
    closeToolbar.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render() {
    function Harness() {
      const [appearance, setAppearance] = useState<BoardEdgeAppearance>({});
      return createElement(BoardEdgeToolbar, {
        appearance,
        onChange: (patch) => {
          changes.push(patch);
          setAppearance((old) => ({ ...old, ...patch }));
        },
        onEdit() {},
        onDelete() {},
        onClose: closeToolbar,
      });
    }
    await act(async () => root.render(createElement(Harness)));
  }
  const trigger = () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Цвет линии"]')!;
  const swatch = (name: string) =>
    document.querySelector<HTMLElement>(
      `[role="menuitemradio"][aria-label="${name}"]`,
    )!;
  async function key(element: HTMLElement, value: string) {
    await act(async () =>
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    // Radix returns focus after its portal unmounts.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  async function open() {
    await act(async () => trigger().focus());
    await key(trigger(), "ArrowDown");
    return document.querySelector<HTMLElement>('[role="menu"]')!;
  }
  async function choose(name: string) {
    await act(async () => swatch(name).click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }

  it("shows only swatches while preserving accessible color names and selection", async () => {
    await render();
    const menu = await open();
    expect(menu.textContent?.trim()).toBe("");
    expect(menu.getAttribute("aria-label")).toBe("Цвет линии");
    const names = [...menu.querySelectorAll('[role="menuitemradio"]')].map(
      (item) => item.getAttribute("aria-label"),
    );
    expect(names).toEqual([
      "По умолчанию",
      "Зелёный",
      "Синий",
      "Жёлтый",
      "Красный",
      "Фиолетовый",
    ]);
    expect(swatch("По умолчанию").getAttribute("aria-checked")).toBe("true");
    expect(swatch("Синий").title).toBe("Синий");
    expect(changes).toEqual([]);
  });

  it("changes and resets color once, without saving repeat selection", async () => {
    await render();
    await open();
    await choose("По умолчанию");
    expect(changes).toEqual([]);
    await open();
    await choose("Синий");
    expect(changes).toEqual([{ color: "#91b5ff" }]);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await open();
    expect(swatch("Синий").getAttribute("aria-checked")).toBe("true");
    await choose("Синий");
    expect(changes).toHaveLength(1);
    await open();
    await choose("По умолчанию");
    expect(changes).toEqual([{ color: "#91b5ff" }, { color: undefined }]);
    await open();
    expect(swatch("По умолчанию").getAttribute("aria-checked")).toBe("true");
  });

  it("supports horizontal keyboard navigation and closes only the palette with Escape", async () => {
    await render();
    await open();
    await act(async () => swatch("По умолчанию").focus());
    await key(swatch("По умолчанию"), "ArrowRight");
    expect(document.activeElement).toBe(swatch("Зелёный"));
    await key(swatch("Зелёный"), "ArrowRight");
    expect(document.activeElement).toBe(swatch("Синий"));
    await key(swatch("Синий"), "Enter");
    expect(changes).toEqual([{ color: "#91b5ff" }]);
    await open();
    await key(document.activeElement as HTMLElement, "Escape");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(closeToolbar).not.toHaveBeenCalled();
    expect(changes).toHaveLength(1);
  });
});
