import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChatCircle, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { AgentChat } from "../../shared/agents";

export default function AgentHistory({
  open,
  onOpenChange,
  chats,
  selected,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chats: AgentChat[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = chats.filter((chat) =>
    chat.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal container={document.getElementById("agent-panel")}>
        <Dialog.Overlay className="agent-dialog-overlay" />
        <Dialog.Content
          className="agent-dialog agent-history-dialog"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("agent-message")?.focus();
          }}
        >
          <div className="agent-dialog-heading">
            <Dialog.Title>История чатов</Dialog.Title>
            <Dialog.Close
              className="agent-icon-button"
              aria-label="Закрыть историю"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          <div className="agent-history-search">
            <MagnifyingGlass size={17} />
            <input
              aria-label="Найти чат"
              placeholder="Найти чат…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="agent-history-list">
            {filtered.map((chat) => (
              <button
                key={chat.id}
                className="agent-history-item"
                aria-current={selected === chat.id ? "true" : undefined}
                onClick={() => {
                  onSelect(chat.id);
                  onOpenChange(false);
                }}
              >
                <ChatCircle size={18} />
                <span>
                  <strong>{chat.title}</strong>
                  <small>
                    {chat.provider === "codex" ? "Codex" : "Claude"}
                  </small>
                </span>
              </button>
            ))}
            {!filtered.length && (
              <p className="agent-hint">
                {chats.length
                  ? "Чатов с таким названием нет."
                  : "Здесь появятся ваши разговоры."}
              </p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
