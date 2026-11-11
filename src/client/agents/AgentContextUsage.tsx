/*
 * Context Breakdown presentation adapted from Pasta UI.
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
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CaretUp, X } from "@phosphor-icons/react";
import type { AgentContextSnapshot } from "../../shared/agent-context";
import {
  contextBreakdown,
  type ContextBreakdownRow,
} from "./agent-context-breakdown";
import "./agent-context-usage.css";

const number = new Intl.NumberFormat("ru-RU");
const format = (value: number) => number.format(value);

function ContextBar({ rows }: { rows: ContextBreakdownRow[] }) {
  return (
    <span className="agent-context-bar" aria-hidden="true">
      {rows
        .filter((row) => row.width > 0)
        .map((row) => (
          <span
            key={row.id}
            className={`agent-context-segment agent-context-tone-${row.id}`}
            style={{ width: `${row.width}%` }}
          />
        ))}
    </span>
  );
}

export default function AgentContextUsage({
  usage,
  chatKey,
  updating = false,
}: {
  usage?: AgentContextSnapshot | null;
  chatKey: string;
  updating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number>();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const data = contextBreakdown(usage);
  const { usedTokens, contextWindow, percentage, availableTokens, rows } = data;
  const known = usedTokens !== null;
  const measured = usage?.measuredAt ? new Date(usage.measuredAt) : null;
  const validTime = measured && Number.isFinite(measured.getTime());
  const summary = known
    ? contextWindow !== null
      ? `${format(usedTokens)} / ${format(contextWindow)}`
      : `${format(usedTokens)} токенов`
    : "Нет данных";

  useEffect(() => {
    setOpen(false);
  }, [chatKey]);
  useLayoutEffect(() => {
    if (!open || !container.current) return;
    const anchor = container.current;
    const agentPanel = anchor.closest(".agent-panel");
    const pane = anchor.closest(".agent-main-pane") || agentPanel;
    // Standalone presentations keep the CSS fallback when there is no agent pane.
    if (!pane) return;
    const measure = () => {
      const safeTop = Math.max(0, pane.getBoundingClientRect().top) + 8;
      const available = anchor.getBoundingClientRect().top - safeTop - 8;
      setMaxHeight(Math.min(440, Math.max(0, Math.floor(available))));
    };
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : undefined;
    for (const element of new Set([
      anchor.closest(".agent-composer-zone"),
      pane,
      agentPanel,
    ])) {
      if (element) observer?.observe(element);
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !container.current?.contains(event.target)
      )
        setOpen(false);
    };
    // Capture before the parent agent panel's Escape handler, even from its textarea.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  return (
    <div className="agent-context-usage" ref={container}>
      <button
        type="button"
        className="agent-context-trigger"
        ref={trigger}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`Контекст: ${summary}${percentage !== null ? ` токенов, ${Math.round(percentage)}% использовано` : ""}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-context-summary">
          <span>Контекст{updating && known ? " · последний замер" : ""}</span>
          <span className="agent-context-trigger-total">
            {summary}
            {percentage !== null && <span> · {Math.round(percentage)}%</span>}
          </span>
          <CaretUp
            size={12}
            aria-hidden="true"
            className={open ? "is-open" : undefined}
          />
        </span>
        <ContextBar rows={rows} />
      </button>
      {open && (
        <section
          className="agent-context-panel"
          id={id}
          aria-labelledby={`${id}-title`}
          style={maxHeight === undefined ? undefined : { maxHeight }}
        >
          <div className="agent-context-heading">
            <h3 id={`${id}-title`}>Контекст агента</h3>
            <button
              type="button"
              className="agent-context-close"
              aria-label="Закрыть сведения о контексте"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus({ preventScroll: true });
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="agent-context-total">
            {known ? summary : "Использование недоступно"}
          </p>
          <p className="agent-context-meta">
            {usage && (
              <span>
                {usage.provider === "codex" ? "Codex" : "Claude"}
                {usage.model ? ` · ${usage.model}` : ""}
              </span>
            )}
            {percentage !== null && (
              <span>{Math.round(percentage)}% использовано · токены</span>
            )}
            {contextWindow === null && <span>Размер окна неизвестен</span>}
          </p>
          <ContextBar rows={rows} />
          <ul className="agent-context-rows">
            {rows.map((row) => (
              <li key={row.id} data-context-category={row.id}>
                <span
                  className={`agent-context-dot agent-context-tone-${row.id}`}
                  aria-hidden="true"
                />
                <span className="agent-context-row-label">{row.label}</span>
                <span>
                  {row.tokens === null ? "—" : `≈${format(row.tokens)}`}
                </span>
                <span className="agent-context-row-percentage">
                  {row.tokens !== null && contextWindow !== null
                    ? `≈${Math.round((row.tokens / contextWindow) * 100)}%`
                    : "—"}
                </span>
              </li>
            ))}
            <li
              className="agent-context-available"
              data-context-category="available"
            >
              <span className="agent-context-dot" aria-hidden="true" />
              <span className="agent-context-row-label">Доступно</span>
              <span>
                {availableTokens === null
                  ? "Неизвестно"
                  : format(availableTokens)}
              </span>
              <span className="agent-context-row-percentage">
                {availableTokens !== null && contextWindow !== null
                  ? `${Math.round((availableTokens / contextWindow) * 100)}%`
                  : "—"}
              </span>
            </li>
          </ul>
          {percentage !== null && percentage >= 100 && (
            <p className="agent-context-note">
              {percentage > 100
                ? "Использование превышает размер окна, сообщённый провайдером."
                : "Окно контекста заполнено."}
            </p>
          )}
          <p className="agent-context-note">
            ≈ Оценка по видимому содержимому Miracle. Скрытый контекст CLI и его
            сжатие могут отличаться; остаток включён в «Остальной контекст».
          </p>
          {!known && (
            <p className="agent-context-note">
              Провайдер ещё не передал замер использования контекста.
            </p>
          )}
          {(validTime || updating) && (
            <p className="agent-context-measured">
              {known ? "Последний замер" : "Ожидаем замер"}
              {validTime && (
                <>
                  :{" "}
                  <time
                    dateTime={usage!.measuredAt}
                    title={measured.toLocaleString("ru-RU")}
                  >
                    {measured.toLocaleTimeString("ru-RU", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </>
              )}
              {updating && known && ". Агент работает; ожидаем новый замер."}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
