import { useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Plus,
  ArrowUp,
  Stop,
  CaretDown,
  ClockCounterClockwise,
  Gear,
  ChatCircle,
  Check,
} from "@phosphor-icons/react";
import type { AgentChatState } from "./useAgentChat";
import AgentHistory from "./AgentHistory";
import AgentFileMentions, { AgentContextChips } from "./AgentFileMentions";

export interface ComposerProps {
  state: AgentChatState;
  selectedProfile: string;
  onProfileChange: (id: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => Promise<void>;
  onSettings: () => void;
  filePaths?: string[];
  onFilesChange?: (paths: string[]) => void;
  boardNodes?: { id: string; title: string }[];
  onDismissBoardNode?: (id: string) => void;
}
export default function AgentComposer({
  state,
  selectedProfile,
  onProfileChange,
  draft,
  onDraftChange,
  onSend,
  onSettings,
  filePaths = [],
  onFilesChange,
  boardNodes = [],
  onDismissBoardNode,
}: ComposerProps) {
  const [history, setHistory] = useState(false);
  const profileId = state.conversation?.chat.profileId || selectedProfile;
  const profile = state.profiles.find((p) => p.id === profileId);
  const canSend =
    !state.busy &&
    !state.active &&
    Boolean(draft.trim()) &&
    Boolean(profile?.trusted);
  const submit = () => {
    if (canSend) void onSend();
  };
  const selectProfile = (id: string) => {
    if (id !== profileId && state.selected) state.setSelected("");
    onProfileChange(id);
  };
  return (
    <div className="agent-composer-zone">
      <form
        className="agent-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {state.active && (
          <div className="agent-composer-status" role="status">
            <span className={`agent-status-dot ${state.active.status}`} />
            {state.active.chatId !== state.selected
              ? "Задача выполняется в другом чате"
              : state.active.status === "waiting"
                ? "Нужно ваше разрешение"
                : "Агент работает"}
            {state.active.chatId !== state.selected && (
              <button
                type="button"
                onClick={() => state.setSelected(state.active!.chatId)}
              >
                Открыть
              </button>
            )}
          </div>
        )}
        <AgentContextChips
          filePaths={filePaths}
          onFilesChange={onFilesChange}
          boardNodes={boardNodes}
          onDismissBoardNode={onDismissBoardNode}
        />
        <AgentFileMentions
          draft={draft}
          draftKey={state.selected || "new"}
          onDraftChange={onDraftChange}
          filePaths={filePaths}
          onFilesChange={onFilesChange}
          onSubmit={submit}
        />
        <div className="agent-composer-toolbar">
          <Menu.Root>
            <Menu.Trigger asChild>
              <button
                type="button"
                className="agent-icon-button"
                aria-label="Действия чата"
                title="Действия чата"
              >
                <Plus size={21} />
              </button>
            </Menu.Trigger>
            <Menu.Portal container={document.getElementById("agent-panel")}>
              <Menu.Content
                className="agent-menu"
                side="top"
                align="start"
                sideOffset={12}
              >
                <Menu.Item
                  disabled={state.busy}
                  onSelect={() => state.setSelected("")}
                >
                  <ChatCircle size={17} />
                  Новый разговор
                </Menu.Item>
                <Menu.Item
                  disabled={state.busy}
                  onSelect={() => setHistory(true)}
                >
                  <ClockCounterClockwise size={17} />
                  История чатов
                </Menu.Item>
                <Menu.Separator />
                <Menu.Item onSelect={onSettings}>
                  <Gear size={17} />
                  Настройки агента
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
          <Menu.Root>
            <Menu.Trigger asChild>
              <button
                type="button"
                className="agent-profile-button"
                aria-label="Выбрать профиль агента"
                title={profile?.name || "Выбрать профиль"}
                disabled={state.busy}
              >
                <span>{profile?.name || "Выбрать агента"}</span>
                <CaretDown size={12} />
              </button>
            </Menu.Trigger>
            <Menu.Portal container={document.getElementById("agent-panel")}>
              <Menu.Content
                className="agent-menu agent-profile-menu"
                side="top"
                align="start"
                sideOffset={12}
              >
                <Menu.Label className="agent-menu-label">
                  Локальные агенты
                </Menu.Label>
                <Menu.RadioGroup
                  value={profileId}
                  onValueChange={selectProfile}
                >
                  {state.profiles.map((p) => (
                    <Menu.RadioItem key={p.id} value={p.id}>
                      <span className="agent-profile-option">
                        <strong>{p.name}</strong>
                        <small>
                          {p.provider === "codex" ? "Codex CLI" : "Claude CLI"}
                          {!p.trusted ? " · требуется настройка" : ""}
                        </small>
                      </span>
                      <Menu.ItemIndicator>
                        <Check size={16} />
                      </Menu.ItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
                {state.selected && (
                  <p className="agent-menu-hint">
                    Другой профиль откроет новый чат.
                  </p>
                )}
                <Menu.Separator />
                <Menu.Item onSelect={onSettings}>
                  <Gear size={17} />
                  Настроить агента
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
          <div className="agent-composer-spacer" />
          {state.active ? (
            <button
              type="button"
              className="agent-send"
              aria-label="Остановить"
              title="Остановить задачу"
              disabled={state.busy}
              onClick={() => void state.stop().catch(() => {})}
            >
              <Stop size={17} weight="fill" />
            </button>
          ) : (
            <button
              type="submit"
              className="agent-send"
              aria-label="Отправить сообщение"
              title="Отправить · ⌘ / Ctrl + Enter"
              disabled={!canSend}
            >
              <ArrowUp size={21} weight="bold" />
            </button>
          )}
        </div>
      </form>
      {profile && !profile.trusted && (
        <p className="agent-composer-caption">
          Настройте команду агента перед запуском
        </p>
      )}
      <AgentHistory
        open={history}
        onOpenChange={setHistory}
        chats={state.chats}
        selected={state.selected}
        onSelect={state.setSelected}
      />
    </div>
  );
}
