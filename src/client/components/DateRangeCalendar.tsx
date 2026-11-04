import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import type { DateGranularity } from "../../shared/date-batch";
import { IconButton } from "./UI";
import {
  addCalendarDays,
  calendarMonthDate,
  calendarMonthIndex,
  calendarToday,
  isCalendarDate,
  normalizeDateForCalendar,
  type CalendarWeekStart,
} from "./date-range-calendar-helpers";
import "./date-range-calendar.css";

const monthNames = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];
const weekdays = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export interface DateRangeCalendarProps {
  startDate: string;
  endDate: string;
  granularity: DateGranularity;
  weekStartsOn?: CalendarWeekStart;
  disabled?: boolean;
  onChange: (range: { startDate: string; endDate: string }) => void;
}

export default function DateRangeCalendar({
  startDate,
  endDate,
  granularity,
  weekStartsOn = "monday",
  disabled = false,
  onChange,
}: DateRangeCalendarProps) {
  const today = calendarToday();
  const monthMode = granularity === "month";
  const minPanel = monthMode ? 1 : 12;
  const maxPanel = monthMode ? 9999 : 9999 * 12 + 11;
  const indexFor = (date: string) =>
    monthMode ? Number(date.slice(0, 4)) : calendarMonthIndex(date);
  const defaultPanel = monthMode
    ? Number(today.slice(0, 4))
    : calendarMonthIndex(today) - 2;
  const initialPanel =
    isCalendarDate(startDate) &&
    (monthMode
      ? startDate.slice(0, 4) !== today.slice(0, 4)
      : calendarMonthIndex(startDate) < defaultPanel ||
        calendarMonthIndex(startDate) > defaultPanel + 2)
      ? indexFor(startDate)
      : defaultPanel;
  const [monthCount, setMonthCount] = useState(3);
  const panelCount = monthMode ? 1 : monthCount;
  const clampWindow = (value: number) =>
    Math.max(minPanel, Math.min(maxPanel - panelCount + 1, value));
  const [firstPanel, setFirstPanel] = useState(() => clampWindow(initialPanel));
  // Day and month views use different index units; keep the transition render valid
  // until the layout effect reveals the selected date in the new view.
  const windowStart = clampWindow(firstPanel);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focusedDate, setFocusedDate] = useState(() =>
    isCalendarDate(startDate) ? startDate : today,
  );
  const viewport = useRef<HTMLDivElement>(null);
  const focusDate = useRef<string | null>(null);
  const emitted = useRef<{ startDate: string; endDate: string } | null>(null);
  const previous = useRef({ startDate, endDate, granularity, weekStartsOn });
  const initialMount = useRef(true);

  function reveal(date: string, focus = false) {
    if (!isCalendarDate(date)) return;
    const panel = indexFor(date);
    const next =
      focus && panel >= windowStart
        ? Math.max(windowStart, panel - panelCount + 1)
        : panel;
    if (focus) focusDate.current = date;
    setFirstPanel(clampWindow(next));
    if (focus) {
      const button = viewport.current?.querySelector<HTMLButtonElement>(
        `[data-calendar-date="${date}"]`,
      );
      if (button) {
        button.focus({ preventScroll: true });
        focusDate.current = null;
      }
    }
  }

  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { startDate, endDate, granularity, weekStartsOn };
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    const ownChange =
      emitted.current?.startDate === startDate &&
      emitted.current?.endDate === endDate;
    emitted.current = null;
    if (old.granularity !== granularity || old.weekStartsOn !== weekStartsOn) {
      setAnchor(null);
      setHovered(null);
      reveal(isCalendarDate(startDate) ? startDate : today);
    } else if (
      !ownChange &&
      (startDate !== old.startDate || endDate !== old.endDate)
    ) {
      setAnchor(null);
      setHovered(null);
      const changed = startDate !== old.startDate ? startDate : endDate;
      if (isCalendarDate(changed)) reveal(changed);
    }
  }, [startDate, endDate, granularity, weekStartsOn]);

  useLayoutEffect(() => {
    const host = viewport.current;
    if (!host || !focusDate.current) return;
    const button = host.querySelector<HTMLButtonElement>(
      `[data-calendar-date="${focusDate.current}"]`,
    );
    if (button) {
      button.focus({ preventScroll: true });
      focusDate.current = null;
    }
  }, [windowStart, monthMode, panelCount]);

  useLayoutEffect(() => {
    const host = viewport.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const resize = () => {
      const width = host.clientWidth;
      if (width <= 0) return;
      setMonthCount(width <= 480 ? 1 : width <= 740 ? 2 : 3);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  function move(direction: number) {
    setFirstPanel(clampWindow(windowStart + direction));
    setHovered(null);
  }

  function pick(date: string) {
    if (disabled) return;
    const value = normalizeDateForCalendar(date, granularity, weekStartsOn);
    if (!value) return;
    const next = anchor
      ? {
          startDate: value < anchor ? value : anchor,
          endDate: value > anchor ? value : anchor,
        }
      : { startDate: value, endDate: value };
    setAnchor(anchor ? null : value);
    setHovered(null);
    emitted.current = next;
    onChange(next);
  }

  const normalizedStart = normalizeDateForCalendar(
    startDate,
    granularity,
    weekStartsOn,
  );
  const normalizedEnd = normalizeDateForCalendar(
    endDate,
    granularity,
    weekStartsOn,
  );
  const candidate =
    anchor && hovered
      ? normalizeDateForCalendar(hovered, granularity, weekStartsOn)
      : null;
  const selectedStart =
    candidate && anchor
      ? candidate < anchor
        ? candidate
        : anchor
      : normalizedStart;
  const selectedEnd =
    candidate && anchor
      ? candidate > anchor
        ? candidate
        : anchor
      : normalizedEnd;
  const fullEnd =
    granularity === "week" && selectedEnd
      ? addCalendarDays(selectedEnd, 6) || "9999-12-31"
      : selectedEnd;
  const validRange = Boolean(
    selectedStart && fullEnd && selectedStart <= fullEnd,
  );
  const orderedWeekdays = Array.from(
    { length: 7 },
    (_, index) => (index + (weekStartsOn === "monday" ? 1 : 0)) % 7,
  );
  const isRendered = (date: string) =>
    isCalendarDate(date) &&
    indexFor(date) >= windowStart &&
    indexFor(date) < windowStart + panelCount;
  const focusCandidate = monthMode
    ? `${focusedDate.slice(0, 7)}-01`
    : focusedDate;
  const tabStop =
    [
      focusCandidate,
      normalizedStart,
      monthMode ? `${today.slice(0, 7)}-01` : today,
    ].find(isRendered) ||
    (monthMode
      ? `${String(windowStart).padStart(4, "0")}-01-01`
      : calendarMonthDate(windowStart));

  function keyboard(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    let next = "";
    const changes: Record<string, number> = monthMode
      ? {
          ArrowLeft: -1,
          ArrowRight: 1,
          ArrowUp: -3,
          ArrowDown: 3,
          PageUp: -12,
          PageDown: 12,
        }
      : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (event.key in changes)
      next = monthMode
        ? calendarMonthDate(calendarMonthIndex(date) + changes[event.key])
        : addCalendarDays(date, changes[event.key]);
    else if (event.key === "Home")
      next = monthMode
        ? `${date.slice(0, 4)}-01-01`
        : normalizeDateForCalendar(date, "week", weekStartsOn);
    else if (event.key === "End")
      next = monthMode
        ? `${date.slice(0, 4)}-12-01`
        : addCalendarDays(
            normalizeDateForCalendar(date, "week", weekStartsOn),
            6,
          );
    else if (
      !monthMode &&
      (event.key === "PageUp" || event.key === "PageDown")
    ) {
      const month = calendarMonthDate(
        calendarMonthIndex(date) + (event.key === "PageUp" ? -1 : 1),
      );
      if (month)
        next = addCalendarDays(
          month,
          Math.min(Number(date.slice(8)), daysInMonth(month)) - 1,
        );
    } else return;
    event.preventDefault();
    if (next) {
      const target = viewport.current?.querySelector<HTMLButtonElement>(
        `[data-calendar-date="${next}"]`,
      );
      if (target) {
        target.focus({ preventScroll: true });
      } else reveal(next, true);
    }
  }

  function dayButton(date: string, text: string | number) {
    const selected = validRange && date >= selectedStart && date <= fullEnd;
    const unit = normalizeDateForCalendar(date, granularity, weekStartsOn);
    const start = selected && date === selectedStart;
    const end = selected && date === fullEnd;
    const endpoint =
      selected && (unit === selectedStart || unit === selectedEnd);
    return (
      <button
        key={date}
        type="button"
        aria-label={date}
        aria-pressed={selected}
        aria-current={date === today ? "date" : undefined}
        disabled={disabled || !unit}
        tabIndex={date === tabStop ? 0 : -1}
        data-calendar-date={date}
        className={`range-calendar-day${selected ? " is-selected" : ""}${start ? " is-range-start" : ""}${end ? " is-range-end" : ""}${endpoint ? " is-endpoint" : ""}${date === today ? " is-today" : ""}`}
        onClick={() => pick(date)}
        onKeyDown={(event) => keyboard(event, date)}
        onMouseEnter={() => {
          if (anchor) setHovered(date);
        }}
        onFocus={() => {
          setFocusedDate(date);
          if (anchor) setHovered(date);
        }}
      >
        {text}
      </button>
    );
  }

  function daysInMonth(date: string) {
    const first = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
    first.setUTCMonth(first.getUTCMonth() + 1);
    first.setUTCDate(0);
    return first.getUTCDate();
  }

  return (
    <div
      className={`range-calendar${monthMode ? " range-calendar-months" : ""}`}
    >
      <div className="range-calendar-toolbar">
        <IconButton
          label={monthMode ? "Предыдущий год" : "Предыдущий месяц"}
          onClick={() => move(-1)}
          disabled={disabled || windowStart === minPanel}
        >
          <CaretLeft size={16} />
        </IconButton>
        <span aria-live="polite">
          {anchor
            ? "Выберите конец диапазона"
            : monthMode
              ? "Выберите первый и последний месяц"
              : granularity === "week"
                ? "Выберите первую и последнюю неделю"
                : "Выберите начало и конец"}
        </span>
        <IconButton
          label={monthMode ? "Следующий год" : "Следующий месяц"}
          onClick={() => move(1)}
          disabled={disabled || windowStart + panelCount - 1 === maxPanel}
        >
          <CaretRight size={16} />
        </IconButton>
      </div>
      <div
        className="range-calendar-viewport"
        ref={viewport}
        onMouseLeave={() => setHovered(null)}
        role="group"
        aria-label={monthMode ? "Календарь месяцев" : "Календарь диапазона"}
      >
        {Array.from(
          { length: panelCount },
          (_, index) => windowStart + index,
        ).map((panel) => {
          if (monthMode)
            return (
              <section
                className="range-calendar-panel range-calendar-year"
                key={`year-${panel}`}
                data-calendar-panel={panel}
                aria-label={String(panel)}
              >
                <h3>{panel}</h3>
                <div className="range-calendar-month-grid">
                  {monthNames.map((name, month) =>
                    dayButton(
                      `${String(panel).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`,
                      name,
                    ),
                  )}
                </div>
              </section>
            );
          const firstDate = calendarMonthDate(panel);
          const date = new Date(`${firstDate}T00:00:00Z`);
          const before =
            (date.getUTCDay() - (weekStartsOn === "monday" ? 1 : 0) + 7) % 7;
          const count = daysInMonth(firstDate);
          return (
            <section
              className="range-calendar-panel"
              key={`month-${panel}`}
              data-calendar-panel={panel}
              aria-label={`${monthNames[panel % 12]} ${Math.floor(panel / 12)}`}
            >
              <h3>
                {monthNames[panel % 12]} <span>{Math.floor(panel / 12)}</span>
              </h3>
              <div className="range-calendar-weekdays" aria-hidden="true">
                {orderedWeekdays.map((weekday) => (
                  <span
                    key={weekday}
                    className={
                      weekday === 0 || weekday === 6 ? "is-weekend" : ""
                    }
                  >
                    {weekdays[weekday]}
                  </span>
                ))}
              </div>
              <div className="range-calendar-day-grid">
                {Array.from({ length: 42 }, (_, cell) => {
                  const day = cell - before + 1;
                  return day < 1 || day > count ? (
                    <span
                      key={`blank-${cell}`}
                      className="range-calendar-blank"
                    />
                  ) : (
                    dayButton(
                      `${firstDate.slice(0, 8)}${String(day).padStart(2, "0")}`,
                      day,
                    )
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
