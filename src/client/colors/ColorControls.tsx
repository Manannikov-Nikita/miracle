import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  clamp,
  hexToRgb,
  normalizeHex,
  parseColorChannels,
  rgbToHsl,
  type ColorMode,
  type HSV,
} from "./color-values";

export function ColorSurface({
  value,
  onChange,
}: {
  value: HSV;
  onChange: (value: HSV) => void;
}) {
  const pointer = useRef<number | null>(null);
  const update = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    onChange({
      ...value,
      s: clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100),
      v: clamp(100 - ((event.clientY - rect.top) / rect.height) * 100, 0, 100),
    });
  };
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div
      className="miracle-color-surface"
      style={{ backgroundColor: `hsl(${value.h} 100% 50%)` }}
      role="slider"
      tabIndex={0}
      aria-label="Насыщенность и яркость"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value.s)}
      aria-valuetext={`Насыщенность ${Math.round(value.s)}%, яркость ${Math.round(value.v)}%. Влево и вправо — насыщенность, вверх и вниз — яркость.`}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 1;
        const next = { ...value };
        if (event.key === "ArrowLeft") next.s = clamp(value.s - step, 0, 100);
        else if (event.key === "ArrowRight")
          next.s = clamp(value.s + step, 0, 100);
        else if (event.key === "ArrowUp")
          next.v = clamp(value.v + step, 0, 100);
        else if (event.key === "ArrowDown")
          next.v = clamp(value.v - step, 0, 100);
        else if (event.key === "Home") next.v = 100;
        else if (event.key === "End") next.v = 0;
        else return;
        event.preventDefault();
        onChange(next);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || pointer.current !== null) return;
        event.preventDefault();
        event.currentTarget.focus();
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        update(event);
      }}
      onPointerMove={(event) => {
        if (event.pointerId === pointer.current) update(event);
      }}
      onPointerUp={(event) => {
        if (event.pointerId === pointer.current) update(event);
        release(event);
      }}
      onPointerCancel={release}
      onLostPointerCapture={() => {
        pointer.current = null;
      }}
    >
      <span
        className="miracle-color-cursor"
        style={{ left: `${value.s}%`, top: `${100 - value.v}%` }}
      />
    </div>
  );
}

function channelValues(mode: ColorMode, color: string, hue: number): string[] {
  if (mode === "HEX") return [color.slice(1).toUpperCase()];
  const rgb = hexToRgb(color)!;
  if (mode === "RGB") return [rgb.r, rgb.g, rgb.b].map(String);
  const hsl = rgbToHsl(rgb, hue);
  return [hsl.h, hsl.s, hsl.l].map((v) => String(Number(v.toFixed(1))));
}

export function ColorFields({
  color,
  hue,
  onChange,
}: {
  color: string;
  hue: number;
  onChange: (color: string, intent?: HSV) => boolean;
}) {
  const [mode, setMode] = useState<ColorMode>("HEX");
  const [drafts, setDrafts] = useState(() => channelValues("HEX", color, hue));
  const [invalid, setInvalid] = useState(false);
  const lastSent = useRef<string | null>(null);
  useEffect(() => {
    if (lastSent.current === color) {
      lastSent.current = null;
      return;
    }
    setDrafts(channelValues(mode, color, hue));
    setInvalid(false);
  }, [color, hue, mode]);
  const parse = (values: string[]) =>
    mode === "HEX" ? normalizeHex(values[0]) : parseColorChannels(mode, values);
  const emit = (next: string, values: string[]) => {
    lastSent.current = next;
    setInvalid(false);
    let intent: HSV | undefined;
    if (mode === "HSL") {
      const [h, saturation, lightness] = values.map(Number);
      const s = saturation / 100,
        l = lightness / 100;
      const v = l + s * Math.min(l, 1 - l);
      intent = {
        h,
        s: (v === 0 ? (2 * s) / (1 + s) : 2 * (1 - l / v)) * 100,
        v: v * 100,
      };
    }
    if (!onChange(next, intent)) {
      lastSent.current = null;
      setDrafts(channelValues(mode, color, hue));
    }
  };
  const commit = () => {
    const next = parse(drafts);
    if (next) emit(next, drafts);
    else setInvalid(true);
  };
  const labels =
    mode === "HEX"
      ? ["HEX"]
      : mode === "RGB"
        ? ["Красный (R)", "Зелёный (G)", "Синий (B)"]
        : ["Оттенок (H)", "Насыщенность (S)", "Светлота (L)"];
  return (
    <div className="miracle-color-fields">
      <select
        aria-label="Формат цвета"
        value={mode}
        onChange={(event) => {
          const next = event.target.value as ColorMode;
          lastSent.current = null;
          setMode(next);
          setDrafts(channelValues(next, color, hue));
          setInvalid(false);
        }}
      >
        <option>HEX</option>
        <option>RGB</option>
        <option>HSL</option>
      </select>
      <div
        className={`miracle-color-channels miracle-color-channels-${mode.toLowerCase()}`}
      >
        {labels.map((label, index) => (
          <label key={label}>
            <span>{mode === "HEX" ? "#" : mode[index]}</span>
            <input
              aria-label={label}
              aria-invalid={invalid || undefined}
              value={drafts[index] ?? ""}
              inputMode={mode === "HEX" ? "text" : "decimal"}
              spellCheck={false}
              autoComplete="off"
              maxLength={mode === "HEX" ? 7 : 12}
              onChange={(event) => {
                const next = drafts.map((value, i) =>
                  i === index ? event.target.value : value,
                );
                setDrafts(next);
                setInvalid(false);
                const parsed = parse(next);
                // A short HEX can be committed explicitly; don't expand it while a six-digit value is being typed.
                if (
                  parsed &&
                  (mode !== "HEX" || /^#?[\da-f]{6}$/i.test(next[0].trim()))
                )
                  emit(parsed, next);
              }}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                }
              }}
            />
          </label>
        ))}
      </div>
      {invalid && (
        <span className="miracle-color-error" role="alert">
          {mode === "HEX"
            ? "Введите 3 или 6 HEX-символов"
            : mode === "RGB"
              ? "RGB: целые числа от 0 до 255"
              : "H: 0–360, S и L: 0–100"}
        </span>
      )}
    </div>
  );
}
