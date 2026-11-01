import type { ReactNode } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  ArrowsLeftRight,
  Check,
  LineSegment,
  Palette,
  TextT,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { BoardEdgeAppearance } from "../../shared/types";
import { edgeAppearance, edgeColors } from "./edge-appearance";
import "./board-edge-palette.css";

function ChoiceMenu({
  label,
  icon,
  value,
  choices,
  choose,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  choices: { value: string; label: string; icon?: ReactNode }[];
  choose: (value: string) => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" aria-label={label} title={label}>
          {icon}
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="board-edge-menu menu-surface nodrag nopan nowheel nokey"
          sideOffset={8}
          collisionPadding={12}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Menu.Label className="board-edge-menu-title">{label}</Menu.Label>
          <Menu.RadioGroup value={value} onValueChange={choose}>
            {choices.map((choice) => (
              <Menu.RadioItem
                className="board-edge-menu-item"
                value={choice.value}
                key={choice.value}
              >
                <span className="board-edge-choice-icon" aria-hidden="true">
                  {choice.icon}
                </span>
                <span>{choice.label}</span>
                <Menu.ItemIndicator className="board-edge-menu-check">
                  <Check size={14} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ColorMenu({
  color,
  choose,
}: {
  color?: string;
  choose: (color: string | undefined) => void;
}) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild>
        <button type="button" aria-label="Цвет линии" title="Цвет линии">
          <Palette size={18} color={color ?? "var(--board-muted)"} />
        </button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="board-edge-menu board-edge-palette menu-surface nodrag nopan nowheel nokey"
          aria-label="Цвет линии"
          sideOffset={8}
          collisionPadding={12}
          loop
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Menu.RadioGroup
            className="board-edge-palette-group"
            value={color ?? "default"}
            onValueChange={(value) =>
              choose(value === "default" ? undefined : value)
            }
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return;
              event.preventDefault();
              event.stopPropagation();
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  '[role="menuitemradio"]',
                ),
              ];
              const index = items.indexOf(
                document.activeElement as HTMLElement,
              );
              const step = event.key === "ArrowRight" ? 1 : -1;
              items[(index + step + items.length) % items.length]?.focus();
            }}
          >
            {edgeColors.map(({ label, value, color: background }) => (
              <Menu.RadioItem
                className="board-edge-swatch"
                key={value ?? "default"}
                value={value ?? "default"}
                aria-label={label}
                title={label}
                textValue={label}
              >
                <span
                  className="board-edge-color"
                  style={{ background }}
                  aria-hidden="true"
                />
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function LineIcon({
  path = "straight",
  dash,
  width = 1.5,
  start = false,
  end = false,
}: {
  path?: string;
  dash?: string;
  width?: number;
  start?: boolean;
  end?: boolean;
}) {
  const d =
    path === "smoothstep"
      ? "M2 15H10V5H22"
      : path === "bezier"
        ? "M2 15C12 15 12 5 22 5"
        : "M2 10H22";
  return (
    <svg
      width="24"
      height="20"
      viewBox="0 0 24 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={d}
        stroke="currentColor"
        strokeWidth={width}
        strokeDasharray={dash}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {start && (
        <path d="m6 6-4 4 4 4" stroke="currentColor" strokeWidth="1.5" />
      )}
      {end && (
        <path d="m18 6 4 4-4 4" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  );
}

export default function BoardEdgeToolbar({
  appearance,
  onChange,
  onEdit,
  onDelete,
  onClose,
}: {
  appearance?: BoardEdgeAppearance;
  onChange: (patch: BoardEdgeAppearance) => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const current = edgeAppearance(appearance);
  const update = (patch: BoardEdgeAppearance) => {
    if (
      Object.entries(patch).some(
        ([key, value]) =>
          appearance?.[key as keyof BoardEdgeAppearance] !== value,
      )
    )
      onChange(patch);
  };
  const arrows = current.startArrow
    ? current.endArrow
      ? "both"
      : "start"
    : current.endArrow
      ? "end"
      : "none";
  return (
    <div
      className="board-edge-toolbar nodrag nopan nowheel nokey"
      role="toolbar"
      aria-label="Оформление стрелки"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <button
        type="button"
        aria-label="Изменить подпись стрелки"
        title="Подпись · двойной клик по стрелке"
        onClick={onEdit}
      >
        <TextT size={18} />
      </button>
      <span className="board-edge-toolbar-separator" />
      <ChoiceMenu
        label="Форма линии"
        icon={<LineIcon path={current.path} />}
        value={current.path}
        choices={[
          {
            value: "smoothstep",
            label: "Угловая",
            icon: <LineIcon path="smoothstep" />,
          },
          { value: "straight", label: "Прямая", icon: <LineIcon /> },
          {
            value: "bezier",
            label: "Плавная",
            icon: <LineIcon path="bezier" />,
          },
        ]}
        choose={(path) => {
          if (path !== current.path)
            update({ path: path as BoardEdgeAppearance["path"] });
        }}
      />
      <ColorMenu
        color={appearance?.color}
        choose={(color) => update({ color })}
      />
      <ChoiceMenu
        label="Толщина линии"
        icon={
          <LineSegment
            size={18}
            weight={current.width >= 3 ? "bold" : "regular"}
          />
        }
        value={String(appearance?.width ?? "default")}
        choices={[
          { value: "default", label: "Обычная", icon: <LineIcon /> },
          ...([1, 2, 3] as const).map((width) => ({
            value: String(width),
            label: `${width} px`,
            icon: <LineIcon width={width} />,
          })),
        ]}
        choose={(width) =>
          update({
            width:
              width === "default" ? undefined : (Number(width) as 1 | 2 | 3),
          })
        }
      />
      <ChoiceMenu
        label="Тип линии"
        icon={<LineIcon dash={current.dash} />}
        value={current.line}
        choices={[
          { value: "solid", label: "Сплошная", icon: <LineIcon /> },
          {
            value: "dashed",
            label: "Пунктирная",
            icon: <LineIcon dash="5 4" />,
          },
          { value: "dotted", label: "Точечная", icon: <LineIcon dash="1 4" /> },
        ]}
        choose={(line) => {
          if (line !== current.line)
            update({ line: line as BoardEdgeAppearance["line"] });
        }}
      />
      <ChoiceMenu
        label="Наконечники"
        icon={<ArrowsLeftRight size={18} />}
        value={arrows}
        choices={[
          { value: "none", label: "Без наконечников", icon: <LineIcon /> },
          { value: "end", label: "В конце", icon: <LineIcon end /> },
          { value: "start", label: "В начале", icon: <LineIcon start /> },
          {
            value: "both",
            label: "С двух сторон",
            icon: <LineIcon start end />,
          },
        ]}
        choose={(value) => {
          if (value !== arrows)
            update({
              startArrow: value === "start" || value === "both",
              endArrow: value === "end" || value === "both",
            });
        }}
      />
      <span className="board-edge-toolbar-separator" />
      <button
        type="button"
        className="board-edge-delete"
        aria-label="Удалить стрелку"
        title="Удалить стрелку"
        onClick={onDelete}
      >
        <Trash size={16} />
      </button>
      <button
        type="button"
        aria-label="Закрыть свойства стрелки"
        title="Закрыть"
        onClick={onClose}
      >
        <X size={16} />
      </button>
    </div>
  );
}
