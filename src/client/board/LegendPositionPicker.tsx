import { useId } from "react";
import type { ChartSpec } from "../../shared/types";

const placements = [
  { position: "top", align: "start", label: "Сверху слева", x: 5, y: 5 },
  { position: "top", align: "center", label: "Сверху по центру", x: 12, y: 5 },
  { position: "top", align: "end", label: "Сверху справа", x: 19, y: 5 },
  { position: "left", align: "center", label: "Слева по центру", x: 5, y: 12 },
  {
    position: "right",
    align: "center",
    label: "Справа по центру",
    x: 19,
    y: 12,
  },
  { position: "bottom", align: "start", label: "Снизу слева", x: 5, y: 19 },
  {
    position: "bottom",
    align: "center",
    label: "Снизу по центру",
    x: 12,
    y: 19,
  },
  { position: "bottom", align: "end", label: "Снизу справа", x: 19, y: 19 },
] as const;

export default function LegendPositionPicker({
  position = "top",
  align = "center",
  disabled,
  onChange,
}: {
  position?: ChartSpec["legendPosition"];
  align?: ChartSpec["legendAlign"];
  disabled: boolean;
  onChange: (patch: Pick<ChartSpec, "legendPosition" | "legendAlign">) => void;
}) {
  const name = useId();
  // Older boards can anchor a vertical legend to a corner. Show that location
  // without changing its orientation until the user explicitly picks a preset.
  const sideCorner =
    (position === "left" || position === "right") && align !== "center";
  const selectedPosition = sideCorner
    ? align === "start"
      ? "top"
      : "bottom"
    : position;
  const selectedAlign = sideCorner
    ? position === "left"
      ? "start"
      : "end"
    : align;
  return (
    <div className="board-legend-picker">
      <span>Положение легенды</span>
      <div
        className="board-legend-positions"
        role="radiogroup"
        aria-label="Положение легенды"
      >
        {placements.map((placement, index) => {
          const checked =
            placement.position === selectedPosition &&
            placement.align === selectedAlign;
          const select = () =>
            onChange({
              legendPosition: placement.position,
              legendAlign: placement.align,
            });
          return (
            <label
              className="board-legend-option"
              key={placement.label}
              title={placement.label}
            >
              <input
                type="radio"
                name={name}
                value={index}
                aria-label={placement.label}
                checked={checked}
                disabled={disabled}
                onChange={select}
                onClick={() => {
                  if (checked && sideCorner) select();
                }}
              />
              <svg
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                focusable="false"
              >
                {placements.map(({ x, y }, dot) => (
                  <circle
                    key={dot}
                    cx={x}
                    cy={y}
                    r="1.8"
                    className={
                      dot === index
                        ? "board-legend-dot-active"
                        : "board-legend-dot"
                    }
                  />
                ))}
              </svg>
            </label>
          );
        })}
      </div>
    </div>
  );
}
