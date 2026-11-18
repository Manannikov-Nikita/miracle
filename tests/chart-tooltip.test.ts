// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ChartTooltip from "../src/client/board/chart-kit/ChartTooltip";

type Props = ComponentProps<typeof ChartTooltip>;
let host: HTMLDivElement;
let root: Root;
let cardWidth: number;
let cardHeight: number;
let resize: ResizeObserverCallback;
const sample: Props = {
  title: "Февраль",
  x: 20,
  y: 30,
  width: 300,
  height: 180,
  rows: [
    { key: "sales", name: "Продажи", value: "12 990 ₽", color: "#71bdee" },
  ],
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  cardWidth = 130;
  cardHeight = 68;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("chart-tooltip") ? cardWidth : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("chart-tooltip") ? cardHeight : 20;
    },
  );
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
    function (this: Element) {
      return this.classList.contains("chart-tooltip") ? cardHeight - 2 : 20;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(28);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(patch: Partial<Props> = {}) {
  await act(async () =>
    root.render(createElement(ChartTooltip, { ...sample, ...patch })),
  );
  return host.querySelector<HTMLElement>('[role="tooltip"]')!;
}

it("flips to the left and above near the edges using layout pixels independent of board zoom", async () => {
  const screenBounds = vi.spyOn(Element.prototype, "getBoundingClientRect");
  const card = await render({ id: "chart-detail" });
  expect(card.id).toBe("chart-detail");
  expect([card.style.left, card.style.top]).toEqual(["32px", "42px"]);
  await render({ x: 20, y: 95 });
  expect([card.style.left, card.style.top]).toEqual(["32px", "15px"]);
  await render({ x: 294, y: 174 });
  expect([card.style.left, card.style.top]).toEqual(["152px", "94px"]);
  cardWidth = 180;
  cardHeight = 90;
  await act(async () => resize([], {} as ResizeObserver));
  expect([card.style.left, card.style.top]).toEqual(["102px", "72px"]);
  expect(screenBounds).not.toHaveBeenCalled();
});

it("keeps the active series in constrained charts and expands the list when space returns", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    key: String(i),
    name: `Ряд ${i}`,
    value: String(i),
    color: "#16ad80",
    active: i >= 8,
  }));
  const card = await render({ rows, width: 140, height: 98 });
  expect(card.getAttribute("aria-live")).toBe("polite");
  expect(
    Array.from(
      card.querySelectorAll(".chart-tooltip-row[data-active=true]"),
      (row) => row.textContent,
    ),
  ).toEqual(["Ряд 88", "Ряд 99"]);
  expect(card.querySelector(".chart-tooltip-more")?.textContent).toBe("+7");
  expect(card.querySelectorAll(".chart-tooltip-row")).toHaveLength(3);
  await render({ rows, height: 400 });
  expect(card.querySelectorAll(".chart-tooltip-row")).toHaveLength(10);
  expect(card.querySelector(".chart-tooltip-more")).toBeNull();
  expect(
    card.querySelector(".chart-tooltip-swatch")?.getAttribute("aria-hidden"),
  ).toBe("true");
});

it("uses a compact row and clamps oversized cards and out-of-bounds anchors", async () => {
  cardWidth = 81;
  cardHeight = 26;
  const card = await render({ width: 85, height: 30, x: 110, y: -8 });
  expect(card.hasAttribute("data-compact")).toBe(true);
  expect(card.style.maxWidth).toBe("80px");
  expect(card.style.maxHeight).toBe("25px");
  expect(card.style.left).toBe("2.5px");
  expect(card.style.top).toBe("2.5px");
  expect(card.textContent).toContain("12 990 ₽");
});
