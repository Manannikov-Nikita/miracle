import { useEffect, useState, type ReactNode } from "react";
import {
  SHAPE_OPTIONS,
  resolveShape,
  type ShapeSpec,
} from "../../shared/shapes";
import { Select } from "../components/Select";
import type { TextStyleSpec } from "../../shared/text-style";
import ColorPicker from "../colors/ColorPicker";
import "./shape-settings.css";

const validColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

function ColorField({
  label,
  value,
  disabled,
  allowTransparent = false,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  allowTransparent?: boolean;
  onChange: (value: string) => void;
}) {
  const transparent = value === "transparent";
  const [draft, setDraft] = useState(transparent ? "" : value);
  useEffect(() => setDraft(value === "transparent" ? "" : value), [value]);
  return (
    <div className="shape-color-field" role="group" aria-label={label}>
      <div className="shape-color-row">
        <span>{label}</span>
        <ColorPicker
          label={`Цвет · ${label}`}
          value={value}
          disabled={disabled}
          allowTransparent={allowTransparent}
          compact
          onChange={onChange}
        />
        <input
          className="shape-color-hex"
          aria-label={`HEX · ${label}`}
          aria-invalid={
            (!validColor(draft) && !(transparent && draft === "")) || undefined
          }
          value={draft}
          placeholder={transparent ? "Нет" : "#000000"}
          maxLength={7}
          spellCheck={false}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            if (validColor(next)) onChange(next.toLowerCase());
          }}
          onBlur={() => setDraft(transparent ? "" : value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Enter") {
              event.preventDefault();
              setDraft(transparent ? "" : value);
              event.currentTarget.blur();
            }
          }}
        />
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const number = Number(draft);
  const valid =
    draft.trim() !== "" &&
    Number.isFinite(number) &&
    number >= min &&
    number <= max;
  return (
    <label>
      {label}
      <input
        type="number"
        aria-label={label}
        aria-invalid={!valid || undefined}
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const number = Number(next);
          if (
            next.trim() !== "" &&
            Number.isFinite(number) &&
            number >= min &&
            number <= max
          )
            onChange(number);
        }}
        onBlur={() => setDraft(String(value))}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Enter") {
            event.preventDefault();
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function Toggle({
  label,
  active,
  disabled,
  children,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function TextSettings({
  value,
  disabled,
  update,
}: {
  value: Required<TextStyleSpec>;
  disabled: boolean;
  update: (patch: Partial<TextStyleSpec>) => void;
}) {
  return (
    <fieldset className="shape-settings-section">
      <legend>Оформление текста</legend>
      <div className="shape-settings-grid">
        <label>
          Шрифт
          <Select
            aria-label="Шрифт"
            value={value.fontFamily}
            disabled={disabled}
            options={[
              { value: "sans", label: "Без засечек" },
              { value: "serif", label: "С засечками" },
              { value: "mono", label: "Моноширинный" },
            ]}
            onValueChange={(fontFamily) =>
              update({ fontFamily: fontFamily as TextStyleSpec["fontFamily"] })
            }
          />
        </label>
        <NumberField
          label="Размер текста"
          value={value.fontSize}
          min={8}
          max={144}
          disabled={disabled}
          onChange={(fontSize) => update({ fontSize })}
        />
      </div>
      <div
        className="shape-settings-segments"
        role="group"
        aria-label="Начертание текста"
      >
        <Toggle
          label="Жирный"
          active={value.bold}
          disabled={disabled}
          onClick={() => update({ bold: !value.bold })}
        >
          <b>Ж</b>
        </Toggle>
        <Toggle
          label="Курсив"
          active={value.italic}
          disabled={disabled}
          onClick={() => update({ italic: !value.italic })}
        >
          <i>К</i>
        </Toggle>
        <Toggle
          label="Подчёркнутый"
          active={value.underline}
          disabled={disabled}
          onClick={() => update({ underline: !value.underline })}
        >
          <u>Ч</u>
        </Toggle>
      </div>
      <ColorField
        label="Текст"
        value={value.textColor}
        disabled={disabled}
        onChange={(textColor) => update({ textColor })}
      />
      <div className="shape-settings-alignment">
        <span>По горизонтали</span>
        <div
          className="shape-settings-segments"
          role="group"
          aria-label="Выравнивание текста по горизонтали"
        >
          <Toggle
            label="Текст по левому краю"
            active={value.textAlign === "left"}
            disabled={disabled}
            onClick={() => update({ textAlign: "left" })}
          >
            Слева
          </Toggle>
          <Toggle
            label="Текст по центру"
            active={value.textAlign === "center"}
            disabled={disabled}
            onClick={() => update({ textAlign: "center" })}
          >
            По центру
          </Toggle>
          <Toggle
            label="Текст по правому краю"
            active={value.textAlign === "right"}
            disabled={disabled}
            onClick={() => update({ textAlign: "right" })}
          >
            Справа
          </Toggle>
        </div>
      </div>
      <div className="shape-settings-alignment">
        <span>По вертикали</span>
        <div
          className="shape-settings-segments"
          role="group"
          aria-label="Выравнивание текста по вертикали"
        >
          <Toggle
            label="Текст сверху"
            active={value.verticalAlign === "top"}
            disabled={disabled}
            onClick={() => update({ verticalAlign: "top" })}
          >
            Сверху
          </Toggle>
          <Toggle
            label="Текст посередине"
            active={value.verticalAlign === "middle"}
            disabled={disabled}
            onClick={() => update({ verticalAlign: "middle" })}
          >
            Посередине
          </Toggle>
          <Toggle
            label="Текст снизу"
            active={value.verticalAlign === "bottom"}
            disabled={disabled}
            onClick={() => update({ verticalAlign: "bottom" })}
          >
            Снизу
          </Toggle>
        </div>
      </div>
    </fieldset>
  );
}

export default function ShapeSettings({
  shape,
  text,
  disabled,
  onChange,
}: {
  shape: ShapeSpec;
  text: string;
  disabled: boolean;
  onChange: (patch: { shape?: ShapeSpec; text?: string }) => void;
}) {
  const value = resolveShape(shape);
  const update = (patch: Partial<ShapeSpec>) => {
    if (!disabled) onChange({ shape: { ...shape, ...patch } });
  };
  return (
    <div
      className="shape-settings nokey"
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
    >
      <label>
        Вид фигуры
        <Select
          aria-label="Вид фигуры"
          value={value.type}
          disabled={disabled}
          options={SHAPE_OPTIONS.map(({ type, label }) => ({
            value: type,
            label,
          }))}
          onValueChange={(type) => update({ type: type as ShapeSpec["type"] })}
        />
      </label>
      <label>
        Текст фигуры
        <textarea
          aria-label="Текст фигуры"
          className="shape-text-editor"
          maxLength={200000}
          value={text}
          readOnly={disabled}
          placeholder="Введите текст…"
          onChange={(event) => {
            if (!disabled) onChange({ text: event.target.value });
          }}
        />
      </label>
      <fieldset className="shape-settings-section">
        <legend>Оформление фигуры</legend>
        <ColorField
          label="Заливка"
          value={value.fill}
          disabled={disabled}
          allowTransparent
          onChange={(fill) => update({ fill })}
        />
        <ColorField
          label="Обводка"
          value={value.stroke}
          disabled={disabled}
          onChange={(stroke) => update({ stroke })}
        />
        <div className="shape-settings-grid">
          <label>
            Стиль обводки
            <Select
              aria-label="Стиль обводки"
              value={value.strokeStyle}
              disabled={disabled}
              options={[
                { value: "solid", label: "Сплошная" },
                { value: "dashed", label: "Пунктирная" },
                { value: "dotted", label: "Точечная" },
              ]}
              onValueChange={(strokeStyle) =>
                update({ strokeStyle: strokeStyle as ShapeSpec["strokeStyle"] })
              }
            />
          </label>
          <NumberField
            label="Толщина обводки"
            value={value.strokeWidth}
            min={0}
            max={12}
            step={0.5}
            disabled={disabled}
            onChange={(strokeWidth) => update({ strokeWidth })}
          />
          <NumberField
            label="Непрозрачность, %"
            value={Number((value.opacity * 100).toFixed(6))}
            min={0}
            max={100}
            step={0.1}
            disabled={disabled}
            onChange={(opacity) => update({ opacity: opacity / 100 })}
          />
          {(value.type === "rectangle" ||
            value.type === "rounded-rectangle") && (
            <NumberField
              label="Скругление, %"
              value={value.cornerRadius}
              min={0}
              max={50}
              disabled={disabled}
              onChange={(cornerRadius) => update({ cornerRadius })}
            />
          )}
        </div>
      </fieldset>
      <TextSettings value={value} disabled={disabled} update={update} />
    </div>
  );
}
