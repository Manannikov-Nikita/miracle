export type RGB = { r: number; g: number; b: number };
export type HSV = { h: number; s: number; v: number };
export type HSL = { h: number; s: number; l: number };
export type ColorMode = "HEX" | "RGB" | "HSL";

export const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const hue = (value: number) => ((value % 360) + 360) % 360;

export function normalizeHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex))
    return `#${[...hex].map((c) => c + c).join("")}`.toLowerCase();
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

export function hexToRgb(value: string): RGB | null {
  const hex = normalizeHex(value);
  return hex
    ? {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
      }
    : null;
}

export function rgbToHex({ r, g, b }: RGB): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(clamp(c, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function rgbToHsv({ r, g, b }: RGB, previous?: HSV): HSV {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  const h =
    delta === 0
      ? (previous?.h ?? 0)
      : hue(
          60 *
            (max === r
              ? (g - b) / delta
              : max === g
                ? (b - r) / delta + 2
                : (r - g) / delta + 4),
        );
  return {
    h,
    s: max === 0 ? (previous?.s ?? 0) : (delta / max) * 100,
    v: max * 100,
  };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  h = hue(h) / 60;
  s = clamp(s, 0, 100) / 100;
  v = clamp(v, 0, 100) / 100;
  const c = v * s,
    x = c * (1 - Math.abs((h % 2) - 1)),
    m = v - c;
  const [r, g, b] =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export function rgbToHsl(rgb: RGB, previousHue = 0): HSL {
  const hsv = rgbToHsv(rgb, { h: previousHue, s: 0, v: 0 });
  const max = Math.max(rgb.r, rgb.g, rgb.b) / 255,
    min = Math.min(rgb.r, rgb.g, rgb.b) / 255;
  const l = (max + min) / 2;
  return {
    h: hsv.h,
    s: max === min ? 0 : ((max - min) / (1 - Math.abs(2 * l - 1))) * 100,
    l: l * 100,
  };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  l = clamp(l, 0, 100) / 100;
  s = clamp(s, 0, 100) / 100;
  const v = l + s * Math.min(l, 1 - l);
  return hsvToRgb({ h, s: v === 0 ? 0 : 2 * (1 - l / v) * 100, v: v * 100 });
}

export function parseColorChannels(
  mode: "RGB" | "HSL",
  drafts: string[],
): string | null {
  if (
    drafts.length !== 3 ||
    drafts.some((v) => !/^\d+(?:\.\d+)?$/.test(v.trim()))
  )
    return null;
  const [a, b, c] = drafts.map(Number);
  if (mode === "RGB")
    return [a, b, c].every((v) => Number.isInteger(v) && v <= 255)
      ? rgbToHex({ r: a, g: b, b: c })
      : null;
  return a <= 360 && b <= 100 && c <= 100
    ? rgbToHex(hslToRgb({ h: a, s: b, l: c }))
    : null;
}
