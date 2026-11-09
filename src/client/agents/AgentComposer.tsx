import { useEffect, useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  DotsThree,
  ArrowUp,
  Stop,
  CaretDown,
  ClockCounterClockwise,
  Gear,
  ChatCircle,
  Check,
  ImageSquare,
  Plus,
  ShieldCheck,
  X,
} from "@phosphor-icons/react";
import type { AgentChatState } from "./useAgentChat";
import AgentHistory from "./AgentHistory";
import AgentFileMentions, { AgentContextChips } from "./AgentFileMentions";
import type { DraftAgentImage } from "./useAgentImageDrafts";
import { useAgentPortalContainer } from "./useAgentPortalContainer";
import type { OpenEditorTab } from "./ProjectSync";
import { waitingForAnswer } from "./AgentQuestion";
import AgentModelSettings from "./AgentModelSettings";

export interface ComposerProps {
  state: AgentChatState;
  selectedProfile: string;
  onProfileChange: (id: string) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => Promise<void>;
  onSettings: () => void;
  filePaths?: string[];
  onFilesChange?: (paths: string[]) => void;
  editorTabs?: OpenEditorTab[];
  editorTarget?: OpenEditorTab;
  onEditorTargetChange?: (tab: OpenEditorTab | undefined) => void;
  boardNodes?: { id: string; title: string }[];
  onDismissBoardNode?: (id: string) => void;
  images?: DraftAgentImage[];
  imagesLoading?: boolean;
  onImagesAdd?: (files: File[]) => Promise<void>;
  onImageRemove?: (id: string) => void;
}
export default function AgentComposer({
  state,
  selectedProfile,
  onProfileChange,
  draft,
  onDraftChange,
  onSend,
  onSettings,
  filePaths = [],
  onFilesChange,
  editorTabs = [],
  editorTarget,
  onEditorTargetChange,
  boardNodes = [],
  onDismissBoardNode,
  images = [],
  imagesLoading = false,
  onImagesAdd,
  onImageRemove,
}: ComposerProps) {
  const portalContainer = useAgentPortalContainer();
  const [history, setHistory] = useState(false);
  const [dragging, setDragging] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const profileId =
    (state.conversation?.chat.id === state.selected
      ? state.conversation.chat.profileId
      : state.chats?.find((chat) => chat.id === state.selected)?.profileId) ||
    selectedProfile;
  const profile = state.profiles.find((p) => p.id === profileId);
  const steering = Boolean(
    state.active && state.active.chatId === state.selected,
  );
  useEffect(() => {
    state.setModelProfile?.(profileId);
  }, [profileId, state.setModelProfile]);
  const hasContent = Boolean(draft.trim() || images.length);
  const stopping = steering && !hasContent;
  const canSend =
    !state.busy &&
    !state.modelSettingsBusy &&
    (!state.active || steering) &&
    !imagesLoading &&
    hasContent &&
    Boolean(profile?.trusted);
  const submit = () => {
    if (canSend) void onSend();
  };
  const selectProfile = (id: string) => {
    if (id !== profileId && state.selected) state.setSelected("");
    onProfileChange(id);
  };
  return (
    <div className="agent-composer-zone">
      <form
        className={`agent-composer${dragging ? " dragging" : ""}`}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (!files.length || !onImagesAdd) return;
          event.preventDefault();
          if (state.busy) return;
          void onImagesAdd(files);
        }}
        onDragOver={(event) => {
          if (!onImagesAdd || !event.dataTransfer.types.includes("Files"))
            return;
          event.preventDefault();
          if (state.busy) return;
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDragging(false);
        }}
        onDrop={(event) => {
          setDragging(false);
          if (!onImagesAdd || !event.dataTransfer.files.length) return;
          event.preventDefault();
          if (state.busy) return;
          void onImagesAdd(Array.from(event.dataTransfer.files));
        }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {state.active && (
          <div className="agent-composer-status" role="status">
            <span className={`agent-status-dot ${state.active.status}`} />
            {state.active.chatId !== state.selected
              ? "Задача выполняется в другом чате"
              : state.active.status === "waiting"
                ? waitingForAnswer(
                    state.conversation?.messages || [],
                    state.active,
                  )
                  ? "Нужен ваш ответ"
                  : "Нужно ваше разрешение"
                : "Агент работает"}
            {state.active.chatId !== state.selected && (
              <button
                type="button"
                onClick={() => state.setSelected(state.active!.chatId)}
              >
                Открыть
              </button>
            )}
          </div>
        )}
        <AgentContextChips
          filePaths={filePaths}
          onFilesChange={onFilesChange}
          editorTarget={editorTarget}
          onEditorTargetChange={onEditorTargetChange}
          boardNodes={boardNodes}
          onDismissBoardNode={onDismissBoardNode}
        />
        {images.length > 0 && (
          <div
            className="agent-image-previews"
            aria-label="Изображения для агента"
          >
            {images.map((image) => (
              <div className="agent-image-preview" key={image.localId}>
                <img src={image.dataUrl} alt={image.name} />
                <button
                  type="button"
                  title="Убрать изображение"
                  aria-label={`Убрать изображение ${image.name}`}
                  disabled={state.busy && !steering}
                  onClick={() => onImageRemove?.(image.localId)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        {imagesLoading && (
          <p className="agent-image-loading" role="status">
            Загружаем изображения…
          </p>
        )}
        <AgentFileMentions
          draft={draft}
          draftKey={state.selected || "new"}
          onDraftChange={onDraftChange}
          filePaths={filePaths}
          onFilesChange={onFilesChange}
          editorTabs={editorTabs}
          editorTarget={editorTarget}
          onEditorTargetChange={onEditorTargetChange}
          onSubmit={submit}
        />
        <div className="agent-composer-toolbar">
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            disabled={state.busy}
            hidden
            aria-label="Изображения для агента"
            onChange={(event) => {
              const files = Array.from(event.target.files || []);
              event.target.value = "";
              void onImagesAdd?.(files);
            }}
          />
          <div className="agent-composer-tools">
            <Menu.Root modal={false}>
              <Menu.Trigger asChild>
                <button
                  type="button"
                  className="agent-icon-button agent-composer-control"
                  aria-label="Добавить вложение"
                  title="Добавить вложение"
                  disabled={!onImagesAdd || state.busy}
                >
                  <Plus size={18} />
                </button>
              </Menu.Trigger>
              <Menu.Portal container={portalContainer}>
                <Menu.Content
                  className="agent-menu"
                  side="top"
                  align="start"
                  sideOffset={12}
                >
                  <Menu.Item
                    disabled={!onImagesAdd || state.busy}
                    onSelect={() => imageInput.current?.click()}
                    title="До 4 изображений по 5 МБ · PNG, JPEG, GIF, WebP"
                  >
                    <ImageSquare size={18} />
                    Изображения
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
            <Menu.Root modal={false}>
              <Menu.Trigger asChild>
                <button
                  type="button"
                  className="agent-icon-button agent-composer-control"
                  aria-label="Действия чата"
                  title="Действия чата"
                >
                  <DotsThree size={18} weight="bold" />
                </button>
              </Menu.Trigger>
              <Menu.Portal container={portalContainer}>
                <Menu.Content
                  className="agent-menu"
                  side="top"
                  align="start"
                  sideOffset={12}
                >
                  <Menu.Item
                    disabled={state.busy}
                    onSelect={() => state.setSelected("")}
                  >
                    <ChatCircle size={17} />
                    Новый разговор
                  </Menu.Item>
                  <Menu.Item
                    disabled={state.busy}
                    onSelect={() => setHistory(true)}
                  >
                    <ClockCounterClockwise size={17} />
                    История чатов
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
            <button
              type="button"
              role="switch"
              aria-label="Автоапрув"
              aria-checked={Boolean(state.autoApprove)}
              className="agent-composer-control agent-auto-approve"
              disabled={
                state.busy ||
                state.approvalBusy ||
                Boolean(
                  state.selected &&
                  state.conversation?.chat.id !== state.selected,
                )
              }
              title={`Автоапрув: ${state.autoApprove ? "включён" : "выключен"}. Автоматически разрешать действия в этом чате, включая ожидающие`}
              onClick={() =>
                void state.setAutoApprove(!state.autoApprove).catch(() => {})
              }
            >
              <ShieldCheck
                size={18}
                weight={state.autoApprove ? "fill" : "regular"}
                aria-hidden="true"
              />
            </button>
          </div>
          <div className="agent-composer-model">
            {state.setModelSettings && (
              <AgentModelSettings
                key={`${state.selected || "new"}:${profileId}`}
                profileId={profileId}
                trusted={Boolean(profile?.trusted)}
                settings={state.modelSettings}
                saving={state.modelSettingsBusy}
                disabled={
                  state.busy ||
                  steering ||
                  Boolean(
                    state.selected &&
                    state.conversation?.chat.id !== state.selected,
                  )
                }
                onChange={(settings) =>
                  state.setModelSettings(settings, profileId)
                }
              />
            )}
            <Menu.Root modal={false}>
              <Menu.Trigger asChild>
                <button
                  type="button"
                  className="agent-profile-button agent-composer-control"
                  aria-label="Выбрать профиль агента"
                  title={profile?.name || "Выбрать профиль"}
                  disabled={state.busy}
                >
                  <span>{profile?.name || "Выбрать агента"}</span>
                  <CaretDown size={12} />
                </button>
              </Menu.Trigger>
              <Menu.Portal container={portalContainer}>
                <Menu.Content
                  className="agent-menu agent-profile-menu"
                  side="top"
                  align="start"
                  sideOffset={12}
                >
                  <Menu.Label className="agent-menu-label">
                    Локальные агенты
                  </Menu.Label>
                  <Menu.RadioGroup
                    value={profileId}
                    onValueChange={selectProfile}
                  >
                    {state.profiles.map((p) => (
                      <Menu.RadioItem key={p.id} value={p.id}>
                        <span className="agent-profile-option">
                          <strong>{p.name}</strong>
                          <small>
                            {p.provider === "codex"
                              ? "Codex CLI"
                              : "Claude CLI"}
                            {!p.trusted ? " · требуется настройка" : ""}
                          </small>
                        </span>
                        <Menu.ItemIndicator>
                          <Check size={16} />
                        </Menu.ItemIndicator>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                  {state.selected && (
                    <p className="agent-menu-hint">
                      Другой профиль откроет новый чат.
                    </p>
                  )}
                  <Menu.Separator />
                  <Menu.Item onSelect={onSettings}>
                    <Gear size={17} />
                    Настроить агента
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu.Root>
            <button
              type={stopping ? "button" : "submit"}
              className={`agent-send agent-composer-control${stopping ? " agent-stop" : ""}`}
              aria-label={
                stopping
                  ? "Остановить"
                  : steering
                    ? "Направить агента"
                    : "Отправить сообщение"
              }
              title={
                stopping
                  ? "Остановить задачу"
                  : steering
                    ? "Уточнить задачу без остановки · ⌘ / Ctrl + Enter"
                    : "Отправить · ⌘ / Ctrl + Enter"
              }
              disabled={stopping ? state.interactionBusy : !canSend}
              onClick={
                stopping ? () => void state.stop().catch(() => {}) : undefined
              }
            >
              {stopping ? (
                <Stop size={16} weight="fill" />
              ) : (
                <ArrowUp size={18} />
              )}
            </button>
          </div>
        </div>
      </form>
      {profile && !profile.trusted && (
        <p className="agent-composer-caption">
          Настройте команду агента перед запуском
        </p>
      )}
      <AgentHistory
        open={history}
        onOpenChange={setHistory}
        chats={state.chats}
        selected={state.selected}
        onSelect={state.setSelected}
      />
    </div>
  );
}
