import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentMessage } from "../../shared/agents";
import type { AgentChatState } from "./useAgentChat";
function approvalLabel(message: AgentMessage, state: AgentChatState) {
  const decision =
    state.resolvedApprovals.get(String(message.details?.approvalId)) ||
    message.details?.decision;
  return decision === "allow"
    ? "Разрешено"
    : decision === "deny"
      ? "Отклонено"
      : message.details?.resolved
        ? "Запрос закрыт"
        : "Требуется разрешение";
}
export default function AgentMessages({ state }: { state: AgentChatState }) {
  const active = state.active;
  return (
    <>
      {" "}
      {state.conversation?.messages.map((message) => (
        <article key={message.id} className={`agent-message ${message.role}`}>
          <small>
            {message.role === "user"
              ? "Вы"
              : message.role === "assistant"
                ? state.conversation?.chat.provider
                : message.role === "approval"
                  ? approvalLabel(message, state)
                  : message.role === "action"
                    ? "Действие"
                    : "Система"}
          </small>
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
              {message.content}
            </Markdown>
          </div>
          {(message.role === "action" || message.role === "approval") &&
            message.details && (
              <details>
                <summary>
                  {message.role === "approval"
                    ? "Запрашиваемое действие"
                    : "Подробности действия"}
                </summary>
                <pre>{JSON.stringify(message.details, null, 2)}</pre>
              </details>
            )}
          {message.role === "approval" &&
            typeof message.details?.approvalId === "string" &&
            active?.id === message.turnId &&
            active?.status === "waiting" &&
            !state.resolvedApprovals.has(message.details.approvalId) &&
            !message.details.decision &&
            !message.details.resolved && (
              <div className="agent-actions">
                <button
                  className="button primary"
                  disabled={state.busy}
                  onClick={() =>
                    void state
                      .approve(message.details!.approvalId as string, "allow")
                      .catch(() => {})
                  }
                >
                  Разрешить
                </button>
                <button
                  className="button"
                  disabled={state.busy}
                  onClick={() =>
                    void state
                      .approve(message.details!.approvalId as string, "deny")
                      .catch(() => {})
                  }
                >
                  Отклонить
                </button>
              </div>
            )}
        </article>
      ))}
    </>
  );
}
