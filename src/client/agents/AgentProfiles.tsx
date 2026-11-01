import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle, Plus, ShieldCheck, Trash } from "@phosphor-icons/react";
import type { AgentProfile, AgentProvider } from "../../shared/agents";
import { api, json } from "../api";
import { ErrorBox } from "../components/UI";
export default function AgentProfiles({
  profiles,
  initialProfileId,
  onChanged,
  onBusyChange,
}: {
  profiles: AgentProfile[];
  initialProfileId?: string;
  onChanged: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const initial =
    profiles.find((p) => p.id === initialProfileId) || profiles[0];
  const [id, setId] = useState(initial?.id || ""),
    [name, setName] = useState(initial?.name || ""),
    [provider, setProvider] = useState<AgentProvider>(
      initial?.provider || "codex",
    ),
    [command, setCommand] = useState(initial?.command || "codex");
  const [preview, setPreview] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState<"save" | "trust" | "delete" | null>(null),
    [deleting, setDeleting] = useState(false);
  const busy = pending !== null;
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const savedProfile = profiles.find((p) => p.id === id);
  const choose = (value: string) => {
    setId(value);
    const p = profiles.find((p) => p.id === value);
    setName(p?.name || "");
    setProvider(p?.provider || "codex");
    setCommand(p?.command || "codex");
    setPreview("");
    setError("");
  };
  const run = async (
    kind: NonNullable<typeof pending>,
    action: () => Promise<void>,
  ) => {
    if (busy) return;
    onBusyChange?.(true);
    setPending(kind);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
      onBusyChange?.(false);
    }
  };
  const save = () =>
    run("save", async () => {
      const profile = await api<AgentProfile>(
        id ? `/api/agent-profiles/${id}` : "/api/agent-profiles",
        {
          method: id ? "PATCH" : "POST",
          body: json({ name, provider, command }),
        },
      );
      setId(profile.id);
      await onChanged();
      const validation = await api<{
        version: string;
        commandPreview: string;
        executable: string;
      }>(`/api/agent-profiles/${profile.id}/validate`, { method: "POST" });
      setPreview(`${validation.version}\n${validation.commandPreview}`);
    });
  return (
    <div className="agent-profiles">
      <fieldset className="agent-profile-fields" disabled={busy}>
        <div className="agent-profile-picker">
          <label>
            Профиль
            <select
              aria-label="Профиль"
              value={id}
              onChange={(e) => {
                if (!busy) choose(e.target.value);
              }}
            >
              {!id && (
                <option value="" disabled>
                  Новый профиль
                </option>
              )}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="agent-icon-button"
            aria-label="Новый профиль агента"
            title="Новый профиль агента"
            onClick={() => {
              choose("");
              nameInput.current?.focus();
            }}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
        <label>
          Название
          <input
            ref={nameInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например, Codex для аналитики"
          />
        </label>
        <label>
          CLI
          <select
            value={provider}
            disabled={Boolean(id)}
            onChange={(e) => {
              const provider = e.target.value as AgentProvider;
              setProvider(provider);
              setCommand(provider);
              setPreview("");
            }}
          >
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude CLI</option>
          </select>
        </label>
        <label>
          Команда запуска
          <textarea
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              setPreview("");
            }}
            rows={3}
            spellCheck={false}
          />
        </label>
        <p className="agent-hint">
          Используется установленный локально CLI и его учётная запись.
          Параметры модели и разрешений сохраняются. Для сложной команды
          используйте исполняемый скрипт.
        </p>
      </fieldset>
      {error && !deleting && <ErrorBox>{error}</ErrorBox>}
      {preview && (
        <pre
          className="agent-command-preview"
          aria-label="Фактическая команда запуска"
        >
          {preview}
        </pre>
      )}
      <div className="agent-profile-actions">
        <button
          type="button"
          className="button primary"
          disabled={busy || !name.trim() || !command.trim()}
          onClick={save}
        >
          {pending === "save" ? "Проверяем…" : "Сохранить и проверить"}
        </button>
        {id && (
          <button
            ref={deleteTrigger}
            type="button"
            className="agent-icon-button agent-profile-delete"
            title="Удалить профиль"
            aria-label="Удалить профиль"
            disabled={busy}
            onClick={() => {
              setError("");
              setDeleting(true);
            }}
          >
            <Trash size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      {id && !savedProfile?.trusted && (
        <div className="agent-profile-trust">
          <p className="agent-hint">
            После проверки подтвердите, что доверяете этой команде запуска.
          </p>
          <button
            type="button"
            className="button"
            disabled={busy || !preview}
            onClick={() =>
              void run("trust", async () => {
                await api(`/api/agent-profiles/${id}/trust`, {
                  method: "POST",
                });
                await onChanged();
              })
            }
          >
            <ShieldCheck size={16} aria-hidden="true" />
            {pending === "trust" ? "Подтверждаем…" : "Доверять этой команде"}
          </button>
        </div>
      )}
      {savedProfile?.trusted && savedProfile.command === command && (
        <p className="agent-profile-trusted">
          <CheckCircle size={16} aria-hidden="true" /> Команда проверена,
          профиль готов к работе
        </p>
      )}
      <Dialog.Root
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) setDeleting(open);
        }}
      >
        <Dialog.Portal container={document.getElementById("agent-panel")}>
          <Dialog.Overlay className="agent-dialog-overlay" />
          <Dialog.Content
            className="agent-dialog agent-profile-delete-dialog"
            onEscapeKeyDown={(event) => {
              event.stopPropagation();
              if (busy) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (busy) event.preventDefault();
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cancelDelete.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (deleteTrigger.current || nameInput.current)?.focus();
            }}
          >
            <Dialog.Title>Удалить профиль?</Dialog.Title>
            <Dialog.Description>
              «{savedProfile?.name || name}» исчезнет из списка агентов.
            </Dialog.Description>
            {error && <ErrorBox>{error}</ErrorBox>}
            <div className="agent-actions">
              <Dialog.Close asChild>
                <button
                  ref={cancelDelete}
                  type="button"
                  className="button"
                  disabled={busy}
                >
                  Отмена
                </button>
              </Dialog.Close>
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() =>
                  void run("delete", async () => {
                    await api(`/api/agent-profiles/${id}`, {
                      method: "DELETE",
                    });
                    await onChanged();
                    choose(profiles.find((p) => p.id !== id)?.id || "");
                    setDeleting(false);
                  })
                }
              >
                {pending === "delete" ? "Удаляем…" : "Удалить"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
