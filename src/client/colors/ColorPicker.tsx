import * as Dialog from "@radix-ui/react-dialog";
import { Check, Eyedropper, Plus, X } from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ColorFields, ColorSurface } from "./ColorControls";
import {
  clamp,
  hexToRgb,
  hsvToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  type HSV,
} from "./color-values";
import { MAX_SAVED_COLORS, useSavedColors } from "./saved-colors";
import "./color-picker.css";

const BASE_COLORS = [
  "#ffffff",
  "#dbeafe",
  "#dcfce7",
  "#fef3c7",
  "#fee2e2",
  "#172033",
  "#000000",
  "#3b82f6",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a78bfa",
];
type EyeDropperConstructor = new () => {
  open: (options?: { signal?: AbortSignal }) => Promise<{ sRGBHex: string }>;
};
const getEyeDropper = () =>
  (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
const OPEN_EVENT = "miracle-color-picker-open";

export type ColorPickerProps = {
  value: string;
  onChange: (value: string) => void | boolean;
  label: string;
  disabled?: boolean;
  allowTransparent?: boolean;
  compact?: boolean;
  className?: string;
};

export default function ColorPicker({
  value,
  onChange,
  label,
  disabled = false,
  allowTransparent = false,
  compact = false,
  className = "",
}: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState(() =>
    rgbToHsv(hexToRgb(value) ?? { r: 255, g: 255, b: 255 }),
  );
  const [transparent, setTransparent] = useState(
    value === "transparent" && allowTransparent,
  );
  const [position, setPosition] = useState<CSSProperties>({ left: 8, top: 8 });
  const [eyeError, setEyeError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const eyeAbort = useRef<AbortController | null>(null);
  const lastEmitted = useRef<string | null>(null);
  const id = useId();
  const palette = useSavedColors();
  const color = rgbToHex(hsvToRgb(hsv));
  const isSaved = palette.colors.some(
    (saved) => normalizeHex(saved.color) === color,
  );

  useEffect(() => {
    const next = normalizeHex(value);
    setTransparent(value === "transparent" && allowTransparent);
    if (next && next !== lastEmitted.current)
      setHsv((previous) => rgbToHsv(hexToRgb(next)!, previous));
    lastEmitted.current = null;
  }, [value, allowTransparent]);
  useEffect(() => {
    const closeOther = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    window.addEventListener(OPEN_EVENT, closeOther);
    return () => {
      window.removeEventListener(OPEN_EVENT, closeOther);
      eyeAbort.current?.abort();
    };
  }, [id]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) {
      eyeAbort.current?.abort();
      setEyeError(null);
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !panel) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(),
        content = panel.getBoundingClientRect();
      if (!anchor || !content) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth,
        height = viewport?.height ?? window.innerHeight;
      const x = viewport?.offsetLeft ?? 0,
        y = viewport?.offsetTop ?? 0;
      const available = Math.max(0, height - 16);
      const panelHeight = Math.min(content.height, available);
      const below = anchor.bottom + 8;
      const top =
        below + panelHeight <= y + height - 8
          ? below
          : anchor.top - panelHeight - 8;
      setPosition({
        left: clamp(
          anchor.left,
          x + 8,
          Math.max(x + 8, x + width - content.width - 8),
        ),
        top: clamp(top, y + 8, Math.max(y + 8, y + height - panelHeight - 8)),
        maxHeight: available,
      });
    };
    place();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(panel);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [open, panel]);

  const changeHsv = (next: HSV) => {
    if (disabled) return false;
    const hex = rgbToHex(hsvToRgb(next));
    if (value !== hex && onChange(hex) === false) return false;
    setHsv(next);
    setTransparent(false);
    lastEmitted.current = hex;
    return true;
  };
  const choose = (next: string, intent?: HSV) => {
    const rgb = hexToRgb(next);
    return rgb ? changeHsv(intent ?? rgbToHsv(rgb, hsv)) : false;
  };
  const pickFromScreen = async () => {
    const Constructor = getEyeDropper();
    if (!Constructor || picking || disabled) return;
    const controller = new AbortController();
    eyeAbort.current = controller;
    setPicking(true);
    setEyeError(null);
    try {
      const result = await new Constructor().open({
        signal: controller.signal,
      });
      if (!controller.signal.aborted) choose(result.sRGBHex);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        setEyeError("Не удалось получить цвет с экрана");
    } finally {
      if (eyeAbort.current === controller) {
        eyeAbort.current = null;
        setPicking(false);
      }
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next && disabled) return;
        if (next)
          window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <button
          type="button"
          ref={trigger}
          className={`miracle-color-trigger nokey nodrag ${compact ? "is-compact" : ""} ${className}`}
          aria-label={label}
          title={label}
          disabled={disabled}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
        >
          <span
            className={`miracle-color-chip ${transparent ? "is-transparent" : ""}`}
            style={
              transparent
                ? undefined
                : { backgroundColor: normalizeHex(value) ?? color }
            }
          />
          {!compact && (
            <span className="miracle-color-trigger-value">
              {transparent
                ? "Без заливки"
                : (normalizeHex(value) ?? color).toUpperCase()}
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Content
          ref={setPanel}
          className="miracle-color-picker nokey nodrag"
          style={position}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
          onCopy={(event) => event.stopPropagation()}
          onCut={(event) => event.stopPropagation()}
          onPaste={(event) => event.stopPropagation()}
        >
          <div className="miracle-color-heading">
            <Dialog.Title>{label}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="miracle-color-icon"
                aria-label="Закрыть выбор цвета"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <ColorSurface value={hsv} onChange={changeHsv} />
          <div className="miracle-color-hue-row">
            <span
              className={`miracle-color-preview ${transparent ? "is-transparent" : ""}`}
              aria-label={
                transparent
                  ? "Без заливки"
                  : `Текущий цвет ${color.toUpperCase()}`
              }
              style={transparent ? undefined : { backgroundColor: color }}
            />
            <input
              type="range"
              className="miracle-color-hue"
              aria-label="Оттенок"
              min={0}
              max={360}
              step={1}
              value={hsv.h}
              aria-valuetext={`${Math.round(hsv.h)}°`}
              onChange={(event) =>
                changeHsv({ ...hsv, h: Number(event.target.value) })
              }
            />
            {getEyeDropper() && (
              <button
                type="button"
                className="miracle-color-icon"
                aria-label="Пипетка"
                title="Выбрать цвет с экрана"
                disabled={picking}
                onClick={() => void pickFromScreen()}
              >
                <Eyedropper size={17} />
              </button>
            )}
          </div>
          <ColorFields color={color} hue={hsv.h} onChange={choose} />
          {allowTransparent && (
            <button
              type="button"
              className="miracle-color-no-fill"
              aria-label="Без заливки"
              aria-pressed={transparent}
              onClick={() => {
                if (onChange("transparent") !== false) {
                  setTransparent(true);
                  lastEmitted.current = "transparent";
                }
              }}
            >
              <span className="miracle-color-chip is-transparent" />
              Без заливки{transparent && <Check size={14} />}
            </button>
          )}
          <div className="miracle-color-palette-section">
            <span className="miracle-color-section-label">Базовые цвета</span>
            <div
              className="miracle-color-swatches"
              role="group"
              aria-label="Базовые цвета"
            >
              {BASE_COLORS.map((hex) => (
                <button
                  type="button"
                  key={hex}
                  className="miracle-color-swatch"
                  aria-label={`Базовый цвет ${hex.toUpperCase()}`}
                  title={hex.toUpperCase()}
                  aria-pressed={!transparent && color === hex}
                  style={{ backgroundColor: hex }}
                  onClick={() => choose(hex)}
                />
              ))}
            </div>
          </div>
          <div className="miracle-color-palette-section">
            <div className="miracle-color-saved-heading">
              <span className="miracle-color-section-label">
                Сохранённые цвета
              </span>
              <button
                type="button"
                className="miracle-color-icon"
                aria-label="Сохранить текущий цвет"
                title={
                  isSaved
                    ? "Цвет уже сохранён"
                    : palette.colors.length >= MAX_SAVED_COLORS
                      ? `Не более ${MAX_SAVED_COLORS} цветов`
                      : "Сохранить текущий цвет"
                }
                disabled={
                  transparent ||
                  isSaved ||
                  palette.colors.length >= MAX_SAVED_COLORS
                }
                onClick={() => palette.add(color)}
              >
                {isSaved && !transparent ? (
                  <Check size={15} />
                ) : (
                  <Plus size={15} />
                )}
              </button>
            </div>
            {palette.colors.length ? (
              <div
                className="miracle-color-swatches"
                role="group"
                aria-label="Сохранённые цвета"
              >
                {palette.colors.map((saved) => (
                  <button
                    type="button"
                    key={saved.id}
                    className="miracle-color-swatch"
                    aria-label={`${saved.name} · ${saved.color.toUpperCase()}`}
                    title={`${saved.name} · ${saved.color.toUpperCase()}`}
                    aria-pressed={
                      !transparent && color === normalizeHex(saved.color)
                    }
                    style={{ backgroundColor: saved.color }}
                    onClick={() => choose(saved.color)}
                  />
                ))}
              </div>
            ) : (
              <p className="miracle-color-empty">Сохраните цвет кнопкой +</p>
            )}
          </div>
          {(palette.error || eyeError) && (
            <p className="miracle-color-error" role="alert">
              {palette.error || eyeError}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
