// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import ColorSettings from "../src/client/colors/ColorSettings";
import { SAVED_COLORS_STORAGE_KEY } from "../src/client/colors/saved-colors";

describe("saved color settings", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => {
      localStorage.clear();
      window.dispatchEvent(
        new StorageEvent("storage", { key: null, storageArea: localStorage }),
      );
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });
  function element<T extends HTMLElement = HTMLElement>(label: string): T {
    const result = document.querySelector<T>(`[aria-label="${label}"]`);
    expect(result, label).toBeTruthy();
    return result!;
  }
  function button(text: string): HTMLButtonElement {
    const result = [...document.querySelectorAll("button")].find(
      (item) =>
        item.textContent?.trim() === text ||
        item.getAttribute("aria-label") === text,
    );
    expect(result, text).toBeTruthy();
    return result!;
  }
  async function click(text: string) {
    await act(async () => button(text).click());
  }
  async function input(label: string, value: string) {
    const field = element<HTMLInputElement>(label);
    await act(async () => {
      field.focus();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return field;
  }
  function saved() {
    return JSON.parse(localStorage.getItem(SAVED_COLORS_STORAGE_KEY)!)
      .colors as { id: string; name: string; color: string }[];
  }
  async function render() {
    function Harness() {
      const [open, setOpen] = useState(false);
      return createElement(
        "div",
        {},
        createElement(
          "button",
          { onClick: () => setOpen(true) },
          "Открыть настройки",
        ),
        createElement(ColorSettings, { open, onOpenChange: setOpen }),
      );
    }
    await act(async () => root.render(createElement(Harness)));
    await act(async () => button("Открыть настройки").focus());
    await click("Открыть настройки");
  }
  function seed() {
    localStorage.setItem(
      SAVED_COLORS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        colors: [
          { id: "mint", name: "Мята", color: "#83F3C0" },
          { id: "blue", name: "Синий", color: "#0088FF" },
        ],
      }),
    );
  }
  it("explains an empty palette and immediately persists a named color", async () => {
    await render();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Сохранённые цвета",
    );
    expect(document.body.textContent).toContain("Добавьте первый цвет");
    await input("Название нового цвета", "Мой акцент");
    await click("Добавить цвет");
    expect(saved()).toEqual([
      {
        id: expect.any(String),
        name: "Мой акцент",
        color: expect.stringMatching(/^#[0-9A-F]{6}$/),
      },
    ]);
    expect(element<HTMLInputElement>("Название цвета · Мой акцент").value).toBe(
      "Мой акцент",
    );
    expect(element<HTMLInputElement>("Название нового цвета").value).toBe("");
  });
  it("edits a saved name and color through the shared picker", async () => {
    seed();
    await render();
    const name = await input("Название цвета · Мята", "Акцент");
    await act(async () => name.blur());
    expect(saved()[0].name).toBe("Акцент");
    await click("Изменить цвет · Акцент");
    const hex = await input("HEX", "#123abc");
    await act(async () =>
      hex.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(saved()[0].color).toBe("#123ABC");
    expect(saved()[0].id).toBe("mint");
  });
  it("preserves a name being typed across cross-tab edits and syncs untouched names", async () => {
    seed();
    await render();
    const draft = await input("Название цвета · Мята", "Мой черновик");
    async function externalNames(mint: string, blue: string) {
      await act(async () => {
        localStorage.setItem(
          SAVED_COLORS_STORAGE_KEY,
          JSON.stringify({
            version: 1,
            colors: [
              { id: "mint", name: mint, color: "#83F3C0" },
              { id: "blue", name: blue, color: "#0088FF" },
            ],
          }),
        );
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: SAVED_COLORS_STORAGE_KEY,
            storageArea: localStorage,
          }),
        );
      });
    }
    await externalNames("Другая вкладка", "Новое синее имя");
    expect(draft.value).toBe("Мой черновик");
    expect(
      element<HTMLInputElement>("Название цвета · Новое синее имя").value,
    ).toBe("Новое синее имя");
    await act(async () => draft.blur());
    expect(saved().map((color) => color.name)).toEqual([
      "Мой черновик",
      "Новое синее имя",
    ]);
    await externalNames("После сохранения", "Новое синее имя");
    expect(draft.value).toBe("После сохранения");
  });
  it("reorders and deletes saved colors accessibly", async () => {
    seed();
    await render();
    expect(button("Переместить выше · Мята").disabled).toBe(true);
    await click("Переместить выше · Синий");
    expect(saved().map((color) => color.id)).toEqual(["blue", "mint"]);
    expect(
      [
        ...document.querySelectorAll<HTMLInputElement>(
          '[aria-label^="Название цвета · "]',
        ),
      ].map((field) => field.value),
    ).toEqual(["Синий", "Мята"]);
    await click("Удалить цвет · Синий");
    expect(saved().map((color) => color.id)).toEqual(["mint"]);
  });
  it("shows a storage error and retains the unsaved new-color draft", async () => {
    await render();
    await input("Название нового цвета", "Не потерять");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota", "QuotaExceededError");
    });
    await click("Добавить цвет");
    expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(element<HTMLInputElement>("Название нового цвета").value).toBe(
      "Не потерять",
    );
    expect(
      document.querySelectorAll('[aria-label^="Название цвета · "]'),
    ).toHaveLength(0);
  });
  it("closes only the nested picker on Escape, then restores settings opener focus", async () => {
    await render();
    await click("Новый цвет");
    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Сохранённые цвета",
    );
    expect(document.querySelector('[aria-label="HEX"]')).toBeNull();
    await click("Закрыть");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(button("Открыть настройки"));
  });
});
