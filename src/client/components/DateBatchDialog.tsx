import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DateRangeOptions } from "../../shared/types";
import { dateRangeDates } from "../../shared/date-batch";
import { ErrorBox, Modal, Spinner } from "./UI";
import DateRangeCalendar from "./DateRangeCalendar";
import {
  normalizeDateForCalendar,
  isCalendarDate,
  addCalendarDays,
} from "./date-range-calendar-helpers";
import "./date-batch-dialog.css";

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function defaults(initial?: DateRangeOptions): DateRangeOptions {
  return (
    initial || {
      startDate: today(),
      endDate: today(),
      granularity: "day",
      retries: 2,
    }
  );
}
const queryWord = (count: number) => {
  const rule = new Intl.PluralRules("ru").select(count);
  return rule === "one" ? "запрос" : rule === "few" ? "запроса" : "запросов";
};

export default function DateBatchDialog({
  open,
  initial,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initial?: DateRangeOptions;
  onOpenChange: (open: boolean) => void;
  onSubmit: (options: DateRangeOptions) => Promise<void>;
}) {
  const [options, setOptions] = useState(() => defaults(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  useEffect(() => {
    if (open) {
      setOptions(defaults(initial));
      setError("");
    }
  }, [open, initial]);
  const effectiveOptions = useMemo(
    () => ({
      ...options,
      startDate:
        normalizeDateForCalendar(
          options.startDate,
          options.granularity,
          options.weekStartsOn,
        ) || options.startDate,
      endDate:
        normalizeDateForCalendar(
          options.endDate,
          options.granularity,
          options.weekStartsOn,
        ) || options.endDate,
    }),
    [options],
  );
  const preview = useMemo(() => {
    try {
      return { dates: dateRangeDates(effectiveOptions), error: "" };
    } catch (error) {
      return { dates: [], error: (error as Error).message };
    }
  }, [effectiveOptions]);
  function align(
    value: string,
    granularity = options.granularity,
    weekStartsOn = options.weekStartsOn,
  ) {
    return normalizeDateForCalendar(value, granularity, weekStartsOn) || value;
  }
  function granularity(value: DateRangeOptions["granularity"]) {
    setOptions((current) => ({
      ...current,
      granularity: value,
      startDate: align(
        current.startDate || today(),
        value,
        current.weekStartsOn,
      ),
      endDate: align(current.endDate || today(), value, current.weekStartsOn),
    }));
  }
  function weekStart(value: NonNullable<DateRangeOptions["weekStartsOn"]>) {
    setOptions((current) => {
      const previous = current.weekStartsOn || "monday";
      // Keep the selected weeks stable when toggling their first weekday.
      const shift = previous === value ? 0 : value === "sunday" ? -1 : 1;
      const realign = (date: string) => {
        const start = normalizeDateForCalendar(date, "week", previous);
        return start ? addCalendarDays(start, shift) : date;
      };
      return {
        ...current,
        weekStartsOn: value,
        startDate: realign(current.startDate),
        endDate: realign(current.endDate),
      };
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || preview.error || !preview.dates.length) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      setOptions(effectiveOptions);
      await onSubmit({ ...effectiveOptions });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      open={open}
      className="date-batch-dialog"
      dismissible={!busy}
      onOpenChange={(value) => {
        if (!submitting.current) onOpenChange(value);
      }}
      title="Запуск по датам"
      description="Выберите начало и конец диапазона в календаре или введите даты."
    >
      <form className="date-batch-form" onSubmit={submit} noValidate>
        <fieldset className="date-granularity" disabled={busy}>
          <legend>Шаг</legend>
          {(
            [
              ["day", "Дни"],
              ["week", "Недели"],
              ["month", "Месяцы"],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={options.granularity === value}
              onClick={() => granularity(value)}
            >
              {label}
            </button>
          ))}
        </fieldset>
        {options.granularity === "week" && (
          <fieldset className="date-week-start" disabled={busy}>
            <legend>Начало недели</legend>
            {(
              [
                ["monday", "Понедельник"],
                ["sunday", "Воскресенье"],
              ] as const
            ).map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={(options.weekStartsOn || "monday") === value}
                onClick={() => weekStart(value)}
              >
                {label}
              </button>
            ))}
          </fieldset>
        )}
        <div className="date-batch-range">
          <label>
            {options.granularity === "week"
              ? "Первая неделя"
              : options.granularity === "month"
                ? "Первый месяц"
                : "Начало"}
            <input
              aria-label="Начало диапазона"
              type="text"
              placeholder="2025-01-01"
              maxLength={10}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!isCalendarDate(options.startDate)}
              value={options.startDate}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  startDate: event.target.value,
                }))
              }
              onBlur={() =>
                setOptions((current) => ({
                  ...current,
                  startDate: align(current.startDate),
                }))
              }
              disabled={busy}
              required
            />
          </label>
          <label>
            {options.granularity === "week"
              ? "Последняя неделя"
              : options.granularity === "month"
                ? "Последний месяц"
                : "Конец включительно"}
            <input
              aria-label="Конец диапазона"
              type="text"
              placeholder="2025-01-01"
              maxLength={10}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!isCalendarDate(options.endDate)}
              value={options.endDate}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  endDate: event.target.value,
                }))
              }
              onBlur={() =>
                setOptions((current) => ({
                  ...current,
                  endDate: align(current.endDate),
                }))
              }
              disabled={busy}
              required
            />
          </label>
        </div>
        <DateRangeCalendar
          startDate={effectiveOptions.startDate}
          endDate={effectiveOptions.endDate}
          granularity={options.granularity}
          weekStartsOn={options.weekStartsOn}
          disabled={busy}
          onChange={(range) =>
            setOptions((current) => ({ ...current, ...range }))
          }
        />
        <p className="date-batch-hint">
          {options.granularity === "week"
            ? `Недели выбираются целиком. В запрос подставляется ${options.weekStartsOn === "sunday" ? "воскресенье" : "понедельник"} каждой недели.`
            : options.granularity === "month"
              ? "Для каждого месяца подставляется первое число."
              : "Подставляется каждый календарный день диапазона."}
        </p>
        <div className="date-batch-summary">
          <label className="date-batch-retries">
            Повторы при ошибке
            <input
              aria-label="Повторы при ошибке"
              type="number"
              min={0}
              max={10}
              step={1}
              value={Number.isNaN(options.retries) ? "" : options.retries}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  retries:
                    event.target.value === ""
                      ? NaN
                      : Number(event.target.value),
                }))
              }
              disabled={busy}
            />
            <small>
              Дополнительные попытки для каждой даты, от 0 до 10. Если все
              попытки неудачны, серия приостановится до вашего решения.
            </small>
          </label>
          {preview.error ? (
            <ErrorBox>{preview.error}</ErrorBox>
          ) : (
            <div className="date-batch-preview" aria-live="polite">
              <strong>
                {preview.dates.length.toLocaleString("ru-RU")}{" "}
                {queryWord(preview.dates.length)}
              </strong>
              <span>
                {preview.dates[0]}
                {preview.dates.length > 1 ? ` → ${preview.dates.at(-1)}` : ""}
              </span>
              <small>
                <code>{"{{date}}"}</code> → <code>'{preview.dates[0]}'</code>
              </small>
            </div>
          )}
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <div className="modal-actions">
          <button
            type="button"
            className="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || Boolean(preview.error) || !preview.dates.length}
          >
            {busy ? <Spinner /> : null}
            {busy ? "Запускаем…" : "Запустить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
