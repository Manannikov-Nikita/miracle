import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  CircleNotch,
  ClockCounterClockwise,
  Database,
  Pause,
  Sparkle,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { AgentSubagent } from "../../shared/agent-interactions";
import type { AgentSqlRunActivity } from "../../shared/agent-sql-activity";
import type { AgentChatState } from "./useAgentChat";
import { activeSubagentStatuses, agentSubagents } from "./agent-subagents";
import { useAgentSqlActivity } from "./useAgentSqlActivity";
import "./agent-activity-rail.css";
import AgentSqlPreview from "./AgentSqlPreview";

const runLabels: Record<AgentSqlRunActivity["status"], string> = {
  running: "Выполняется",
  cancelling: "Отменяется",
  paused: "На паузе",
  completed: "Завершён",
  failed: "Ошибка",
  cancelled: "Отменён",
  interrupted: "Прерван",
};
const childLabels: Record<AgentSubagent["status"], string> = {
  pending: "Запускается",
  running: "Работает",
  waiting: "Ожидает",
  completed: "Завершён",
  failed: "Ошибка",
  cancelled: "Отменён",
  closed: "Закрыт",
  unknown: "Статус неизвестен",
};

function RunRing({ run }: { run: AgentSqlRunActivity }) {
  const batch = run.dateBatch;
  const paused = run.status === "paused";
  const active = run.status === "running" || run.status === "cancelling";
  const progress =
    batch && batch.total > 0
      ? Math.min(1, Math.max(0, batch.completed / batch.total))
      : 0;
  const label = batch
    ? `${batch.completed} из ${batch.total} дат · ${runLabels[run.status]}`
    : runLabels[run.status];
  return (
    <span
      className={`agent-run-ring${!batch && active ? " is-indeterminate" : ""}${paused ? " is-paused" : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={batch ? 0 : undefined}
      aria-valuemax={batch?.total}
      aria-valuenow={batch?.completed}
      aria-valuetext={label}
    >
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle className="agent-ring-track" cx="20" cy="20" r="16" />
        <circle
          className="agent-ring-value"
          cx="20"
          cy="20"
          r="16"
          pathLength="100"
          strokeDasharray={`${batch ? progress * 100 : active ? 25 : run.status === "completed" ? 100 : 0} 100`}
        />
      </svg>
      <span aria-hidden="true">
        {paused ? (
          <Pause size={14} weight="fill" />
        ) : batch ? (
          batch.total > 99 ? (
            `${Math.round(progress * 100)}%`
          ) : (
            `${batch.completed}/${batch.total}`
          )
        ) : active ? (
          <span className="agent-ring-dot" />
        ) : run.status === "failed" || run.status === "interrupted" ? (
          <WarningCircle size={14} />
        ) : run.status === "cancelled" ? (
          <X size={14} />
        ) : (
          <Check size={14} />
        )}
      </span>
    </span>
  );
}

function SqlDetails({
  runs,
  onOpenRun,
  onOpened,
}: {
  runs: AgentSqlRunActivity[];
  onOpenRun?: (id: string) => Promise<void>;
  onOpened: () => void;
}) {
  if (!runs.length)
    return (
      <p className="agent-rail-empty">Агент ещё не запускал SQL в этом чате.</p>
    );
  return (
    <div className="agent-rail-items">
      {runs.map((run) => (
        <article className="agent-rail-item" key={run.id}>
          <div className="agent-rail-item-heading">
            <RunRing run={run} />
            <div>
              <strong>
                {run.dateBatch ? "Запуск по датам" : "SQL-запрос"}
              </strong>
              <span>{runLabels[run.status]}</span>
            </div>
          </div>
          {run.dateBatch && (
            <div className="agent-rail-run-progress">
              <p>
                {run.dateBatch.completed} из {run.dateBatch.total} дат · Успешно{" "}
                {run.dateBatch.succeeded} · Ошибок {run.dateBatch.failed}
              </p>
              {run.dateBatch.currentDate && (
                <p>Текущая дата: {run.dateBatch.currentDate}</p>
              )}
              {run.dateBatch.attempt > 0 && (
                <p>
                  Попытка {run.dateBatch.attempt} из {run.dateBatch.maxAttempts}
                </p>
              )}
            </div>
          )}
          <AgentSqlPreview
            sql={run.sql}
            onOpen={onOpenRun ? () => onOpenRun(run.id) : undefined}
            onOpened={onOpened}
          />
          {run.error && <p className="agent-rail-error">{run.error}</p>}
        </article>
      ))}
    </div>
  );
}

function SubagentDetails({
  children,
  live,
}: {
  children: ReturnType<typeof agentSubagents>;
  live: boolean;
}) {
  if (!children.length)
    return (
      <p className="agent-rail-empty">
        В этой задаче нет сведений о саб-агентах.
      </p>
    );
  return (
    <>
      <p className="agent-rail-hint">
        {live
          ? "Статусы исполнителей."
          : "Последние известные статусы исполнителей."}
      </p>
      <div className="agent-rail-items">
        {children.map((child) => (
          <article className="agent-rail-item" key={child.id}>
            <div className="agent-rail-child-heading">
              <strong className="agent-rail-child-name">
                {child.color && (
                  <Sparkle
                    size={14}
                    weight="fill"
                    color={child.color}
                    aria-hidden="true"
                  />
                )}
                {child.name || child.id}
              </strong>
              <span>{childLabels[child.status]}</span>
            </div>
            {child.name && (
              <small className="agent-rail-child-id">{child.id}</small>
            )}
            {child.task && <p>{child.task}</p>}
            {child.message && child.message !== child.task && (
              <p className="agent-rail-hint">{child.message}</p>
            )}
          </article>
        ))}
      </div>
    </>
  );
}

export default function AgentActivityRail({
  state,
  onOpenRun,
}: {
  state: AgentChatState;
  onOpenRun?: (id: string) => Promise<void>;
}) {
  const active = state.active?.chatId === state.selected ? state.active : null;
  const conversation =
    state.conversation?.chat.id === state.selected ? state.conversation : null;
  const turnId = active?.id || conversation?.turns.at(-1)?.id || null;
  const sql = useAgentSqlActivity({
    chatId: state.selected,
    open: state.open,
    turnId: active?.id || null,
    turnActive: Boolean(active),
  });
  const children = agentSubagents(conversation?.messages || [], turnId);
  const lastActiveChildCount = children.filter((child) =>
    activeSubagentStatuses.has(child.status),
  ).length;
  const childrenLoading = Boolean(state.selected && !conversation);
  const childrenStale = !active && lastActiveChildCount > 0;
  const childCount =
    childrenLoading || childrenStale ? null : lastActiveChildCount;
  const childLabel = childrenLoading
    ? state.error
      ? "Саб-агенты: данные недоступны"
      : "Саб-агенты: данные загружаются"
    : childrenStale
      ? `Саб-агенты: текущий статус неизвестен, ${children.length} в последней задаче`
      : `Саб-агенты: ${childCount} активных, ${children.length} всего`;
  const runs = sql.data?.runs || [];
  const activeRuns = runs.filter((run) =>
    ["running", "cancelling"].includes(run.status),
  );
  const paused = runs.filter((run) => run.status === "paused").length;
  const count = sql.data?.activeCount ?? (state.selected ? null : 0);
  const [expanded, setExpanded] = useState<"sql" | "agents" | null>(null);
  const detailsId = useId();
  const rail = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => setExpanded(null), [state.selected]);
  useEffect(() => {
    if (!expanded) return;
    closeButton.current?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!rail.current?.contains(event.target as Node)) setExpanded(null);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [expanded]);
  const show = (section: "sql" | "agents", button: HTMLButtonElement) => {
    trigger.current = button;
    setExpanded((current) => (current === section ? null : section));
  };
  const close = () => {
    setExpanded(null);
    trigger.current?.focus();
  };
  const sqlLabel =
    count === null
      ? "SQL: данные недоступны"
      : `SQL: ${count} активных, ${paused} на паузе`;
  const health = sql.error
    ? "Нет связи"
    : childrenLoading && state.error
      ? "Нет данных"
      : (state.selected && !sql.data) || childrenLoading
        ? "Загрузка…"
        : childrenStale
          ? "Последние статусы"
          : "";
  return (
    <div
      className="agent-activity-rail"
      ref={rail}
      aria-label="Активность чата"
    >
      <div className="agent-rail-content">
        <div className="agent-rail-summary">
          <button
            type="button"
            className="agent-rail-counter agent-rail-agents"
            aria-label={childLabel}
            title={childLabel}
            aria-expanded={expanded === "agents"}
            aria-controls={detailsId}
            onClick={(event) => show("agents", event.currentTarget)}
          >
            <UsersThree size={20} aria-hidden="true" />
            {childCount !== 0 && (
              <span className="agent-rail-badge" aria-hidden="true">
                {childCount ?? "—"}
              </span>
            )}
          </button>
          <button
            type="button"
            className="agent-rail-counter"
            aria-label={sqlLabel}
            title={sqlLabel}
            aria-expanded={expanded === "sql"}
            aria-controls={detailsId}
            onClick={(event) => show("sql", event.currentTarget)}
          >
            <Database size={20} aria-hidden="true" />
            {count !== 0 && (
              <span className="agent-rail-badge" aria-hidden="true">
                {count ?? "—"}
              </span>
            )}
          </button>
        </div>
        <div className="agent-rail-rings">
          {activeRuns.map((run, index) => (
            <button
              type="button"
              className="agent-rail-run"
              key={run.id}
              aria-label={`SQL ${index + 1}: ${runLabels[run.status]}${run.dateBatch ? `, ${run.dateBatch.completed} из ${run.dateBatch.total} дат` : ""}`}
              title={`${runLabels[run.status]} · ${run.sql}`}
              aria-controls={detailsId}
              aria-expanded={expanded === "sql"}
              onClick={(event) => show("sql", event.currentTarget)}
            >
              <RunRing run={run} />
            </button>
          ))}
        </div>
        {health && (
          <span
            className="agent-rail-health"
            role="status"
            aria-label={health}
            title={health}
          >
            {sql.error || (childrenLoading && state.error) ? (
              <WarningCircle size={16} aria-hidden="true" />
            ) : childrenStale ? (
              <ClockCounterClockwise size={16} aria-hidden="true" />
            ) : (
              <CircleNotch
                size={16}
                className="agent-rail-loading"
                aria-hidden="true"
              />
            )}
          </span>
        )}
      </div>
      {expanded && (
        <section
          className="agent-rail-details"
          id={detailsId}
          role="dialog"
          aria-label={
            expanded === "sql" ? "SQL в этом чате" : "Саб-агенты задачи"
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="agent-rail-details-heading">
            <strong>
              {expanded === "sql" ? "SQL в этом чате" : "Саб-агенты задачи"}
            </strong>
            <button
              type="button"
              className="agent-icon-button"
              ref={closeButton}
              aria-label="Закрыть подробности активности"
              onClick={close}
            >
              <X size={18} />
            </button>
          </div>
          <div className="agent-rail-details-body">
            {expanded === "sql" ? (
              <>
                {sql.error && (
                  <div className="agent-rail-error" role="status">
                    <p>
                      {sql.stale
                        ? "Последние известные данные. "
                        : "Данные недоступны. "}
                      {sql.error}
                    </p>
                    <button
                      type="button"
                      className="text-button"
                      disabled={sql.loading}
                      onClick={() => void sql.refresh()}
                    >
                      Повторить
                    </button>
                  </div>
                )}
                {sql.data ? (
                  <SqlDetails
                    runs={runs}
                    onOpenRun={onOpenRun}
                    onOpened={() => setExpanded(null)}
                  />
                ) : !state.selected ? (
                  <p className="agent-rail-empty">
                    Выберите чат, чтобы увидеть запуски SQL.
                  </p>
                ) : (
                  !sql.error && (
                    <p className="agent-rail-empty">
                      Загружаем активность SQL…
                    </p>
                  )
                )}
              </>
            ) : childrenLoading ? (
              <p className="agent-rail-empty">
                {state.error
                  ? "Сведения о саб-агентах недоступны."
                  : "Загружаем сведения о саб-агентах…"}
              </p>
            ) : (
              <SubagentDetails children={children} live={Boolean(active)} />
            )}
          </div>
        </section>
      )}
    </div>
  );
}
