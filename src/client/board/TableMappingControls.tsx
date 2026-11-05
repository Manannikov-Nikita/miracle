import { useEffect, useId, useState, type CSSProperties } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, X } from "@phosphor-icons/react";
import type { TableColor } from "../../shared/tableTypes";

const colors = [
  { value: undefined, label: "Без цвета", color: "transparent" },
  { value: "green", label: "Зелёный", color: "#91cbb3" },
  { value: "yellow", label: "Жёлтый", color: "#e7bd7e" },
  { value: "red", label: "Красный", color: "#ef9c9c" },
  { value: "blue", label: "Синий", color: "#91b5ff" },
  { value: "purple", label: "Фиолетовый", color: "#c5a4eb" },
] as const;

export function TableMappingColor({
  value,
  disabled,
  onChange,
}: {
  value?: TableColor;
  disabled: boolean;
  onChange: (value: TableColor | undefined) => void;
}) {
  const selected = colors.find((option) => option.value === value) ?? colors[0];
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className="table-mapping-color"
        disabled={disabled}
        aria-label={`Цвет подстановки: ${selected.label}`}
        title={`Цвет: ${selected.label}`}
      >
        <span
          className="table-mapping-swatch"
          data-empty={value === undefined || undefined}
          style={{ "--mapping-color": selected.color } as CSSProperties}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="table-mapping-color-menu menu-surface nodrag nopan nowheel nokey"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          onKeyDown={(event) => event.stopPropagation()}
          onKeyUp={(event) => event.stopPropagation()}
        >
          <DropdownMenu.RadioGroup
            aria-label="Цвет подстановки"
            value={value ?? "none"}
            onValueChange={(color) =>
              onChange(color === "none" ? undefined : (color as TableColor))
            }
          >
            {colors.map((option) => (
              <DropdownMenu.RadioItem
                key={option.label}
                value={option.value ?? "none"}
                className="table-mapping-color-option menu-item"
              >
                <span
                  className="table-mapping-swatch"
                  data-empty={option.value === undefined || undefined}
                  style={{ "--mapping-color": option.color } as CSSProperties}
                  aria-hidden="true"
                />
                {option.label}
                <DropdownMenu.ItemIndicator className="table-mapping-color-check">
                  <Check size={13} aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function TableMappingSource({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (!disabled && draft !== value) onChange(draft);
  };
  return (
    <div className="table-mapping-source">
      <label htmlFor={id}>Исходное значение</label>
      <div className="table-mapping-source-control">
        <input
          id={id}
          aria-label="Исходное значение"
          value={draft ?? ""}
          placeholder={draft === null ? "NULL" : "Пустая строка"}
          maxLength={2000}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") setDraft(value);
          }}
        />
        {draft !== null && (
          <button
            className="table-mapping-null"
            type="button"
            aria-label="Использовать NULL"
            title="Использовать NULL"
            disabled={disabled}
            onClick={() => {
              setDraft(null);
              onChange(null);
            }}
          >
            <X size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
