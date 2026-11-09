import { useEffect, useRef, useState } from "react";
import { ChatCircle, X } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import AgentChatView from "./AgentChatView";
import { ErrorBox, Spinner } from "../components/UI";
import AgentProfiles from "./AgentProfiles";
import { useAgentChat } from "./useAgentChat";
import {
  useProjectSync,
  useProjectTargetContext,
  useOpenEditorTabs,
  type OpenEditorTab,
} from "./ProjectSync";
import { useAgentImageDrafts } from "./useAgentImageDrafts";
import { useAgentPortalContainer } from "./useAgentPortalContainer";
import "./agents.css";
import "./agent-images.css";
import { waitingForAnswer } from "./AgentQuestion";
import AgentActivityRail from "./AgentActivityRail";
export default function AgentAssistant({
  onOpenRun,
}: { onOpenRun?: (id: string) => Promise<void> } = {}) {
  const state = useAgentChat();
  const portalContainer = useAgentPortalContainer(state.open);
  const project = useProjectSync();
  const targetContext = useProjectTargetContext();
  const editorTabs = useOpenEditorTabs();
  const [settings, setSettings] = useState(false),
    [settingsBusy, setSettingsBusy] = useState(false),
    [profileId, setProfileId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, string[]>>({});
  const [editorTargets, setEditorTargets] = useState<
    Record<string, OpenEditorTab | undefined>
  >({});
  const [dismissed, setDismissed] = useState({ key: "", ids: [] as string[] });
  const toggle = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const requestIds = useRef(new Map<string, { content: string; id: string }>());
  const draftKey = state.selected || "new",
    draft = drafts[draftKey] || "";
  const imageDraft = useAgentImageDrafts(draftKey, state.setError);
  const selectedProfile = state.profiles.some(
    (profile) => profile.id === profileId,
  )
    ? profileId
    : state.profiles[0]?.id || "";
  const selectionKey = (context: typeof targetContext, key = draftKey) =>
    JSON.stringify([
      key,
      context.boardId,
      context.slideId,
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
        ? waitingForAnswer(state.conversation?.messages || [], active)
          ? "Ожидает ответа"
          : "Ожидает разрешения"
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
    if (settingsBusy) return;
    state.close();
    toggle.current?.focus();
  };
  const send = async () => {
    const content = draft.trim();
    const images = [...imageDraft.images];
    if (
      (!content && !images.length) ||
      imageDraft.loading ||
      state.busy ||
      (state.active && state.active.chatId !== state.selected)
    )
      return;
    const current = project?.context() || targetContext;
    const filePaths = [...(files[draftKey] || [])];
    const editorTarget = editorTargets[draftKey];
    const references = {
      // Explicitly override editor focus captured by ProjectSync.prepare().
      editorDocumentId: editorTarget?.path ? undefined : editorTarget?.id,
      selection: undefined,
      filePaths,
      boardId: current.boardId,
      slideId: current.slideId,
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
      slideId: references.slideId,
      editorTarget: editorTarget
        ? { id: editorTarget.id, path: editorTarget.path }
        : undefined,
      boardNodeIds: references.boardNodes.map((node) => node.id),
      imageIds: images.map((image) => image.localId),
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
          setEditorTargets((items) => ({ ...items, [id]: editorTarget }));
          imageDraft.move(id, images);
          // Creating a chat only moves this draft. Keep its omitted targets
          // so a failed message POST can be retried with the same identity.
          setDismissed((value) =>
            value.key === selectionKey(current)
              ? { ...value, key: selectionKey(current, id) }
              : value,
          );
        },
        references,
        images.map(({ localId, ...image }) => image),
      );
      setDrafts((items) => ({
        ...items,
        [draftKey]:
          (items[draftKey] || "").trim() === content ? "" : items[draftKey],
        ...(createdId
          ? {
              [createdId]:
                (items[createdId] || "").trim() === content
                  ? ""
                  : items[createdId],
            }
          : {}),
      }));
      setFiles((items) => ({
        ...items,
        [draftKey]: (items[draftKey] || []).filter(
          (path) => !filePaths.includes(path),
        ),
        ...(createdId ? { [createdId]: [] } : {}),
      }));
      setDismissed({ key: "", ids: [] });
      setEditorTargets((items) => {
        const next = { ...items };
        for (const key of [draftKey, ...(createdId ? [createdId] : [])])
          if (next[key]?.id === editorTarget?.id) delete next[key];
        return next;
      });
      imageDraft.clear([draftKey, ...(createdId ? [createdId] : [])], images);
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
        disabled={settingsBusy}
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
          <AgentActivityRail state={state} onOpenRun={onOpenRun} />
          <div className="agent-main-pane">
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
                images={imageDraft.images}
                imagesLoading={imageDraft.loading}
                onImagesAdd={imageDraft.add}
                onImageRemove={imageDraft.remove}
                filePaths={files[draftKey] || []}
                onFilesChange={(paths) => {
                  setFiles((items) => ({ ...items, [draftKey]: paths }));
                  setEditorTargets((items) =>
                    items[draftKey]?.path &&
                    !paths.includes(items[draftKey]!.path!)
                      ? { ...items, [draftKey]: undefined }
                      : items,
                  );
                }}
                editorTabs={editorTabs}
                editorTarget={editorTargets[draftKey]}
                onEditorTargetChange={(tab) =>
                  setEditorTargets((items) => ({ ...items, [draftKey]: tab }))
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
          </div>
          <Dialog.Root
            open={settings}
            onOpenChange={(open) => {
              if (!settingsBusy) setSettings(open);
            }}
          >
            <Dialog.Portal container={portalContainer}>
              <Dialog.Overlay className="agent-dialog-overlay" />
              <Dialog.Content
                className="agent-dialog agent-settings-dialog"
                aria-describedby={undefined}
                onEscapeKeyDown={(event) => {
                  event.stopPropagation();
                  if (settingsBusy) event.preventDefault();
                }}
                onPointerDownOutside={(event) => {
                  if (settingsBusy) event.preventDefault();
                }}
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
                    disabled={settingsBusy}
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
                    initialProfileId={
                      state.conversation?.chat.profileId || selectedProfile
                    }
                    onChanged={state.refresh}
                    onBusyChange={setSettingsBusy}
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
