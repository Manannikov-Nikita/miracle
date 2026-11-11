/*
 * Agent Activity presentation adapted from Pasta UI.
 * Source: https://github.com/syeddhasnainn/pastaui/blob/1f6de38bf4dc82cf17bb662361b3c03bebbfc4d4/src/components/ai/agent-activity.tsx
 * Copyright (c) 2026 Pasta UI
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { useEffect, useId, useState } from "react";
import {
  CaretRight,
  Check,
  CircleNotch,
  FileText,
  Globe,
  ListChecks,
  MagnifyingGlass,
  NotePencil,
  Pause,
  Robot,
  TerminalWindow,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import type { AgentMessage, AgentTurn } from "../../shared/agents";
import {
  activityCount,
  activityItems,
  type AgentActivityItem,
} from "./agent-transcript";
import { waitingForAnswer } from "./AgentQuestion";
import "./agent-activity-timeline.css";

const itemStateLabel = {
  running: "Выполняется",
  completed: "Завершено",
  failed: "Ошибка",
  cancelled: "Остановлено",
  unknown: "Результат неизвестен",
};
const categoryIcons = {
  read: FileText,
  search: MagnifyingGlass,
  edit: NotePencil,
  command: TerminalWindow,
  web: Globe,
  tool: Wrench,
  plan: ListChecks,
  subagent: Robot,
};

function sourceUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function duration(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return;
  return value < 1000
    ? "<1 с"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(
        value / 1000,
      ) + " с";
}
function ActivityStep({ item }: { item: AgentActivityItem }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const Icon = categoryIcons[item.kind] || Wrench;
  const elapsed = duration(item.durationMs);
  return (
    <li className="agent-activity-step" data-state={item.state}>
      <span className="agent-activity-step-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="agent-activity-step-content">
        <div className="agent-activity-step-heading">
          <button
            type="button"
            className="agent-activity-details-trigger"
            aria-expanded={expanded}
            aria-controls={id}
            aria-label={"Подробности: " + item.label}
            onClick={() => setExpanded((value) => !value)}
          >
            <span>{item.label}</span>
            <CaretRight size={12} aria-hidden="true" />
          </button>
          {elapsed && (
            <span className="agent-activity-step-duration">{elapsed}</span>
          )}
        </div>
        {item.description && (
          <p className="agent-activity-step-description">{item.description}</p>
        )}
        <small className="agent-activity-step-state">
          {itemStateLabel[item.state]}
        </small>
        {item.resources?.length > 0 && (
          <ul className="agent-activity-sources" aria-label="Связанные объекты">
            {item.resources.map((source) => {
              const href = sourceUrl(source.href);
              return (
                <li key={source.id}>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      <Globe size={12} aria-hidden="true" />
                      {source.label}
                    </a>
                  ) : (
                    <span>{source.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {expanded && (
          <pre className="agent-activity-raw agent-activity-step-raw" id={id}>
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
        )}
      </div>
    </li>
  );
}
export default function AgentActivity({
  messages,
  turn,
}: {
  messages: AgentMessage[];
  turn?: AgentTurn;
}) {
  const items = activityItems(messages, turn);
  const running = turn?.status === "running",
    waiting = turn?.status === "waiting";
  const active = running || waiting;
  const key = turn
    ? turn.chatId + ":" + turn.id
    : messages[0]?.turnId || "history";
  const [disclosure, setDisclosure] = useState({ key, active, open: active });
  const open =
    disclosure.key === key && disclosure.active === active
      ? disclosure.open
      : active;
  const id = useId();
  useEffect(() => {
    setDisclosure((current) =>
      current.key === key && current.active === active
        ? current
        : { key, active, open: active },
    );
  }, [key, active]);
  const hasFailedAction = items.some((item) => item.state === "failed");
  const failed = turn?.status === "failed" || (!turn && hasFailedAction);
  const cancelled =
    turn?.status === "cancelled" || turn?.status === "interrupted";
  const label = waiting
    ? waitingForAnswer(messages, turn)
      ? "Нужен ответ"
      : "Нужно разрешение"
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
  const expanded = open && items.length > 0;
  const currentStatus =
    active && !items.some((item) => item.state === "running");
  return (
    <div className="agent-activity-summary agent-activity-timeline-summary">
      <button
        className="agent-activity-trigger"
        type="button"
        disabled={!items.length}
        aria-expanded={expanded}
        aria-controls={id}
        aria-label={
          items.length
            ? "Действия агента: " + activityCount(items.length)
            : label
        }
        onClick={() => setDisclosure({ key, active, open: !open })}
      >
        <Icon
          className="agent-activity-icon"
          data-state={status}
          size={14}
          aria-hidden="true"
        />
        <span className="agent-activity-label">{label}</span>
        {items.length > 0 && (
          <>
            <span className="agent-activity-count">
              {activityCount(items.length)}
            </span>
            <CaretRight
              className="agent-activity-disclosure-caret"
              size={12}
              aria-hidden="true"
            />
          </>
        )}
      </button>
      {expanded && (
        <ol
          className="agent-activity-timeline"
          id={id}
          aria-label="Действия агента"
        >
          {items.map((item) => (
            <ActivityStep key={item.id} item={item} />
          ))}
          {currentStatus && (
            <li className="agent-activity-current" data-state={status}>
              <Icon
                className="agent-activity-current-icon"
                size={16}
                aria-hidden="true"
              />
              <span>{waiting ? label : "Агент работает"}</span>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
