import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ClockCounterClockwise,
  Code,
  Database,
  FileCode,
  GearSix,
  Question,
  SignOut,
  SquaresFour,
  Users,
} from "@phosphor-icons/react";
import type { User } from "../../shared/types";
import type { ExplorerKind } from "./Explorer";
import { Brand, IconButton } from "./UI";

export type PaneMode = "split" | "sql" | "board";

const roleNames = {
  admin: "Администратор",
  editor: "Редактор",
  viewer: "Наблюдатель",
};

export default function WorkspaceRail({
  user,
  narrow,
  mode,
  explorer,
  connectionCount,
  onSelectMode,
  onTogglePane,
  onToggleExplorer,
  onResetLayout,
  onConnections,
  onTeam,
  onHelp,
  onLogout,
}: {
  user: User;
  narrow: boolean;
  mode: PaneMode;
  explorer: ExplorerKind | null;
  connectionCount: number;
  onSelectMode: (mode: PaneMode) => void;
  onTogglePane: (pane: "sql" | "board") => void;
  onToggleExplorer: (kind: ExplorerKind) => void;
  onResetLayout: () => void;
  onConnections: () => void;
  onTeam: () => void;
  onHelp: () => void;
  onLogout: () => void;
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
                  ["sql", "Только редактор"],
                  ["board", "Только доска"],
                ] as const
              )
                .filter(([value]) => !narrow || value !== "split")
                .map(([value, label]) => (
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

      <div
        className="activity-group"
        role="group"
        aria-label="Переключение панелей"
      >
        <IconButton
          label="Редактор SQL"
          className={mode !== "board" ? "active" : ""}
          aria-pressed={mode !== "board"}
          onClick={() => onTogglePane("sql")}
        >
          <Code size={21} />
        </IconButton>
        <IconButton
          label="Доска"
          className={mode !== "sql" ? "active" : ""}
          aria-pressed={mode !== "sql"}
          onClick={() => onTogglePane("board")}
        >
          <SquaresFour size={21} />
        </IconButton>
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
              icon: <FileCode size={21} />,
              label: "SQL-файлы",
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
          <GearSix size={20} />
        </IconButton>
        {user.role === "admin" && (
          <IconButton label="Управление командой" onClick={onTeam}>
            <Users size={20} />
          </IconButton>
        )}
        <IconButton label="Сочетания клавиш" onClick={onHelp}>
          <Question size={20} />
        </IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton className="activity-profile" label="Меню пользователя">
              <span className="avatar small">
                {(user.name || user.email).slice(0, 2).toUpperCase()}
              </span>
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="dropdown-menu profile-menu"
              side="right"
              align="end"
              sideOffset={8}
              collisionPadding={8}
            >
              <div className="profile-info">
                <strong>{user.name || user.email}</strong>
                <span>{user.email}</span>
                <small>{roleNames[user.role]}</small>
              </div>
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={onHelp}>
                Сочетания клавиш
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={onLogout}>
                <SignOut size={15} />
                Выйти
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </nav>
  );
}
