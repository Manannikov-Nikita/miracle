import { useEffect, useRef, useState } from "react";
import { ChatCircle, Gear, X } from "@phosphor-icons/react";
import AgentChatView from "./AgentChatView";
import { ErrorBox, Spinner } from "../components/UI";
import AgentProfiles from "./AgentProfiles";
import { useAgentChat } from "./useAgentChat";
import "./agents.css";
export default function AgentAssistant() {
  const state = useAgentChat();
  const [settings, setSettings] = useState(false),
    [profileId, setProfileId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const toggle = useRef<HTMLButtonElement>(null),
    close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const requestIds = useRef(new Map<string, { content: string; id: string }>());
  const draftKey = state.selected || "new",
    draft = drafts[draftKey] || "";
  const selectedProfile = profileId || state.profiles[0]?.id || "";
  const active = state.active,
    status =
      active?.status === "waiting"
        ? "Ожидает разрешения"
        : active
          ? "Работает"
          : state.unread
            ? "Новое сообщение"
            : "Агент";
  useEffect(() => {
    if (state.open) close.current?.focus();
    else if (wasOpen.current) toggle.current?.focus();
    wasOpen.current = state.open;
  }, [state.open]);
  const dismiss = () => {
    state.close();
    toggle.current?.focus();
  };
  const send = async () => {
    const content = draft.trim();
    if (!content) return;
    const previous = requestIds.current.get(draftKey);
    const requestId =
      previous?.content === content ? previous.id : crypto.randomUUID();
    requestIds.current.set(draftKey, { content, id: requestId });
    try {
      let createdId = "";
      await state.send(content, selectedProfile, requestId, (id) => {
        createdId = id;
        requestIds.current.set(id, { content, id: requestId });
        setDrafts((items) => ({ ...items, [id]: items[draftKey] || content }));
      });
      setDrafts((items) => ({
        ...items,
        [draftKey]: "",
        ...(createdId ? { [createdId]: "" } : {}),
      }));
      if (createdId) requestIds.current.delete(createdId);
      requestIds.current.delete(draftKey);
    } catch {}
  };
  return (
    <>
      <button
        ref={toggle}
        type="button"
        className={`agent-toggle ${active ? "busy" : ""} ${active?.status === "waiting" ? "waiting" : ""}`}
        aria-label={`Чат агента — ${status}`}
        aria-expanded={state.open}
        aria-controls="agent-panel"
        onClick={state.toggle}
        title={status}
      >
        {active?.status === "running" ? <Spinner /> : <ChatCircle size={25} />}
        {state.unread && (
          <span className="agent-unread" aria-label="Новое сообщение" />
        )}
      </button>
      {state.open && (
        <aside
          id="agent-panel"
          className="agent-panel"
          role="complementary"
          aria-label="Чат локального агента"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              dismiss();
            }
          }}
        >
          <header className="agent-header">
            <div>
              <strong>Локальный агент</strong>
              <span role="status">{status}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Настройки агента"
              aria-pressed={settings}
              onClick={() => setSettings((s) => !s)}
            >
              <Gear size={18} />
            </button>
            <button
              ref={close}
              className="icon-button"
              type="button"
              aria-label="Закрыть чат агента"
              onClick={dismiss}
            >
              <X size={18} />
            </button>
          </header>
          {state.projectRoot && (
            <div className="agent-project" title={state.projectRoot}>
              {state.projectRoot}
            </div>
          )}
          {state.error && (
            <div className="agent-error">
              <ErrorBox>{state.error}</ErrorBox>
              <button
                className="text-button"
                onClick={() =>
                  void state
                    .refresh()
                    .then(() => state.setError(""))
                    .catch((e) => state.setError(e.message))
                }
              >
                Повторить подключение
              </button>
            </div>
          )}
          {state.loading ? (
            <div className="agent-empty" role="status">
              <Spinner /> Загружаем разговоры…
            </div>
          ) : settings ? (
            <div className="agent-settings">
              <AgentProfiles
                profiles={state.profiles}
                onChanged={state.refresh}
              />
            </div>
          ) : (
            <AgentChatView
              state={state}
              selectedProfile={selectedProfile}
              onProfileChange={setProfileId}
              draft={draft}
              onDraftChange={(value) =>
                setDrafts((items) => ({ ...items, [draftKey]: value }))
              }
              onSend={send}
              onSettings={() => setSettings(true)}
            />
          )}
        </aside>
      )}
    </>
  );
}
