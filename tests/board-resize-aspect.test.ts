import { describe, expect, it } from "vitest";
import { preserveResizeAspect } from "../src/client/board/resize-aspect";
import type { ResizeSides } from "../src/client/board/resize-snapping";

const start = { x: 100, y: 200, width: 600, height: 400 };
const corners: ResizeSides[] = [
  { left: true, top: true },
  { right: true, top: true },
  { left: true, bottom: true },
  { right: true, bottom: true },
];
describe("proportional corner resize", () => {
  it("accepts the direction metadata emitted by real XYFlow movement callbacks", () => {
    const raw = { ...start, width: 900, height: 450, direction: [1, 1] };
    expect(preserveResizeAspect(raw, start, corners[3])).toEqual({
      ...start,
      width: 900,
      height: 600,
    });
  });
  it("keeps fractional geometry within the exact saved-board maximum", () => {
    const original = { ...start, width: 280.01, height: 180.01 };
    const resized = preserveResizeAspect(
      { ...original, width: 20000, height: 8000 },
      original,
      corners[3],
    );
    expect(resized.width).toBe(10000);
    expect(resized.height).toBeLessThanOrEqual(10000);
    expect(resized.width / resized.height).toBeCloseTo(
      original.width / original.height,
      12,
    );
  });
  it.each(corners)(
    "keeps the initial ratio and opposite corner for %o",
    (sides) => {
      const raw = { x: -9, y: -19, width: 900, height: 450 };
      const result = preserveResizeAspect(raw, start, sides);
      expect(result).toEqual({
        x: sides.left ? -200 : 100,
        y: sides.top ? 0 : 200,
        width: 900,
        height: 600,
      });
      expect(start).toEqual({ x: 100, y: 200, width: 600, height: 400 });
      expect(raw).toEqual({ x: -9, y: -19, width: 900, height: 450 });
    },
  );
  it("supports height-led growth and fractional dimensions without rounding drift", () => {
    const original = { x: 0.25, y: 1.5, width: 537.5, height: 312.25 };
    const result = preserveResizeAspect(
      { ...original, width: 538, height: 408.75 },
      original,
      { right: true, bottom: true },
    );
    expect(result.height).toBeCloseTo(408.75, 10);
    expect(result.width / result.height).toBeCloseTo(
      original.width / original.height,
      12,
    );
    expect(result.x).toBe(original.x);
    expect(result.y).toBe(original.y);
  });
  it("shrinks while applying both minimum dimensions as one constraint", () => {
    const result = preserveResizeAspect(
      { x: 300, y: 400, width: 280, height: 180 },
      start,
      { left: true, top: true },
    );
    expect(result.width).toBe(280);
    expect(result.height).toBeCloseTo(280 / 1.5, 10);
    expect(result.x + result.width).toBe(700);
    expect(result.y + result.height).toBe(600);
    const tall = { ...start, width: 300, height: 900 };
    const constrained = preserveResizeAspect(
      { ...tall, width: 280, height: 180 },
      tall,
      { right: true, bottom: true },
    );
    expect(constrained).toEqual({ ...tall, width: 280, height: 840 });
  });
  it("caps both dimensions together at the board size limit", () => {
    const result = preserveResizeAspect(
      { ...start, width: 20000, height: 8000 },
      start,
      { left: true, top: true },
    );
    expect(result.width).toBe(10000);
    expect(result.height).toBeCloseTo(10000 / 1.5, 9);
    expect(result.x + result.width).toBe(700);
    expect(result.y + result.height).toBeCloseTo(600, 9);
  });
  it.each<ResizeSides>([
    { left: true },
    { right: true },
    { top: true },
    { bottom: true },
    {},
    { left: true, right: true, bottom: true },
  ])("leaves non-corner %o untouched", (sides) => {
    const raw = { ...start, width: 733, height: 455 };
    expect(preserveResizeAspect(raw, start, sides)).toBe(raw);
  });
  it("does not divide by an invalid initial size", () => {
    const raw = { ...start, width: 733, height: 455 };
    expect(preserveResizeAspect(raw, { ...start, height: 0 }, corners[0])).toBe(
      raw,
    );
  });
});
