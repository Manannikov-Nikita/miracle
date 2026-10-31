import { useEffect, useRef } from "react";
import { Plus, Stop, ArrowUp } from "@phosphor-icons/react";
import type { AgentChatState } from "./useAgentChat";
import AgentMessages from "./AgentMessages";
interface Props {
  state: AgentChatState;
  selectedProfile: string;
  onProfileChange: (id: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => Promise<void>;
  onSettings: () => void;
}
export default function AgentChatView({
  state,
  selectedProfile,
  onProfileChange,
  draft,
  onDraftChange,
  onSend,
  onSettings,
}: Props) {
  const active = state.active,
    log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = log.current;
    if (
      element &&
      element.scrollHeight - element.scrollTop - element.clientHeight < 180
    )
      element.scrollTop = element.scrollHeight;
  }, [state.conversation]);
  return (
    <>
      <div className="agent-history">
        <label className="sr-only" htmlFor="agent-conversation">
          Разговор
        </label>
        <select
          id="agent-conversation"
          disabled={state.busy}
          value={state.selected}
          onChange={(e) => state.setSelected(e.target.value)}
        >
          <option value="">Новый разговор</option>
          {state.chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.title} · {chat.provider}
            </option>
          ))}
        </select>
        <button
          className="icon-button"
          aria-label="Новый разговор"
          title="Новый разговор"
          disabled={state.busy}
          onClick={() => state.setSelected("")}
        >
          <Plus size={17} />
        </button>
      </div>
      {!state.selected && (
        <div className="agent-new-profile">
          <label htmlFor="agent-profile">Профиль нового разговора</label>
          <select
            id="agent-profile"
            value={selectedProfile}
            onChange={(e) => onProfileChange(e.target.value)}
          >
            <option value="" disabled>
              Выберите профиль
            </option>
            {state.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.provider}
                {p.trusted ? "" : " · требуется доверие"}
              </option>
            ))}
          </select>
        </div>
      )}
      <div
        ref={log}
        className="agent-log"
        role="log"
        aria-label="Сообщения агента"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {!state.conversation?.messages.length && (
          <div className="agent-empty">
            {state.profiles.length ? (
              "Попросите агента исследовать данные, подготовить SQL или изменить доску."
            ) : (
              <>
                <p>Добавьте команду установленного Codex CLI или Claude CLI.</p>
                <button className="button" onClick={() => onSettings()}>
                  Настроить профиль
                </button>
              </>
            )}
          </div>
        )}
        <AgentMessages state={state} />
      </div>
      {active && (
        <div className="agent-running" role="status">
          <span>
            {active.status === "waiting"
              ? "Агент ждёт вашего решения"
              : active.chatId === state.selected
                ? "Агент работает…"
                : "Агент работает в другом разговоре"}
          </span>
          <button
            className="text-button"
            disabled={state.busy}
            onClick={() => void state.stop().catch(() => {})}
          >
            <Stop size={13} /> Остановить
          </button>
        </div>
      )}
      <form
        className="agent-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void onSend();
        }}
      >
        <label className="sr-only" htmlFor="agent-message">
          Сообщение агенту
        </label>
        <textarea
          id="agent-message"
          rows={3}
          value={draft}
          placeholder="Сообщение агенту…"
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onSend();
            }
          }}
        />
        <div>
          <small>
            SQL и доска сохраняются перед отправкой · ⌘ / Ctrl + Enter
          </small>
          <button
            className="button primary"
            type="submit"
            aria-label="Отправить сообщение"
            disabled={
              state.busy ||
              Boolean(active) ||
              !draft.trim() ||
              (!state.selected &&
                !state.profiles.find((p) => p.id === selectedProfile)?.trusted)
            }
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
    </>
  );
}
