import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { PointerEvent } from "react";
import { Shapes } from "@phosphor-icons/react";
import { SHAPE_OPTIONS, type ShapeKind } from "../../shared/shapes";
import { ShapeGlyph } from "./ShapeContent";
import "./shape-picker.css";

export default function ShapePicker({
  disabled,
  onSelect,
  open,
  onOpenChange,
  dragging,
  onPointerDown,
  suppressClick,
}: {
  disabled: boolean;
  onSelect: (type: ShapeKind) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  dragging?: boolean;
  onPointerDown?: (event: PointerEvent, type: ShapeKind) => void;
  suppressClick?: (event: {
    preventDefault(): void;
    stopPropagation(): void;
    detail?: number;
  }) => boolean;
}) {
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger
        className="board-tools-icon"
        disabled={disabled}
        title="Добавить фигуру"
        aria-label="Добавить фигуру"
        onPointerDown={(event) => onPointerDown?.(event, "rectangle")}
        onClick={(event) => suppressClick?.(event)}
      >
        <Shapes size={18} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="shape-picker-menu menu-surface nodrag nopan nowheel nokey"
          align="start"
          side="top"
          sideOffset={12}
          collisionPadding={8}
          onKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            if (dragging) event.preventDefault();
          }}
          onDragStart={(event) => event.preventDefault()}
        >
          <div className="shape-picker-options">
            {SHAPE_OPTIONS.map(({ type, label }) => (
              <DropdownMenu.Item
                key={type}
                className="shape-picker-option"
                aria-label={label}
                title={label}
                textValue={label}
                onPointerDown={(event) => onPointerDown?.(event, type)}
                onClick={(event) => suppressClick?.(event)}
                onSelect={() => onSelect(type)}
              >
                <ShapeGlyph type={type} size={28} />
              </DropdownMenu.Item>
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
