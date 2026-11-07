// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PresentationSlides from "../src/client/board/PresentationSlides";
import PresentationScene from "../src/client/board/PresentationScene";
import type { BoardDocument, PresentationSlide } from "../src/shared/types";

const slides: PresentationSlide[] = [
  { id: "first", title: "Итоги", background: "#ffffff" },
  { id: "second", title: "План", background: "#f6efda" },
];
const initialDocument: BoardDocument = {
  schemaVersion: 1,
  kind: "presentation",
  slides,
  nodes: slides.map((slide, index) => ({
    id: `note-${slide.id}`,
    type: "artifact",
    slideId: slide.id,
    position: { x: 50, y: 50 },
    width: 400,
    height: 250,
    data: {
      kind: "note",
      title: "Заметка",
      text: index === 0 ? "Рост продаж" : "Обновить прогноз",
    },
  })),
  edges: [],
};

let host: HTMLDivElement;
let root: Root;
const onSelect = vi.fn();
const observations = new Map<Element, IntersectionObserverCallback>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        observations.set(target, this.callback);
      }
      disconnect() {
        for (const [target, callback] of observations) {
          if (callback === this.callback) observations.delete(target);
        }
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(112);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(112);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(63);
  host = document.createElement("div");
  host.className = "board-workspace";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  onSelect.mockClear();
  observations.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(document = initialDocument, onUpdate = vi.fn()) {
  const noop = () => {};
  await act(async () =>
    root.render(
      createElement(PresentationSlides, {
        boardId: "deck",
        document,
        selected: slides[0],
        structureEditable: true,
        metadataEditable: true,
        deletionEditable: true,
        onSelect,
        onAdd: noop,
        onDuplicate: noop,
        onUpdate,
        onRemove: noop,
        onReorder: noop,
      }),
    ),
  );
}

async function setVisible(title: string, isIntersecting: boolean) {
  await act(async () => {
    for (const [target, callback] of observations) {
      if (!target.closest("li")?.querySelector(`button[title="${title}"]`))
        continue;
      callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    }
  });
}

const previewTexts = () =>
  [...host.querySelectorAll("textarea")].map((note) => note.value);

it("keeps slide contents readable without card controls or keyboard tab stops", async () => {
  await act(async () =>
    root.render(
      createElement(PresentationScene, {
        document: initialDocument,
        boardId: "deck",
        slide: slides[0],
      }),
    ),
  );
  const article = host.querySelector("article")!;
  const text = article.querySelector("textarea")!;
  expect(text.value).toBe("Рост продаж");
  expect(text.readOnly).toBe(true);
  expect(text.tabIndex).toBe(-1);
  expect(text.closest("[inert],[aria-hidden=true]")).toBeNull();
  expect(article.querySelector(".board-node-header")).toBeNull();
  expect(article.style.getPropertyValue("--board-text")).toBe("#20252b");

  await act(async () =>
    root.render(
      createElement(PresentationScene, {
        document: initialDocument,
        boardId: "deck",
        slide: { ...slides[0], background: "#202225" },
      }),
    ),
  );
  expect(article.style.getPropertyValue("--board-text")).toBe("#eeeff0");
});

it("renders slide content only while its thumbnail is visible, including live edits", async () => {
  await render();
  expect(previewTexts()).toEqual([]);

  await setVisible("План", true);
  expect(previewTexts()).toEqual(["Обновить прогноз"]);

  await render({
    ...initialDocument,
    nodes: initialDocument.nodes.map((node) =>
      node.slideId === "second"
        ? { ...node, data: { ...node.data, text: "Прогноз обновлён" } }
        : node,
    ),
  });
  expect(previewTexts()).toEqual(["Прогноз обновлён"]);

  await setVisible("План", false);
  expect(previewTexts()).toEqual([]);
});

it("validates the typed background color before saving slide settings", async () => {
  const onUpdate = vi.fn();
  await render(initialDocument, onUpdate);
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Действия со слайдом"]',
  )!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  const edit = [
    ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent?.trim() === "Название и фон")!;
  await act(async () => edit.click());

  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  const input = [...dialog.querySelectorAll("label")].find(
    (label) => label.textContent?.trim() === "Код цвета фона",
  )?.control as HTMLInputElement | undefined;
  expect(input?.value).toBe("#ffffff");
  const picker = dialog.querySelector<HTMLButtonElement>(
    'button[aria-label="Цвет фона"]',
  )!;
  expect(picker).not.toBeNull();
  expect(dialog.querySelector('input[type="color"]')).toBeNull();
  const save = dialog.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  const write = async (field: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  await write(input!, "#123");
  expect(save.disabled).toBe(true);
  expect(input!.getAttribute("aria-invalid")).toBe("true");
  expect(dialog.textContent).toContain("Введите цвет в формате #RRGGBB.");
  await act(async () =>
    save.form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
  expect(onUpdate).not.toHaveBeenCalled();

  await act(async () => picker.click());
  const pickerHex = document.querySelector<HTMLInputElement>(
    'input[aria-label="HEX"]',
  )!;
  await write(pickerHex, "#08bbaa");
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Закрыть выбор цвета"]',
      )!
      .click(),
  );
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await vi.waitFor(() => expect(document.activeElement).toBe(picker));
  expect(input!.value).toBe("#08bbaa");

  await write(input!, "#90B4AE");
  expect(picker.textContent?.toLowerCase()).toContain("90b4ae");
  expect(save.disabled).toBe(false);
  await act(async () => save.click());
  expect(onUpdate).toHaveBeenCalledWith("first", {
    title: "Итоги",
    background: "#90B4AE",
  });
});

it("keeps slide selection separate from the inert read-only miniature", async () => {
  await render();
  await setVisible("План", true);

  const note = host.querySelector("textarea")!;
  expect(note).not.toBeNull();
  expect(note.readOnly).toBe(true);
  expect(note.closest("[inert]")).not.toBeNull();

  const button = host.querySelector<HTMLButtonElement>('button[title="План"]')!;
  expect(button.contains(note)).toBe(false);
  await act(async () => button.click());
  expect(onSelect).toHaveBeenCalledWith("second");
});

it("limits previews to the visible scroll range without IntersectionObserver", async () => {
  vi.stubGlobal("IntersectionObserver", undefined);
  let scrolled = false;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.tagName === "OL") return new DOMRect(0, 0, 112, 63);
      if (this.tagName === "LI") {
        const second = this.querySelector('button[title="План"]') !== null;
        return new DOMRect(0, second === scrolled ? 0 : 70, 112, 63);
      }
      return new DOMRect(0, 0, 112, 63);
    },
  );

  await render();
  expect(previewTexts()).toEqual(["Рост продаж"]);

  scrolled = true;
  await act(async () =>
    host.querySelector("ol")!.dispatchEvent(new Event("scroll")),
  );
  expect(previewTexts()).toEqual(["Обновить прогноз"]);
});
