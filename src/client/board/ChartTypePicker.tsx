import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { ChartSpec } from "../../shared/types";

const types = [
  { kind: "bar", label: "Столбцы" },
  { kind: "line", label: "Линии" },
  { kind: "area", label: "Область" },
  { kind: "scatter", label: "Точки" },
] as const;

function Preview({
  kind,
  horizontal = false,
}: {
  kind: ChartSpec["kind"];
  horizontal?: boolean;
}) {
  return (
    <svg viewBox="0 0 48 36" fill="none" aria-hidden="true" focusable="false">
      <path d="M5 4V31H44" stroke="currentColor" opacity="0.35" />
      {kind === "bar" &&
        (horizontal ? (
          <g fill="currentColor">
            <rect x="6" y="6" width="24" height="5" rx="1" />
            <rect x="6" y="15" width="34" height="5" rx="1" />
            <rect x="6" y="24" width="18" height="5" rx="1" />
          </g>
        ) : (
          <g fill="currentColor">
            <rect x="11" y="19" width="6" height="11" rx="1" />
            <rect x="23" y="8" width="6" height="22" rx="1" />
            <rect x="35" y="14" width="6" height="16" rx="1" />
          </g>
        ))}
      {(kind === "line" || kind === "area") && (
        <>
          {kind === "area" && (
            <path
              d="M10 25L20 14L30 19L41 6V30H10Z"
              fill="currentColor"
              opacity="0.3"
            />
          )}
          <path
            d="M10 25L20 14L30 19L41 6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {kind === "scatter" && (
        <g fill="currentColor">
          <circle cx="12" cy="24" r="2" />
          <circle cx="18" cy="14" r="2" />
          <circle cx="23" cy="22" r="2" />
          <circle cx="29" cy="10" r="2" />
          <circle cx="34" cy="17" r="2" />
          <circle cx="40" cy="7" r="2" />
        </g>
      )}
    </svg>
  );
}

export default function ChartTypePicker({
  value,
  orientation,
  onChange,
  disabled,
}: {
  value: ChartSpec["kind"];
  orientation?: ChartSpec["orientation"];
  onChange: (kind: ChartSpec["kind"]) => void;
  disabled: boolean;
}) {
  const selected = types.find(({ kind }) => kind === value)!;
  const horizontal = orientation === "horizontal";
  const selectedLabel =
    value === "bar" && horizontal ? "Горизонтальные столбцы" : selected.label;
  return (
    <div className="board-chart-types">
      <span>Тип графика</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="select-trigger board-chart-type-trigger"
          disabled={disabled}
          aria-label={`Тип графика: ${selectedLabel}`}
          title={selectedLabel}
        >
          <span className="board-chart-type-preview">
            <Preview kind={value} horizontal={horizontal} />
          </span>
          <CaretDown size={13} aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="board-chart-type-menu menu-surface nodrag nopan nowheel nokey"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
          >
            <DropdownMenu.Label className="board-chart-type-heading">
              Тип графика
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              className="board-chart-type-options"
              aria-label="Тип графика"
              value={value}
              onValueChange={(kind) => onChange(kind as ChartSpec["kind"])}
            >
              {types.map(({ kind, label }) => (
                <DropdownMenu.RadioItem
                  className="board-chart-type-option"
                  key={kind}
                  value={kind}
                  disabled={disabled}
                  textValue={label}
                  aria-label={label}
                  title={label}
                >
                  <span className="board-chart-type-preview">
                    <Preview kind={kind} horizontal={horizontal} />
                  </span>
                  <DropdownMenu.ItemIndicator className="board-chart-type-check">
                    <Check size={10} weight="bold" aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
