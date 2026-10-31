import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import {
  CaretRight,
  Check,
  CircleNotch,
  Pause,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { AgentMessage, AgentTurn } from "../../shared/agents";
import { activityCount, activityItems } from "./agent-transcript";

const itemStateLabel = {
  running: "Выполняется",
  completed: "Завершено",
  failed: "Ошибка",
  cancelled: "Остановлено",
};

export default function AgentActivity({
  messages,
  turn,
}: {
  messages: AgentMessage[];
  turn?: AgentTurn;
}) {
  const [open, setOpen] = useState(false);
  const items = activityItems(messages, turn);
  const running = turn?.status === "running",
    waiting = turn?.status === "waiting";
  const hasFailedAction = items.some((item) => item.state === "failed");
  const failed = turn?.status === "failed" || (!turn && hasFailedAction);
  const cancelled =
    turn?.status === "cancelled" || turn?.status === "interrupted";
  const label = waiting
    ? "Нужно разрешение"
    : failed
      ? "Ошибка"
      : cancelled
        ? "Остановлено"
        : running
          ? items.length
            ? "Работает"
            : "Думает"
          : hasFailedAction
            ? "Готово с замечаниями"
            : "Готово";
  const status = waiting
    ? "waiting"
    : failed
      ? "failed"
      : cancelled
        ? "cancelled"
        : running
          ? "running"
          : "completed";
  const Icon = failed
    ? WarningCircle
    : cancelled || waiting
      ? Pause
      : running
        ? CircleNotch
        : Check;
  return (
    <div className="agent-activity-summary">
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button
            className="agent-activity-trigger"
            type="button"
            disabled={!items.length}
            aria-label={
              items.length
                ? `Действия агента: ${activityCount(items.length)}`
                : label
            }
          >
            <Icon
              className="agent-activity-icon"
              data-state={status}
              size={14}
            />
            <span className="agent-activity-label">{label}</span>
            {items.length > 0 && (
              <>
                <span className="agent-activity-count">
                  {activityCount(items.length)}
                </span>
                <CaretRight size={12} />
              </>
            )}
          </button>
        </Dialog.Trigger>
        <Dialog.Portal
          container={
            typeof document !== "undefined"
              ? document.getElementById("agent-panel")
              : undefined
          }
        >
          <Dialog.Overlay className="agent-activity-overlay" />
          <Dialog.Content
            className="agent-activity-dialog"
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <div className="agent-activity-header">
              <div>
                <Dialog.Title>Действия агента</Dialog.Title>
                <Dialog.Description className="agent-activity-description">
                  {label} · {activityCount(items.length)}
                </Dialog.Description>
              </div>
              <Dialog.Close
                className="icon-button"
                aria-label="Закрыть действия"
              >
                <X size={18} />
              </Dialog.Close>
            </div>
            <div className="agent-activity-list">
              {open &&
                items.map((item) => (
                  <details className="agent-activity-item" key={item.id}>
                    <summary className="agent-activity-item-heading">
                      <span>{item.label}</span>
                      <small data-state={item.state}>
                        {itemStateLabel[item.state]}
                      </small>
                      <CaretRight size={12} />
                    </summary>
                    <pre className="agent-activity-raw">
                      {JSON.stringify(
                        item.events.map(({ content, details, createdAt }) => ({
                          content,
                          details,
                          createdAt,
                        })),
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
