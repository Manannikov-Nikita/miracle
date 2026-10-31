import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ShieldCheck } from "@phosphor-icons/react";
import type { AgentMessage } from "../../shared/agents";
import type { AgentChatState } from "./useAgentChat";
import AgentActivity from "./AgentActivity";
import { transcriptTurns } from "./agent-transcript";
import { AgentContextChips } from "./AgentFileMentions";

function MessageReferences({ context }: { context: unknown }) {
  if (!context || typeof context !== "object") return null;
  const value = context as Record<string, unknown>;
  const filePaths = Array.isArray(value.filePaths)
    ? value.filePaths.filter((path): path is string => typeof path === "string")
    : [];
  const boardNodes = Array.isArray(value.boardNodes)
    ? value.boardNodes.filter((node): node is { id: string; title: string } =>
        Boolean(
          node &&
          typeof node === "object" &&
          typeof node.id === "string" &&
          typeof node.title === "string",
        ),
      )
    : [];
  return <AgentContextChips filePaths={filePaths} boardNodes={boardNodes} />;
}

function MessageContent({ content }: { content: string }) {
  return (
    <div className="agent-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ alt }) => <span>{alt || "Изображение"}</span>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

function Approval({
  message,
  state,
}: {
  message: AgentMessage;
  state: AgentChatState;
}) {
  const approvalId = message.details?.approvalId;
  const decision =
    state.resolvedApprovals.get(String(approvalId)) ||
    message.details?.decision;
  const pending =
    typeof approvalId === "string" &&
    state.active?.id === message.turnId &&
    state.active?.status === "waiting" &&
    !decision &&
    !message.details?.resolved;
  const label =
    decision === "allow"
      ? "Разрешено"
      : decision === "deny"
        ? "Отклонено"
        : pending
          ? "Нужно разрешение"
          : "Запрос закрыт";
  const content = (
    <>
      <MessageContent content={message.content} />
      {message.details && (
        <details className="agent-approval-details">
          <summary>Запрашиваемое действие</summary>
          <pre>{JSON.stringify(message.details, null, 2)}</pre>
        </details>
      )}
    </>
  );
  return (
    <article
      className={`agent-message approval ${pending ? "pending" : "resolved"}`}
    >
      {pending ? (
        <>
          <div className="agent-approval-heading">
            <ShieldCheck size={18} />
            <strong>{label}</strong>
          </div>
          {content}
          <div className="agent-actions">
            <button
              className="button primary"
              disabled={state.busy}
              onClick={() =>
                void state.approve(approvalId, "allow").catch(() => {})
              }
            >
              Разрешить
            </button>
            <button
              className="button"
              disabled={state.busy}
              onClick={() =>
                void state.approve(approvalId, "deny").catch(() => {})
              }
            >
              Отклонить
            </button>
          </div>
        </>
      ) : (
        <details className="agent-approval-resolved">
          <summary>
            <ShieldCheck size={14} />
            {label}
          </summary>
          {content}
        </details>
      )}
    </article>
  );
}

export default function AgentMessages({ state }: { state: AgentChatState }) {
  const conversation = state.conversation;
  const active =
    state.active?.chatId === conversation?.chat.id ? state.active : null;
  const groups = transcriptTurns(
    conversation?.messages || [],
    conversation?.turns || [],
    active,
  );
  return (
    <>
      {groups.map((group) => {
        const userMessages = group.messages.filter(
          (message) => message.role === "user",
        );
        const replyMessages = group.messages.filter(
          (message) => message.role !== "user" && message.role !== "action",
        );
        const hasActivity =
          Boolean(group.turn) ||
          group.messages.some((message) => message.role === "action");
        return (
          <section
            className="agent-turn"
            key={group.id}
            data-turn-id={group.id}
          >
            {userMessages.map((message) => (
              <article key={message.id} className="agent-message user">
                <small className="sr-only">Вы</small>
                <MessageReferences
                  context={message.details?.context || group.turn?.context}
                />
                <MessageContent content={message.content} />
              </article>
            ))}
            {hasActivity && (
              <AgentActivity messages={group.messages} turn={group.turn} />
            )}
            {replyMessages.map((message) =>
              message.role === "approval" ? (
                <Approval key={message.id} message={message} state={state} />
              ) : (
                <article
                  key={message.id}
                  className={`agent-message ${message.role}`}
                >
                  <small
                    className={
                      message.role === "assistant"
                        ? "sr-only"
                        : "agent-message-label"
                    }
                  >
                    {message.role === "assistant"
                      ? conversation?.chat.provider === "claude"
                        ? "Claude"
                        : "Codex"
                      : "Уведомление"}
                  </small>
                  <MessageContent content={message.content} />
                </article>
              ),
            )}
          </section>
        );
      })}
    </>
  );
}
