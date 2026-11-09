import { useEffect, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { CaretDown, Check, ArrowClockwise } from "@phosphor-icons/react";
import type {
  AgentModelCatalog,
  AgentModelSettings as ModelSettings,
} from "../../shared/agents";
import { api } from "../api";
import { useAgentPortalContainer } from "./useAgentPortalContainer";
import "./agent-model-settings.css";

const effortNames: Record<string, string> = {
  none: "Без рассуждений",
  minimal: "Минимальный",
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  xhigh: "Очень высокий",
  max: "Максимальный",
  ultra: "Ультра",
  adaptive: "Адаптивный",
  auto: "Автоматически",
};

export default function AgentModelSettings({
  profileId,
  trusted,
  settings,
  disabled = false,
  saving = false,
  onChange,
}: {
  profileId: string;
  trusted: boolean;
  settings?: ModelSettings;
  disabled?: boolean;
  saving?: boolean;
  onChange: (settings: ModelSettings) => Promise<void>;
}) {
  const portalContainer = useAgentPortalContainer();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [changing, setChanging] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const unavailable = disabled || !trusted || !profileId;
  const pending = saving || changing;
  useEffect(() => {
    if (unavailable) setOpen(false);
  }, [unavailable]);
  useEffect(() => {
    if (!open || unavailable) return;
    const controller = new AbortController();
    setCatalog(null);
    setLoading(true);
    setCatalogError("");
    setSaveError("");
    void api<AgentModelCatalog>(
      `/api/agent-profiles/${encodeURIComponent(profileId)}/models`,
      { signal: controller.signal },
    )
      .then(
        (value) => {
          if (!controller.signal.aborted) setCatalog(value);
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setCatalogError(
              error instanceof Error && error.message
                ? error.message.slice(0, 600)
                : "Не удалось получить список моделей.",
            );
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, profileId, unavailable, attempt]);
  const model = catalog?.models.find(
    (item) => item.id === (settings?.model || catalog.defaultModel),
  );
  const chosenName = settings?.model
    ? catalog?.models.find((item) => item.id === settings.model)?.name ||
      settings.model
    : "Модель";
  const effortName = settings?.reasoningEffort
    ? effortNames[settings.reasoningEffort] || settings.reasoningEffort
    : undefined;
  const change = async (value: ModelSettings) => {
    if (pending || unavailable) return;
    setChanging(true);
    setSaveError("");
    try {
      await onChange(value);
    } catch (error) {
      setSaveError(
        (error as Error).message || "Не удалось сохранить настройки.",
      );
    } finally {
      setChanging(false);
    }
  };
  return (
    <Menu.Root modal={false} open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>
        <button
          type="button"
          className="agent-profile-button agent-composer-control agent-model-button"
          aria-label="Модель и рассуждение"
          title={`${settings?.model ? chosenName : "Модель из профиля"}${effortName ? ` · ${effortName}` : ""}`}
          disabled={unavailable || saving}
        >
          <span>{chosenName}</span>
          <CaretDown size={12} aria-hidden="true" />
        </button>
      </Menu.Trigger>
      <Menu.Portal container={portalContainer}>
        <Menu.Content
          className="agent-menu agent-model-menu"
          side="top"
          align="end"
          sideOffset={12}
          collisionPadding={12}
        >
          <Menu.Label className="agent-menu-label">Модель</Menu.Label>
          <Menu.RadioGroup
            aria-label="Модель"
            value={settings?.model || ""}
            onValueChange={(value) =>
              void change(value ? { model: value } : {})
            }
          >
            <Menu.RadioItem
              value=""
              disabled={pending || unavailable}
              onSelect={(event) => event.preventDefault()}
            >
              <span>Из профиля</span>
              <Menu.ItemIndicator>
                <Check size={16} />
              </Menu.ItemIndicator>
            </Menu.RadioItem>
            {catalog?.models.map((item) => (
              <Menu.RadioItem
                key={item.id}
                value={item.id}
                disabled={pending || unavailable}
                onSelect={(event) => event.preventDefault()}
              >
                <span className="agent-model-name">{item.name}</span>
                <Menu.ItemIndicator>
                  <Check size={16} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          {loading && (
            <p className="agent-menu-hint" role="status">
              Загружаем модели…
            </p>
          )}
          {catalogError && (
            <>
              <p className="agent-menu-hint" role="alert">
                Не удалось загрузить модели. {catalogError}
              </p>
              <Menu.Item
                onSelect={(event) => {
                  event.preventDefault();
                  setAttempt((value) => value + 1);
                }}
              >
                <ArrowClockwise size={16} />
                Повторить
              </Menu.Item>
            </>
          )}
          {catalog && !catalog.models.length && (
            <p className="agent-menu-hint">
              Агент не сообщил список моделей. Доступны настройки профиля.
            </p>
          )}
          {catalog &&
            settings?.model &&
            !catalog.models.some((item) => item.id === settings.model) && (
              <p className="agent-menu-hint">
                Сохранённая модель отсутствует в текущем списке:{" "}
                {settings.model}.
              </p>
            )}
          {model && model.reasoningEfforts.length > 0 && (
            <>
              <Menu.Separator />
              <Menu.Label className="agent-menu-label">
                Уровень рассуждений
              </Menu.Label>
              <Menu.RadioGroup
                aria-label="Уровень рассуждений"
                value={settings?.reasoningEffort || ""}
                onValueChange={(value) =>
                  void change({
                    ...(settings?.model ? { model: settings.model } : {}),
                    ...(value ? { reasoningEffort: value } : {}),
                  })
                }
              >
                <Menu.RadioItem
                  value=""
                  disabled={pending || unavailable}
                  onSelect={(event) => event.preventDefault()}
                >
                  <span>Автоматически</span>
                  <Menu.ItemIndicator>
                    <Check size={16} />
                  </Menu.ItemIndicator>
                </Menu.RadioItem>
                {model.reasoningEfforts.map((effort) => (
                  <Menu.RadioItem
                    key={effort.id}
                    value={effort.id}
                    disabled={pending || unavailable}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span>
                      {effortNames[effort.id] || effort.name || effort.id}
                    </span>
                    <Menu.ItemIndicator>
                      <Check size={16} />
                    </Menu.ItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </>
          )}
          {pending && (
            <p className="agent-menu-hint" role="status">
              Сохраняем настройки…
            </p>
          )}
          {saveError && (
            <p className="agent-menu-hint" role="alert">
              {saveError}
            </p>
          )}
          <Menu.Separator />
          <p className="agent-menu-hint agent-model-scope">
            Только для этого чата. Применяется к следующему сообщению.
          </p>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
