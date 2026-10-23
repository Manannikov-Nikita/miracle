import { useState } from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CaretDown, CaretUp, Check } from "@phosphor-icons/react";

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = "Выберите значение",
  disabled = false,
  required,
  name,
  id,
  "aria-label": ariaLabel,
  className = "",
}: SelectProps) {
  const [localValue, setLocalValue] = useState(
    defaultValue ?? options.find((option) => !option.disabled)?.value ?? "",
  );
  const selectedValue =
    value ??
    (options.some((option) => option.value === localValue)
      ? localValue
      : (options.find((option) => !option.disabled)?.value ?? ""));
  const hasSelection = options.some((option) => option.value === selectedValue);
  // Radix reserves the empty string for its placeholder. Prefixing every item
  // also supports an explicit "none" option without colliding with real IDs.
  const encode = (optionValue: string) => `option:${optionValue}`;

  return (
    <>
      <SelectPrimitive.Root
        value={hasSelection ? encode(selectedValue) : ""}
        onValueChange={(next) => {
          const decoded = next.slice("option:".length);
          setLocalValue(decoded);
          onValueChange?.(decoded);
        }}
        disabled={disabled}
        required={required}
      >
        <SelectPrimitive.Trigger
          id={id}
          aria-label={ariaLabel}
          className={`select-trigger ${className}`}
        >
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon className="select-chevron">
            <CaretDown size={13} />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content
            className="select-content menu-surface nodrag nopan nowheel nokey"
            position="popper"
            sideOffset={6}
            collisionPadding={8}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
          >
            <SelectPrimitive.ScrollUpButton className="select-scroll-button">
              <CaretUp size={13} />
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport className="select-viewport">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={encode(option.value)}
                  disabled={option.disabled}
                  textValue={option.label}
                  className="select-item menu-item"
                >
                  <SelectPrimitive.ItemIndicator className="select-indicator">
                    <Check size={13} weight="bold" />
                  </SelectPrimitive.ItemIndicator>
                  <SelectPrimitive.ItemText>
                    {option.label}
                  </SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="select-scroll-button">
              <CaretDown size={13} />
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
      {name && (
        <input
          type="hidden"
          name={name}
          value={selectedValue}
          disabled={disabled}
        />
      )}
    </>
  );
}
