import { describe, expect, it } from "vitest";
import {
  hexToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
  rgbToHsl,
  hslToRgb,
  parseColorChannels,
} from "../src/client/colors/color-values";

describe("solid color conversion", () => {
  it("normalizes short and full HEX without accepting incomplete or alpha values", () => {
    expect(normalizeHex(" #AbC ")).toBe("#aabbcc");
    expect(normalizeHex("DbeAFE")).toBe("#dbeafe");
    for (const input of [
      "",
      "#12",
      "#abcd",
      "#12345678",
      "red",
      "transparent",
      "#gggggg",
    ])
      expect(normalizeHex(input)).toBeNull();
  });
  it.each([
    [
      "#ff0000",
      { r: 255, g: 0, b: 0 },
      { h: 0, s: 100, v: 100 },
      { h: 0, s: 100, l: 50 },
    ],
    [
      "#00ff00",
      { r: 0, g: 255, b: 0 },
      { h: 120, s: 100, v: 100 },
      { h: 120, s: 100, l: 50 },
    ],
    [
      "#0000ff",
      { r: 0, g: 0, b: 255 },
      { h: 240, s: 100, v: 100 },
      { h: 240, s: 100, l: 50 },
    ],
    [
      "#ffffff",
      { r: 255, g: 255, b: 255 },
      { h: 0, s: 0, v: 100 },
      { h: 0, s: 0, l: 100 },
    ],
    [
      "#000000",
      { r: 0, g: 0, b: 0 },
      { h: 0, s: 0, v: 0 },
      { h: 0, s: 0, l: 0 },
    ],
  ])("converts known vector %s", (hex, rgb, hsv, hsl) => {
    expect(hexToRgb(hex)).toEqual(rgb);
    expect(rgbToHex(rgb)).toBe(hex);
    expect(rgbToHsv(rgb)).toEqual(hsv);
    expect(hsvToRgb(hsv)).toEqual(rgb);
    expect(rgbToHsl(rgb)).toEqual(hsl);
    expect(hslToRgb(hsl)).toEqual(rgb);
  });
  it("round trips arbitrary RGB colors without quantizing HSV/HSL early", () => {
    for (const hex of [
      "#172033",
      "#dbeafe",
      "#3b82f6",
      "#d18354",
      "#010203",
      "#808080",
    ]) {
      const rgb = hexToRgb(hex)!;
      expect(rgbToHex(hsvToRgb(rgbToHsv(rgb)))).toBe(hex);
      expect(rgbToHex(hslToRgb(rgbToHsl(rgb)))).toBe(hex);
    }
  });
  it("retains hue for gray and both hue and saturation for black", () => {
    const previous = { h: 240, s: 75, v: 50 };
    expect(rgbToHsv({ r: 0, g: 0, b: 0 }, previous)).toEqual({
      h: 240,
      s: 75,
      v: 0,
    });
    expect(rgbToHsv({ r: 128, g: 128, b: 128 }, previous)).toMatchObject({
      h: 240,
      s: 0,
    });
  });
  it("rejects empty, out-of-range and fractional RGB drafts", () => {
    expect(parseColorChannels("RGB", ["255", "0", "128"])).toBe("#ff0080");
    expect(parseColorChannels("HSL", ["360", "100", "50"])).toBe("#ff0000");
    for (const draft of [
      ["", "0", "0"],
      ["256", "0", "0"],
      ["1.5", "0", "0"],
      ["NaN", "0", "0"],
      ["1e2", "0", "0"],
    ])
      expect(parseColorChannels("RGB", draft)).toBeNull();
    expect(parseColorChannels("HSL", ["361", "100", "50"])).toBeNull();
    expect(parseColorChannels("HSL", ["20", "-1", "50"])).toBeNull();
  });
});
