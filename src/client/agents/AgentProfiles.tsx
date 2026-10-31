import { useState } from "react";
import type { AgentProfile, AgentProvider } from "../../shared/agents";
import { api, json } from "../api";
import { ErrorBox } from "../components/UI";
export default function AgentProfiles({
  profiles,
  onChanged,
}: {
  profiles: AgentProfile[];
  onChanged: () => Promise<void>;
}) {
  const [id, setId] = useState(""),
    [name, setName] = useState(""),
    [provider, setProvider] = useState<AgentProvider>("codex"),
    [command, setCommand] = useState("codex");
  const [preview, setPreview] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const choose = (value: string) => {
    setId(value);
    const p = profiles.find((p) => p.id === value);
    setName(p?.name || "");
    setProvider(p?.provider || "codex");
    setCommand(p?.command || "codex");
    setPreview("");
    setError("");
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
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
      <label>
        Профиль
        <select value={id} onChange={(e) => choose(e.target.value)}>
          <option value="">Новый профиль</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Название
        <input
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
          onChange={(e) => setCommand(e.target.value)}
          rows={3}
          spellCheck={false}
        />
      </label>
      <p className="agent-hint">
        Используется установленный локально CLI и его учётная запись. Параметры
        модели и разрешений сохраняются. Для сложной команды используйте
        исполняемый скрипт.
      </p>
      {error && <ErrorBox>{error}</ErrorBox>}
      {preview && (
        <pre
          className="agent-command-preview"
          aria-label="Фактическая команда запуска"
        >
          {preview}
        </pre>
      )}
      <div className="agent-actions">
        <button
          className="button primary"
          disabled={busy || !name.trim() || !command.trim()}
          onClick={save}
        >
          {busy ? "Проверяем…" : "Сохранить и проверить"}
        </button>
        {id && !profiles.find((p) => p.id === id)?.trusted && (
          <button
            className="button"
            disabled={busy || !preview}
            onClick={() =>
              void run(async () => {
                await api(`/api/agent-profiles/${id}/trust`, {
                  method: "POST",
                });
                await onChanged();
              })
            }
          >
            Доверять этой команде
          </button>
        )}
        {id && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/api/agent-profiles/${id}`, { method: "DELETE" });
                choose("");
                await onChanged();
              })
            }
          >
            Удалить профиль
          </button>
        )}
      </div>
    </div>
  );
}
