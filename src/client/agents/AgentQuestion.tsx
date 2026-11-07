import { useId, useRef, useState } from "react";
import { ChatCircleDots, Check } from "@phosphor-icons/react";
import type { AgentMessage, AgentTurn } from "../../shared/agents";
import type { AgentQuestionRequest } from "../../shared/agent-interactions";
import type { AgentChatState } from "./useAgentChat";
import "./agent-interactions.css";

export function messageQuestion(
  message: AgentMessage,
): AgentQuestionRequest | undefined {
  const value = message.details?.question as AgentQuestionRequest | undefined;
  return message.role === "question" &&
    value &&
    typeof value.id === "string" &&
    Array.isArray(value.questions)
    ? value
    : undefined;
}
export function waitingForAnswer(
  messages: AgentMessage[],
  active: AgentTurn | null | undefined,
) {
  return Boolean(
    active &&
    messages.some(
      (message) =>
        message.turnId === active.id &&
        messageQuestion(message)?.status === "pending",
    ),
  );
}
export default function AgentQuestion({
  message,
  state,
}: {
  message: AgentMessage;
  state: AgentChatState;
}) {
  const request = messageQuestion(message);
  const formId = useId();
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  if (!request) return null;
  const pending =
    request.status === "pending" &&
    Boolean(
      state.active &&
      state.active.id === message.turnId &&
      ["running", "waiting"].includes(state.active.status),
    );
  const answers = Object.fromEntries(
    request.questions.map((question) => {
      const text = custom[question.id]?.trim();
      const selected = choices[question.id] || [];
      return [
        question.id,
        text ? [...(question.multiSelect ? selected : []), text] : selected,
      ];
    }),
  );
  const ready = request.questions.every(
    (question) => answers[question.id].length > 0,
  );
  const disabled = submitting || state.interactionBusy;
  if (!pending)
    return (
      <article className="agent-message agent-question resolved">
        <div className="agent-question-heading">
          <Check size={15} />
          {request.status === "answered" ? "Ответ отправлен" : "Запрос закрыт"}
        </div>
        {request.questions.map((question) => (
          <div className="agent-question-answer" key={question.id}>
            <p>{question.question}</p>
            {request.status === "answered" && (
              <span>
                {question.isSecret
                  ? "Ответ скрыт"
                  : request.answers?.[question.id]?.join(", ") ||
                    "Ответ отправлен"}
              </span>
            )}
          </div>
        ))}
      </article>
    );
  return (
    <article className="agent-message agent-question pending">
      <div className="agent-question-heading">
        <ChatCircleDots size={17} />
        Нужен ваш ответ
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || disabled || inFlight.current) return;
          inFlight.current = true;
          setSubmitting(true);
          setError("");
          void state
            .answerQuestion(request.id, answers)
            .catch((failure: Error) => setError(failure.message))
            .finally(() => {
              inFlight.current = false;
              setSubmitting(false);
            });
        }}
      >
        {request.questions.map((question) => (
          <fieldset key={question.id} disabled={disabled}>
            <legend>{question.question}</legend>
            {question.multiSelect && (
              <small className="agent-question-hint">
                Можно выбрать несколько
              </small>
            )}
            <div className="agent-question-options">
              {question.options.map((option, index) => (
                <label
                  className="agent-question-option"
                  key={`${index}:${option.label}`}
                >
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`${formId}-${question.id}`}
                    value={option.label}
                    checked={(choices[question.id] || []).includes(
                      option.label,
                    )}
                    onChange={(event) => {
                      setChoices((current) => ({
                        ...current,
                        [question.id]: question.multiSelect
                          ? event.target.checked
                            ? [...(current[question.id] || []), option.label]
                            : (current[question.id] || []).filter(
                                (value) => value !== option.label,
                              )
                          : [option.label],
                      }));
                      if (!question.multiSelect)
                        setCustom((current) => ({
                          ...current,
                          [question.id]: "",
                        }));
                    }}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
            </div>
            {(question.allowOther || !question.options.length) && (
              <label className="agent-question-custom">
                <span>
                  {question.options.length ? "Свой ответ" : "Ваш ответ"}
                </span>
                {question.isSecret ? (
                  <input
                    type="password"
                    autoComplete="off"
                    aria-label={`Свой ответ: ${question.header}`}
                    value={custom[question.id] || ""}
                    maxLength={10000}
                    onChange={(event) =>
                      setCustom((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }))
                    }
                  />
                ) : (
                  <textarea
                    rows={2}
                    aria-label={`Свой ответ: ${question.header}`}
                    value={custom[question.id] || ""}
                    maxLength={10000}
                    onChange={(event) => {
                      setCustom((current) => ({
                        ...current,
                        [question.id]: event.target.value,
                      }));
                      if (!question.multiSelect)
                        setChoices((current) => ({
                          ...current,
                          [question.id]: [],
                        }));
                    }}
                  />
                )}
              </label>
            )}
          </fieldset>
        ))}
        {error && (
          <p className="agent-question-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="agent-question-submit"
          disabled={!ready || disabled}
        >
          {submitting ? "Отправляем…" : "Отправить ответ"}
        </button>
      </form>
    </article>
  );
}
