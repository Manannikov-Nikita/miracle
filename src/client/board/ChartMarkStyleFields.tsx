import { ArrowCounterClockwise } from "@phosphor-icons/react";
import type { ChartMarkStyle } from "../../shared/types";
import ColorPicker from "../colors/ColorPicker";
import { Select } from "../components/Select";
import "./chart-mark-settings.css";

export function setMarkProperty<K extends keyof ChartMarkStyle>(
  style: ChartMarkStyle,
  property: K,
  value: ChartMarkStyle[K],
): ChartMarkStyle {
  const next = { ...style };
  if (value === undefined) delete next[property];
  else next[property] = value;
  return next;
}

export default function ChartMarkStyleFields({
  style,
  context,
  disabled,
  onChange,
  baseColor,
  includeColor = false,
}: {
  style: ChartMarkStyle;
  context: string;
  disabled: boolean;
  onChange: (next: ChartMarkStyle) => void;
  baseColor: string;
  includeColor?: boolean;
}) {
  const set = <K extends keyof ChartMarkStyle>(
    key: K,
    value: ChartMarkStyle[K],
  ) => onChange(setMarkProperty(style, key, value));
  const colorField = (property: "color" | "borderColor", label: string) => (
    <div className="chart-mark-color">
      <span>{label}</span>
      <ColorPicker
        label={`${label} · ${context}`}
        value={style[property] ?? style.color ?? baseColor}
        disabled={disabled}
        onChange={(color) => set(property, color)}
        compact
      />
      <span className="chart-mark-color-value">
        {style[property] ?? "Авто"}
      </span>
      <button
        type="button"
        className="chart-mark-icon"
        disabled={disabled || !style[property]}
        aria-label={`Сбросить · ${label} · ${context}`}
        onClick={() => set(property, undefined)}
      >
        <ArrowCounterClockwise size={14} aria-hidden="true" />
      </button>
    </div>
  );
  return (
    <div className="chart-mark-fields">
      {includeColor && colorField("color", "Цвет")}
      <label>
        Непрозрачность, %
        <input
          type="number"
          aria-label={`Непрозрачность · ${context}`}
          min={0}
          max={100}
          step="any"
          placeholder="Авто"
          disabled={disabled}
          value={
            style.opacity === undefined
              ? ""
              : Number((style.opacity * 100).toFixed(8))
          }
          onChange={(e) => {
            if (e.target.value === "") set("opacity", undefined);
            else if (e.target.validity.valid)
              set("opacity", e.target.valueAsNumber / 100);
          }}
        />
      </label>
      <label>
        Узор
        <Select
          aria-label={`Узор · ${context}`}
          value={style.pattern ?? ""}
          disabled={disabled}
          options={[
            { value: "", label: "Авто" },
            { value: "none", label: "Без узора" },
            { value: "diagonal", label: "Диагональ" },
            { value: "crosshatch", label: "Штриховка крестом" },
            { value: "dots", label: "Точки" },
          ]}
          onValueChange={(value) =>
            set("pattern", (value || undefined) as ChartMarkStyle["pattern"])
          }
        />
      </label>
      {colorField("borderColor", "Цвет обводки")}
      <label>
        Толщина, px
        <input
          type="number"
          aria-label={`Толщина обводки · ${context}`}
          min={0}
          max={8}
          step="any"
          placeholder="Авто"
          disabled={disabled}
          value={style.borderWidth ?? ""}
          onChange={(e) => {
            if (e.target.value === "") set("borderWidth", undefined);
            else if (e.target.validity.valid)
              set("borderWidth", e.target.valueAsNumber);
          }}
        />
      </label>
      <label>
        Линия обводки
        <Select
          aria-label={`Линия обводки · ${context}`}
          value={style.borderStyle ?? ""}
          disabled={disabled}
          options={[
            { value: "", label: "Авто" },
            { value: "solid", label: "Сплошная" },
            { value: "dashed", label: "Штриховая" },
            { value: "dotted", label: "Точечная" },
          ]}
          onValueChange={(value) =>
            set(
              "borderStyle",
              (value || undefined) as ChartMarkStyle["borderStyle"],
            )
          }
        />
      </label>
    </div>
  );
}
