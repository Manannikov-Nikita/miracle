import {
  AlignLeft,
  AlignCenterVertical,
  AlignRight,
  AlignTop,
  AlignCenterHorizontal,
  AlignBottom,
  Columns,
  Rows,
} from "@phosphor-icons/react";
import type { AlignmentAction } from "./alignment";

const commands = [
  { action: "left", label: "Выровнять по левому краю", Icon: AlignLeft },
  {
    action: "center-x",
    label: "Выровнять по центру по горизонтали",
    Icon: AlignCenterVertical,
  },
  { action: "right", label: "Выровнять по правому краю", Icon: AlignRight },
  { action: "top", label: "Выровнять по верхнему краю", Icon: AlignTop },
  {
    action: "center-y",
    label: "Выровнять по центру по вертикали",
    Icon: AlignCenterHorizontal,
  },
  { action: "bottom", label: "Выровнять по нижнему краю", Icon: AlignBottom },
  {
    action: "distribute-x",
    label: "Распределить с равными интервалами по горизонтали",
    Icon: Columns,
  },
  {
    action: "distribute-y",
    label: "Распределить с равными интервалами по вертикали",
    Icon: Rows,
  },
] satisfies {
  action: AlignmentAction;
  label: string;
  Icon: typeof AlignLeft;
}[];

export function AlignmentToolbar({
  count,
  onAlign,
}: {
  count: number;
  onAlign: (action: AlignmentAction) => void;
}) {
  return (
    <div
      className="board-alignment-toolbar nodrag nopan"
      role="toolbar"
      aria-label="Выровнять выбранные блоки"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        const current = buttons.indexOf(event.target as HTMLButtonElement);
        if (current < 0) return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current +
                  (event.key === "ArrowLeft" ? -1 : 1) +
                  buttons.length) %
                buttons.length;
        buttons[next]?.focus();
      }}
    >
      <span className="board-selection-count" aria-live="polite">
        Выбрано: {count}
      </span>
      {commands.map(({ action, label, Icon }, index) => (
        <button
          key={action}
          type="button"
          aria-label={label}
          title={label}
          className={
            index === 3 || index === 6 ? "board-alignment-separated" : undefined
          }
          disabled={index >= 6 && count < 3}
          onClick={() => onAlign(action)}
        >
          <Icon size={18} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
