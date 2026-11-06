// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PresentationSlides from "../src/client/board/PresentationSlides";
import type { BoardDocument } from "../src/shared/types";

vi.mock("../src/client/board/PresentationThumbnail", () => ({
  default: () => null,
}));

const initialDocument: BoardDocument = {
  schemaVersion: 1,
  kind: "presentation",
  slides: ["a", "b", "c", "d"].map((id) => ({
    id,
    title: id.toUpperCase(),
    background: "#ffffff",
  })),
  nodes: [],
  edges: [],
};

describe("live presentation slide reordering", () => {
  let host: HTMLDivElement;
  let root: Root;
  let deck: BoardDocument;
  let boardId: string;
  let structureEditable: boolean;
  let transfer: DataTransfer;
  const onReorder = vi.fn();
  const onSelect = vi.fn();
  const noop = () => {};
  const rect = (top: number, height = 90) => ({
    x: 0,
    y: top,
    left: 0,
    top,
    right: 120,
    bottom: top + height,
    width: 120,
    height,
    toJSON() {},
  });
  const list = () => host.querySelector<HTMLOListElement>("ol")!;
  const buttons = () => [
    ...list().querySelectorAll<HTMLButtonElement>(
      ".presentation-slide-thumbnail",
    ),
  ];
  const visualItems = () =>
    [...list().children].sort(
      (a, b) =>
        Number((a as HTMLElement).style.order) -
        Number((b as HTMLElement).style.order),
    );
  const order = () =>
    visualItems().map(
      (item) =>
        item.querySelector<HTMLButtonElement>(".presentation-slide-thumbnail")!
          .title,
    );
  const button = (title: string) =>
    buttons().find((item) => item.title === title)!;

  async function render() {
    await act(async () =>
      root.render(
        createElement(PresentationSlides, {
          boardId,
          document: deck,
          selected:
            deck.slides!.find((slide) => slide.id === "b") ?? deck.slides![0],
          structureEditable,
          metadataEditable: true,
          deletionEditable: true,
          onSelect,
          onAdd: noop,
          onDuplicate: noop,
          onUpdate: noop,
          onRemove: noop,
          onReorder,
        }),
      ),
    );
    list().style.flexDirection = "column";
  }
  async function dragEvent(
    type: string,
    target: EventTarget,
    clientY: number,
    clientX = 60,
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event;
  }
  async function begin(title = "A") {
    const source = button(title);
    source.focus();
    await dragEvent(
      "dragstart",
      source,
      source.getBoundingClientRect().top + 45,
    );
    return source;
  }
  async function hover(clientY: number) {
    const target =
      buttons().find((item) => {
        const bounds = item.getBoundingClientRect();
        return clientY >= bounds.top && clientY <= bounds.bottom;
      }) ?? list();
    return dragEvent("dragover", target, clientY);
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function () {
        const item = this.closest("li");
        if (
          item?.parentElement?.classList.contains("presentation-slide-list")
        ) {
          const index = visualItems().indexOf(item);
          return rect(100 + index * 100);
        }
        return rect(100, 500);
      },
    );
    const values = new Map<string, string>();
    transfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: (type: string, value: string) => {
        values.set(type, value);
      },
      getData: (type: string) => values.get(type) ?? "",
      setDragImage: vi.fn(),
      types: ["application/x-miracle-slide"],
    } as unknown as DataTransfer;
    deck = structuredClone(initialDocument);
    boardId = "deck";
    structureEditable = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    onReorder.mockReset();
    onSelect.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("previews successive positions during the drag and commits once on release", async () => {
    const source = await begin();
    const originalItems = [...list().children];
    const removedNodes: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) removedNodes.push(...record.removedNodes);
    });
    observer.observe(list(), { childList: true, subtree: true });
    await hover(350);
    expect(order()).toEqual(["B", "C", "A", "D"]);
    expect([...list().children]).toEqual(originalItems);
    expect(onReorder).not.toHaveBeenCalled();
    expect(deck.slides!.map((slide) => slide.id)).toEqual(["a", "b", "c", "d"]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(button("B").getAttribute("aria-current")).toBe("true");
    await hover(450);
    expect(order()).toEqual(["B", "C", "D", "A"]);
    expect([...list().children]).toEqual(originalItems);
    observer.disconnect();
    expect(removedNodes.some((node) => node.contains(source))).toBe(false);
    expect(source.isConnected).toBe(true);
    await dragEvent("drop", list(), 450);
    await dragEvent("dragend", source, 450);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", "d");
  });

  it("moves upward without oscillating when the pointer stays in place", async () => {
    await begin("D");
    await hover(140);
    expect(order()).toEqual(["D", "A", "B", "C"]);
    await hover(140);
    await hover(140);
    expect(order()).toEqual(["D", "A", "B", "C"]);
    expect(onReorder).not.toHaveBeenCalled();
    await dragEvent("drop", list(), 140);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("d", "a");
  });

  it("accepts and previews the final dragenter position before a fast drop", async () => {
    await begin();
    await hover(350);
    expect(order()).toEqual(["B", "C", "A", "D"]);
    const enter = await dragEvent(
      "dragenter",
      button("D").querySelector("span")!,
      450,
    );
    expect(enter.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe("move");
    expect(order()).toEqual(["B", "C", "D", "A"]);
    expect(onReorder).not.toHaveBeenCalled();
    await dragEvent("drop", list(), 450);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", "d");
  });

  it("uses the final drop position when it crosses the same child midpoint", async () => {
    await begin();
    await hover(320);
    expect(order()).toEqual(["B", "A", "C", "D"]);
    expect(onReorder).not.toHaveBeenCalled();
    // The pointer stays inside C, so no further dragenter/dragover is guaranteed.
    await dragEvent("drop", button("C").querySelector("span")!, 370);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", "c");
  });

  it("uses horizontal positions when the slide list is a row", async () => {
    list().style.flexDirection = "row";
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function () {
        const item = this.closest("li");
        const index = item ? visualItems().indexOf(item) : 0;
        const left = 100 + index * 100;
        return {
          ...rect(0),
          x: left,
          left,
          right: left + 90,
          width: 90,
        };
      },
    );
    await begin();
    await dragEvent("dragover", list(), 60, 350);
    expect(order()).toEqual(["B", "C", "A", "D"]);
    expect(onReorder).not.toHaveBeenCalled();
    await dragEvent("dragover", list(), 60, 350);
    expect(order()).toEqual(["B", "C", "A", "D"]);
    await dragEvent("drop", list(), 60, 350);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", "c");
  });

  it.each(["escape", "dragend", "outside"])(
    "restores the saved order after %s",
    async (reason) => {
      const source = await begin();
      await hover(350);
      expect(order()).toEqual(["B", "C", "A", "D"]);
      if (reason === "escape") {
        await act(async () => {
          source.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
        });
      } else {
        if (reason === "outside")
          await dragEvent("drop", document.body, 700, 300);
        await dragEvent("dragend", source, 700, 300);
      }
      expect(order()).toEqual(["A", "B", "C", "D"]);
      expect(onReorder).not.toHaveBeenCalled();
    },
  );

  it.each(["order", "remove", "board", "lock"])(
    "cancels a stale drag when %s changes",
    async (reason) => {
      await begin();
      await hover(350);
      expect(order()).toEqual(["B", "C", "A", "D"]);
      if (reason === "order")
        deck = { ...deck, slides: [...deck.slides!].reverse() };
      if (reason === "remove")
        deck = {
          ...deck,
          slides: deck.slides!.filter((slide) => slide.id !== "c"),
        };
      if (reason === "board") boardId = "other-deck";
      if (reason === "lock") structureEditable = false;
      await render();
      expect(order()).toEqual(deck.slides!.map((slide) => slide.title));
      await dragEvent("drop", list(), 350);
      expect(onReorder).not.toHaveBeenCalled();
    },
  );

  it("keeps the preview while receiving metadata updates and shows the latest title", async () => {
    await begin();
    await hover(350);
    deck = {
      ...deck,
      slides: deck.slides!.map((slide) =>
        slide.id === "c"
          ? { ...slide, title: "Updated C", background: "#202225" }
          : slide,
      ),
    };
    await render();
    expect(order()).toEqual(["B", "Updated C", "A", "D"]);
    await dragEvent("drop", list(), 350);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", "c");
  });

  it("does not persist a drag returned to its starting position", async () => {
    await begin();
    await hover(350);
    await hover(140);
    expect(order()).toEqual(["A", "B", "C", "D"]);
    await dragEvent("drop", list(), 140);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("ignores an external drag and never enables a locked slide drag", async () => {
    await hover(350);
    expect(order()).toEqual(["A", "B", "C", "D"]);
    structureEditable = false;
    await render();
    expect(button("A").draggable).toBe(false);
    await begin();
    await hover(350);
    await dragEvent("drop", list(), 350);
    expect(order()).toEqual(["A", "B", "C", "D"]);
    expect(onReorder).not.toHaveBeenCalled();
  });
});
