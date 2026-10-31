import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, ChatCircle } from "@phosphor-icons/react";
import AgentMessages from "./AgentMessages";
import AgentComposer, { type ComposerProps } from "./AgentComposer";

export default function AgentChatView(props: ComposerProps) {
  const { state, onDraftChange, onSettings } = props;
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previousChat = useRef(state.selected);
  const previousText = useRef("");
  const [below, setBelow] = useState(false);
  // Tool traffic changes the activity summary, never the reader's position.
  const text = (state.conversation?.messages || [])
    .filter((m) => m.role !== "action")
    .map((m) => `${m.id}:${m.content}`)
    .join("\n");
  useLayoutEffect(() => {
    const element = log.current;
    if (!element) return;
    const changedChat = previousChat.current !== state.selected;
    if (changedChat) {
      previousChat.current = state.selected;
      pinned.current = true;
    }
    if (text !== previousText.current || changedChat) {
      if (pinned.current) {
        element.scrollTop = element.scrollHeight;
        setBelow(false);
      } else setBelow(true);
      previousText.current = text;
    }
  }, [text, state.selected]);
  useEffect(() => {
    const element = log.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const empty = !state.conversation?.messages.length;
  return (
    <>
      <div className="agent-transcript">
        <div
          ref={log}
          className="agent-log"
          role="log"
          aria-label="Сообщения агента"
          aria-live="polite"
          aria-relevant="additions text"
          onScroll={() => {
            if (!log.current) return;
            pinned.current =
              log.current.scrollHeight -
                log.current.scrollTop -
                log.current.clientHeight <
              48;
            if (pinned.current) setBelow(false);
          }}
        >
          {empty && (
            <div className="agent-empty">
              <ChatCircle size={32} weight="light" />
              <h2>С чего начнём?</h2>
              <p>
                {state.profiles.length
                  ? "Исследуйте данные и воплощайте идеи вместе с агентом."
                  : "Подключите локальный Codex или Claude и работайте с проектом в одном чате."}
              </p>
              {state.profiles.length ? (
                <div className="agent-suggestions">
                  {[
                    "Исследуй мои данные",
                    "Помоги написать SQL",
                    "Собери доску с выводами",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => {
                        onDraftChange(suggestion);
                        document.getElementById("agent-message")?.focus();
                      }}
                    >
                      {suggestion}
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                </div>
              ) : (
                <button className="agent-setup-button" onClick={onSettings}>
                  Подключить агента
                  <ArrowUpRight size={16} />
                </button>
              )}
            </div>
          )}
          <AgentMessages state={state} />
        </div>
        {below && (
          <button
            className="agent-jump"
            aria-label="К последнему сообщению"
            onClick={() => {
              if (log.current) log.current.scrollTop = log.current.scrollHeight;
              pinned.current = true;
              setBelow(false);
            }}
          >
            <ArrowDown size={17} />
          </button>
        )}
      </div>
      <AgentComposer {...props} />
    </>
  );
}
