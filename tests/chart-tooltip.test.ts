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
  expect(card.style.transform).toBe("translate3d(32px, 42px, 0)");
  await render({ x: 20, y: 95 });
  expect(card.style.transform).toBe("translate3d(32px, 15px, 0)");
  await render({ x: 294, y: 174 });
  expect(card.style.transform).toBe("translate3d(152px, 94px, 0)");
  cardWidth = 180;
  cardHeight = 90;
  await act(async () => resize([], {} as ResizeObserver));
  expect(card.style.transform).toBe("translate3d(102px, 72px, 0)");
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
  expect(card.style.transform).toBe("translate3d(2.5px, 2.5px, 0)");
  expect(card.textContent).toContain("12 990 ₽");
});

it("places the first card without motion, retargets its transform and snaps for keyboard navigation", async () => {
  const card = await render({ x: 155, y: 95 });
  expect(card.style.transform).toBe("translate3d(13px, 15px, 0)");
  expect(card.hasAttribute("data-motion")).toBe(false);
  cardWidth = 134;
  await act(async () => resize([], {} as ResizeObserver));
  expect(card.hasAttribute("data-motion")).toBe(false);
  await render({ x: 159, y: 100 });
  expect(card.dataset.motion).toBe("true");
  expect(card.style.transform).toBe("translate3d(13px, 20px, 0)");
  // A small reversal near the threshold keeps this card on its chosen side.
  await render({ x: 150, y: 100 });
  expect(card.style.transform).toBe("translate3d(4px, 20px, 0)");
  await render({ x: 40, y: 110, motion: false });
  expect(card.hasAttribute("data-motion")).toBe(false);
  expect(card.style.transform).toBe("translate3d(52px, 30px, 0)");
  await render({ x: 42, y: 111 });
  expect(card.dataset.motion).toBe("true");
  expect(card.style.transform).toBe("translate3d(54px, 31px, 0)");
});

it("snaps a growing tooltip before it can glide outside the chart, then resumes following", async () => {
  let visualX = 278;
  const readTransform = vi.fn();
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      m41 = visualX;
      m42 = 42;
      constructor(transform: string) {
        readTransform(transform);
      }
    },
  );
  cardWidth = 40;
  const start = { x: 265, width: 340, height: 180 };
  const card = await render(start);
  await render({ ...start, x: 266 });
  expect(card.dataset.motion).toBe("true");
  expect(readTransform).not.toHaveBeenCalled();
  // The position still on screen is near x=278. The longer tooltip needs x<=136.
  cardWidth = 200;
  await render({
    ...start,
    x: 267,
    title: "Продажи, включая дополнительные начисления",
  });
  expect(readTransform).toHaveBeenCalledTimes(1);
  expect(card.hasAttribute("data-motion")).toBe(false);
  expect(card.style.transform).toBe("translate3d(55px, 42px, 0)");
  await render({ ...start, x: 267 });
  expect(card.hasAttribute("data-motion")).toBe(false);
  await render({ ...start, x: 263 });
  expect(card.dataset.motion).toBe("true");
  // A small growth with the running animation already in bounds stays smooth.
  visualX = 54;
  cardWidth = 204;
  await act(async () => resize([], {} as ResizeObserver));
  expect(readTransform).toHaveBeenCalledTimes(2);
  expect(card.dataset.motion).toBe("true");
});
