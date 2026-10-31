import { useEffect, useRef, useState } from "react";
import { ChatCircle, FolderSimple, X } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import AgentChatView from "./AgentChatView";
import { ErrorBox, Spinner } from "../components/UI";
import AgentProfiles from "./AgentProfiles";
import { useAgentChat } from "./useAgentChat";
import { useProjectSync, useProjectTargetContext } from "./ProjectSync";
import "./agents.css";
export default function AgentAssistant() {
  const state = useAgentChat();
  const project = useProjectSync();
  const targetContext = useProjectTargetContext();
  const [settings, setSettings] = useState(false),
    [profileId, setProfileId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, string[]>>({});
  const [dismissed, setDismissed] = useState({ key: "", ids: [] as string[] });
  const toggle = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const requestIds = useRef(new Map<string, { content: string; id: string }>());
  const draftKey = state.selected || "new",
    draft = drafts[draftKey] || "";
  const selectedProfile = profileId || state.profiles[0]?.id || "";
  const selectionKey = (context: typeof targetContext, key = draftKey) =>
    JSON.stringify([
      key,
      context.boardId,
      (context.boardNodes || []).map((node) => node.id),
    ]);
  const currentSelection = selectionKey(targetContext);
  const selectedNodes = (targetContext.boardNodes || []).filter(
    (node) =>
      dismissed.key !== currentSelection || !dismissed.ids.includes(node.id),
  );
  useEffect(() => {
    setDismissed((current) =>
      current.key === currentSelection
        ? current
        : { key: currentSelection, ids: [] },
    );
  }, [currentSelection]);
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
    if (state.open) document.getElementById("agent-message")?.focus();
    else if (wasOpen.current) toggle.current?.focus();
    wasOpen.current = state.open;
  }, [state.open, state.loading]);
  const dismiss = () => {
    state.close();
    toggle.current?.focus();
  };
  const send = async () => {
    const content = draft.trim();
    if (!content || state.busy || state.active) return;
    const current = project?.context() || targetContext;
    const filePaths = [...(files[draftKey] || [])];
    const references = {
      filePaths,
      boardId: current.boardId,
      boardNodes: (current.boardNodes || []).filter(
        (node) =>
          dismissed.key !== selectionKey(current) ||
          !dismissed.ids.includes(node.id),
      ),
    };
    const signature = JSON.stringify({
      content,
      filePaths,
      boardId: references.boardId,
      boardNodeIds: references.boardNodes.map((node) => node.id),
    });
    const previous = requestIds.current.get(draftKey);
    const requestId =
      previous?.content === signature ? previous.id : crypto.randomUUID();
    requestIds.current.set(draftKey, { content: signature, id: requestId });
    try {
      let createdId = "";
      await state.send(
        content,
        selectedProfile,
        requestId,
        (id) => {
          createdId = id;
          requestIds.current.set(id, { content: signature, id: requestId });
          setDrafts((items) => ({
            ...items,
            [id]: items[draftKey] || content,
          }));
          setFiles((items) => ({ ...items, [id]: filePaths }));
          // Creating a chat only moves this draft. Keep its omitted targets
          // so a failed message POST can be retried with the same identity.
          setDismissed((value) =>
            value.key === selectionKey(current)
              ? { ...value, key: selectionKey(current, id) }
              : value,
          );
        },
        references,
      );
      setDrafts((items) => ({
        ...items,
        [draftKey]: "",
        ...(createdId ? { [createdId]: "" } : {}),
      }));
      setFiles((items) => ({
        ...items,
        [draftKey]: (items[draftKey] || []).filter(
          (path) => !filePaths.includes(path),
        ),
        ...(createdId ? { [createdId]: [] } : {}),
      }));
      setDismissed({ key: "", ids: [] });
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
        aria-label={state.open ? "Закрыть чат агента" : `Чат агента: ${status}`}
        aria-expanded={state.open}
        aria-controls="agent-panel"
        onClick={state.toggle}
        title={state.open ? "Закрыть чат" : status}
      >
        {state.open ? (
          <X size={23} />
        ) : active?.status === "running" ? (
          <Spinner />
        ) : (
          <ChatCircle size={25} />
        )}
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
            if (e.key === "Escape" && !e.defaultPrevented) {
              e.stopPropagation();
              dismiss();
            }
          }}
        >
          <header className="agent-header">
            <strong>
              Miracle <span>Chat</span>
            </strong>
            {state.projectRoot && (
              <span className="agent-project" title={state.projectRoot}>
                <FolderSimple size={13} />
                {state.projectRoot.split(/[\\/]/).filter(Boolean).at(-1)}
              </span>
            )}
          </header>
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
              filePaths={files[draftKey] || []}
              onFilesChange={(paths) =>
                setFiles((items) => ({ ...items, [draftKey]: paths }))
              }
              boardNodes={selectedNodes}
              onDismissBoardNode={(id) =>
                setDismissed((current) => ({
                  key: currentSelection,
                  ids: [
                    ...(current.key === currentSelection ? current.ids : []),
                    id,
                  ],
                }))
              }
              onSettings={() => setSettings(true)}
            />
          )}
          <Dialog.Root open={settings} onOpenChange={setSettings}>
            <Dialog.Portal container={document.getElementById("agent-panel")}>
              <Dialog.Overlay className="agent-dialog-overlay" />
              <Dialog.Content
                className="agent-dialog agent-settings-dialog"
                aria-describedby={undefined}
                onEscapeKeyDown={(event) => event.stopPropagation()}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  document.getElementById("agent-message")?.focus();
                }}
              >
                <div className="agent-dialog-heading">
                  <Dialog.Title>Настройки агента</Dialog.Title>
                  <Dialog.Close
                    className="agent-icon-button"
                    aria-label="Закрыть настройки"
                  >
                    <X size={18} />
                  </Dialog.Close>
                </div>
                <div className="agent-settings">
                  <p className="agent-settings-intro">
                    Ваш CLI, ваша учётная запись.
                  </p>
                  <AgentProfiles
                    profiles={state.profiles}
                    onChanged={state.refresh}
                  />
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </aside>
      )}
    </>
  );
}
