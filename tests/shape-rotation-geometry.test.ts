import { describe, expect, it } from "vitest";
import {
  normalizeRotation,
  pointerRotation,
  rotatePoint,
  rotatedResize,
  snapRotation,
} from "../src/client/board/shape-rotation";

describe("shape rotation angles", () => {
  it.each([
    [0, 0],
    [360, 0],
    [735, 15],
    [-15, 345],
    [-360, 0],
    [37.25, 37.25],
  ])("normalizes %s degrees to %s", (input, expected) => {
    expect(normalizeRotation(input)).toBe(expected);
  });

  it("keeps free rotation precise and snaps through the zero-degree seam", () => {
    expect(snapRotation(37.25)).toBe(37.25);
    expect(snapRotation(37.25, true)).toBe(30);
    expect(snapRotation(38, true)).toBe(45);
    expect(snapRotation(359, true)).toBe(0);
    expect(snapRotation(-8, true)).toBe(345);
  });

  it.each([
    [{ x: 100, y: 50 }, 0],
    [{ x: 150, y: 100 }, 90],
    [{ x: 100, y: 150 }, 180],
    [{ x: 50, y: 100 }, 270],
    [{ x: 150, y: 50 }, 45],
  ])("measures clockwise from the top for %j", (pointer, expected) => {
    expect(pointerRotation({ x: 100, y: 100 }, pointer)).toBe(expected);
  });

  it("rotates anchors around a translated center", () => {
    const point = rotatePoint({ x: 210, y: 70 }, { x: 110, y: 70 }, 90);
    expect(point.x).toBeCloseTo(110);
    expect(point.y).toBeCloseTo(170);
  });
});

describe("resizing a rotated shape", () => {
  const start = { x: 10, y: 20, width: 200, height: 100 };

  it("keeps ordinary corner resizing unchanged at zero degrees", () => {
    expect(
      rotatedResize(start, 0, { right: true, bottom: true }, { x: 20, y: 30 }),
    ).toEqual({ x: 10, y: 20, width: 220, height: 130 });
  });

  it("uses the local right edge at 90 degrees and keeps its opposite side fixed", () => {
    const resized = rotatedResize(start, 90, { right: true }, { x: 0, y: 40 });
    expect(resized.x).toBeCloseTo(-10);
    expect(resized.y).toBeCloseTo(40);
    expect(resized.width).toBeCloseTo(240);
    expect(resized.height).toBe(100);
    // Left-edge center stays at (110, -30), its original world position.
    const opposite = rotatePoint(
      { x: resized.x, y: resized.y + resized.height / 2 },
      { x: resized.x + resized.width / 2, y: resized.y + resized.height / 2 },
      90,
    );
    expect(opposite.x).toBeCloseTo(110);
    expect(opposite.y).toBeCloseTo(-30);
  });

  it("resizes a 45-degree corner along local axes without moving the opposite corner", () => {
    const resized = rotatedResize(
      { x: 0, y: 0, width: 100, height: 60 },
      45,
      { right: true, bottom: true },
      { x: 0, y: 28.2842712474619 },
    );
    expect(resized.x).toBeCloseTo(-10);
    expect(resized.y).toBeCloseTo(4.14213562373095);
    expect(resized.width).toBeCloseTo(120);
    expect(resized.height).toBeCloseTo(80);
    const opposite = rotatePoint(
      { x: resized.x, y: resized.y },
      { x: resized.x + resized.width / 2, y: resized.y + resized.height / 2 },
      45,
    );
    expect(opposite.x).toBeCloseTo(35.85786437626905);
    expect(opposite.y).toBeCloseTo(-26.568542494923804);
  });

  it("preserves the opposite bottom-right corner when resizing top-left at 90 degrees", () => {
    const resized = rotatedResize(
      { x: 0, y: 0, width: 100, height: 80 },
      90,
      { left: true, top: true },
      { x: 20, y: -30 },
    );
    expect(resized.x).toBeCloseTo(-5);
    expect(resized.y).toBeCloseTo(-25);
    expect(resized.width).toBeCloseTo(130);
    expect(resized.height).toBeCloseTo(100);
  });

  it("stops at the minimum without flipping or moving the opposite anchor", () => {
    const resized = rotatedResize(
      start,
      90,
      { right: true },
      { x: 0, y: -1000 },
    );
    expect(resized.x).toBeCloseTo(90);
    expect(resized.y).toBeCloseTo(-60);
    expect(resized.width).toBe(40);
    expect(resized.height).toBe(100);
  });

  it("preserves aspect ratio in local coordinates when a corner is constrained", () => {
    const resized = rotatedResize(
      start,
      90,
      { right: true, bottom: true },
      { x: -10, y: 100 },
      40,
      true,
    );
    expect(resized.x).toBeCloseTo(-65);
    expect(resized.y).toBeCloseTo(45);
    expect(resized.width).toBe(300);
    expect(resized.height).toBe(150);
  });

  it("caps saved dimensions and ignores ambiguous or inactive sides", () => {
    expect(rotatedResize(start, 0, {}, { x: 500, y: 500 })).toEqual(start);
    expect(
      rotatedResize(start, 0, { left: true, right: true }, { x: 500, y: 500 }),
    ).toEqual(start);
    expect(
      rotatedResize(start, 0, { right: true }, { x: 50000, y: 0 }).width,
    ).toBe(10000);
  });
});
