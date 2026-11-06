import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Shapes } from "@phosphor-icons/react";
import { SHAPE_OPTIONS, type ShapeKind } from "../../shared/shapes";
import { ShapeGlyph } from "./ShapeContent";
import "./shape-picker.css";

export default function ShapePicker({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (type: ShapeKind) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="board-tools-icon"
        disabled={disabled}
        title="Добавить фигуру"
        aria-label="Добавить фигуру"
      >
        <Shapes size={18} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="shape-picker-menu menu-surface nodrag nopan nowheel nokey"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="shape-picker-options">
            {SHAPE_OPTIONS.map(({ type, label }) => (
              <DropdownMenu.Item
                key={type}
                className="shape-picker-option"
                aria-label={label}
                title={label}
                textValue={label}
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
