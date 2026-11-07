import { useId, useState } from "react";
import Markdown from "react-markdown";
import { markdownRemarkPlugins, markdownRehypePlugins } from "../markdown-math";
import "katex/dist/katex.min.css";
import { CaretRight, ShieldCheck } from "@phosphor-icons/react";
import type { AgentMessage } from "../../shared/agents";
import type { AgentChatState } from "./useAgentChat";
import AgentActivity from "./AgentActivity";
import { transcriptTurns } from "./agent-transcript";
import { AgentContextChips } from "./AgentFileMentions";
import AgentMessageImages from "./AgentMessageImages";
import AgentQuestion from "./AgentQuestion";

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
  const editorTarget =
    typeof value.editorDocumentId === "string" &&
    typeof value.editorDocumentName === "string"
      ? { id: value.editorDocumentId, name: value.editorDocumentName }
      : undefined;
  return (
    <AgentContextChips
      filePaths={filePaths}
      boardNodes={boardNodes}
      editorTarget={editorTarget}
    />
  );
}

function MessageContent({ content }: { content: string }) {
  return (
    <div className="agent-markdown">
      <Markdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
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

function SteerReceipt({ value }: { value: unknown }) {
  if (!value) return null;
  const receipt =
    typeof value === "object" ? (value as Record<string, unknown>) : {};
  return (
    <span className="agent-steer-label">
      {receipt.status === "sending"
        ? "Передаём уточнение…"
        : receipt.status === "failed"
          ? "Доставка не подтверждена"
          : "Уточнение по ходу работы"}
      {receipt.status === "failed" && typeof receipt.error === "string" && (
        <span className="agent-steer-error">{receipt.error}</span>
      )}
    </span>
  );
}

function approvalInfo(message: AgentMessage, state: AgentChatState) {
  const approvalId =
    typeof message.details?.approvalId === "string"
      ? message.details.approvalId
      : "";
  const decision =
    state.resolvedApprovals.get(approvalId) || message.details?.decision;
  const pending =
    Boolean(approvalId) &&
    state.active?.id === message.turnId &&
    state.active?.status === "waiting" &&
    !decision &&
    !message.details?.resolved;
  const label =
    decision === "allow"
      ? message.details?.automatic === true
        ? "Разрешено автоматически"
        : "Разрешено"
      : decision === "deny"
        ? "Отклонено"
        : pending
          ? "Нужно разрешение"
          : "Запрос закрыт";
  return { approvalId, decision, pending, label };
}

function Approval({
  message,
  state,
}: {
  message: AgentMessage;
  state: AgentChatState;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { approvalId, pending, label } = approvalInfo(message, state);
  return (
    <article
      className={`agent-message approval ${pending ? "pending" : "resolved"}`}
    >
      <div className="agent-approval-row">
        <button
          type="button"
          className="agent-approval-trigger"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((value) => !value)}
        >
          <ShieldCheck size={14} />
          <span className="agent-approval-label">{label}</span>
          <span className="agent-approval-preview">{message.content}</span>
          <CaretRight size={12} className="agent-approval-caret" />
        </button>
        {pending && (
          <div className="agent-approval-actions">
            <button
              type="button"
              disabled={state.interactionBusy}
              onClick={() =>
                void state.approve(approvalId, "allow").catch(() => {})
              }
            >
              Разрешить
            </button>
            <button
              type="button"
              disabled={state.interactionBusy}
              onClick={() =>
                void state.approve(approvalId, "deny").catch(() => {})
              }
            >
              Отклонить
            </button>
          </div>
        )}
      </div>
      <div id={detailsId} hidden={!expanded} className="agent-approval-content">
        {expanded && (
          <>
            <MessageContent content={message.content} />
            {message.details && (
              <details className="agent-approval-details">
                <summary>Запрашиваемое действие</summary>
                <pre>{JSON.stringify(message.details, null, 2)}</pre>
              </details>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function Approvals({
  messages,
  state,
}: {
  messages: AgentMessage[];
  state: AgentChatState;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const pending: AgentMessage[] = [];
  const resolved: AgentMessage[] = [];
  let denied = 0;
  for (const message of messages) {
    const info = approvalInfo(message, state);
    if (info.pending) pending.push(message);
    else {
      resolved.push(message);
      if (info.decision === "deny") denied += 1;
    }
  }
  return (
    <>
      {resolved.length > 0 && (
        <div className="agent-approvals">
          <button
            type="button"
            className="agent-approvals-summary"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((value) => !value)}
          >
            <ShieldCheck size={14} aria-hidden="true" />
            <span>Разрешения · {resolved.length}</span>
            {denied > 0 && <span>Отклонено: {denied}</span>}
            <CaretRight size={12} aria-hidden="true" />
          </button>
          <div
            id={detailsId}
            hidden={!expanded}
            className="agent-approvals-list"
          >
            {expanded &&
              resolved.map((message) => (
                <Approval key={message.id} message={message} state={state} />
              ))}
          </div>
        </div>
      )}
      {pending.map((message) => (
        <Approval key={message.id} message={message} state={state} />
      ))}
    </>
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
        const visibleMessages = group.messages.filter(
          (message) => message.role !== "action" && message.role !== "approval",
        );
        const approvals = group.messages.filter(
          (message) => message.role === "approval",
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
            {visibleMessages.map((message) => {
              if (message.role === "question")
                return (
                  <AgentQuestion
                    key={message.id}
                    message={message}
                    state={state}
                  />
                );
              const user = message.role === "user";
              return (
                <article
                  key={message.id}
                  className={`agent-message ${message.role}`}
                >
                  <small
                    className={
                      message.role === "system"
                        ? "agent-message-label"
                        : "sr-only"
                    }
                  >
                    {user
                      ? "Вы"
                      : message.role === "assistant"
                        ? conversation?.chat.provider === "claude"
                          ? "Claude"
                          : "Codex"
                        : "Уведомление"}
                  </small>
                  {user && (
                    <>
                      <SteerReceipt value={message.details?.steer} />
                      <MessageReferences
                        context={
                          message.details?.context || group.turn?.context
                        }
                      />
                      <AgentMessageImages images={message.details?.images} />
                    </>
                  )}
                  <MessageContent content={message.content} />
                </article>
              );
            })}
            <Approvals messages={approvals} state={state} />
            {hasActivity && (
              <AgentActivity messages={group.messages} turn={group.turn} />
            )}
          </section>
        );
      })}
    </>
  );
}
