import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import {
  Check,
  ClockCounterClockwise,
  Code,
  Database,
  FolderSimple,
  GearSix,
  MagnifyingGlass,
  PlugsConnected,
  Presentation,
  Question,
  SquaresFour,
} from "@phosphor-icons/react";
import type { ExplorerKind } from "./Explorer";
import { Brand, IconButton } from "./UI";
import { PANES_BY_MODE, type Pane, type PaneMode } from "../workspace-panes";

export default function WorkspaceRail({
  mode,
  explorer,
  connectionCount,
  gitControl,
  onSelectMode,
  onTogglePane,
  onToggleExplorer,
  onResetLayout,
  onConnections,
  onHelp,
  onSettings,
  onSearch,
}: {
  mode: PaneMode;
  explorer: ExplorerKind | null;
  connectionCount: number;
  gitControl?: ReactNode;
  onSelectMode: (mode: PaneMode) => void;
  onTogglePane: (pane: Pane) => void;
  onToggleExplorer: (kind: ExplorerKind) => void;
  onResetLayout: () => void;
  onConnections: () => void;
  onHelp: () => void;
  onSettings: () => void;
  onSearch?: () => void;
}) {
  return (
    <nav className="activity-bar" aria-label="Рабочая область">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <IconButton className="activity-brand" label="Вид и раскладка">
            <Brand />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="dropdown-menu workspace-menu"
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={8}
          >
            <DropdownMenu.Label className="workspace-menu-heading">
              <Brand />
              <span>Рабочая область</span>
            </DropdownMenu.Label>
            <DropdownMenu.Separator />
            <DropdownMenu.RadioGroup
              value={mode}
              onValueChange={(value) => onSelectMode(value as PaneMode)}
              aria-label="Вид рабочей области"
            >
              {(
                [
                  ["split", "Редактор и доска"],
                  ["sql-presentation", "Редактор и презентация"],
                  ["board-presentation", "Доска и презентация"],
                  ["sql", "Только редактор"],
                  ["board", "Только доска"],
                  ["presentation", "Только презентация"],
                  ["none", "Скрыть все панели"],
                ] as const
              ).map(([value, label]) => (
                <DropdownMenu.RadioItem
                  key={value}
                  value={value}
                  className="workspace-menu-radio"
                >
                  {label}
                  <DropdownMenu.ItemIndicator className="workspace-menu-item-indicator">
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              onSelect={() => onToggleExplorer(explorer || "sources")}
            >
              {explorer ? "Скрыть обозреватель" : "Показать обозреватель"}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={onResetLayout}>
              Восстановить раскладку
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {onSearch && (
        <IconButton
          label="Поиск по проекту (⌘K / Ctrl+K)"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={onSearch}
        >
          <MagnifyingGlass size={21} />
        </IconButton>
      )}

      <div
        className="activity-group"
        role="group"
        aria-label="Переключение панелей"
      >
        {(
          [
            ["sql", "Редактор", Code],
            ["board", "Доска", SquaresFour],
            ["presentation", "Презентация", Presentation],
          ] as const
        ).map(([pane, label, Icon]) => (
          <IconButton
            key={pane}
            label={label}
            aria-pressed={PANES_BY_MODE[mode].includes(pane)}
            onClick={() => onTogglePane(pane)}
          >
            <Icon size={21} />
          </IconButton>
        ))}
      </div>

      <div className="activity-group" role="group" aria-label="Обозреватель">
        {(
          [
            {
              kind: "sources",
              icon: <Database size={21} />,
              label: "Источники данных",
            },
            {
              kind: "queries",
              icon: <FolderSimple size={21} />,
              label: "Проводник проекта",
            },
            {
              kind: "history",
              icon: <ClockCounterClockwise size={21} />,
              label: "История запросов",
            },
          ] as const
        ).map((item) => (
          <IconButton
            key={item.kind}
            label={item.label}
            className={explorer === item.kind ? "active" : ""}
            aria-pressed={explorer === item.kind}
            onClick={() => onToggleExplorer(item.kind)}
          >
            {item.icon}
          </IconButton>
        ))}
        {gitControl}
      </div>

      <div className="activity-spacer" />

      <div
        className="activity-group"
        role="group"
        aria-label="Управление рабочей областью"
      >
        <IconButton
          label="Подключения"
          title={`Подключения · ${connectionCount}`}
          onClick={onConnections}
        >
          <PlugsConnected size={20} />
        </IconButton>
        <IconButton label="Настройки" onClick={onSettings}>
          <GearSix size={20} />
        </IconButton>
        <IconButton label="Сочетания клавиш" onClick={onHelp}>
          <Question size={20} />
        </IconButton>
      </div>
    </nav>
  );
}
