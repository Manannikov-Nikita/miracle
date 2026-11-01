import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { DateRangeOptions } from "../../shared/types";
import { dateRangeDates } from "../../shared/date-batch";
import { ErrorBox, Modal, Spinner } from "./UI";

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function monday(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return isoDate(date);
}
function weekValue(value: string) {
  const start = monday(value);
  if (!start) return "";
  const thursday = new Date(`${start}T00:00:00Z`);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const year = String(thursday.getUTCFullYear()).padStart(4, "0");
  const first = new Date(`${monday(`${year}-01-04`)}T00:00:00Z`);
  const week =
    1 +
    Math.round(
      (new Date(`${start}T00:00:00Z`).getTime() - first.getTime()) / 604800000,
    );
  return `${year}-W${String(week).padStart(2, "0")}`;
}
function weekDate(value: string) {
  if (!/^\d{4}-W\d{2}$/.test(value)) return "";
  const date = new Date(`${monday(`${value.slice(0, 4)}-01-04`)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (Number(value.slice(-2)) - 1) * 7);
  if (!Number.isFinite(date.getTime())) return "";
  const result = isoDate(date);
  return weekValue(result) === value ? result : "";
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
  const [weekInputSupported] = useState(() => {
    const input = document.createElement("input");
    input.type = "week";
    return input.type === "week";
  });
  useEffect(() => {
    if (open) {
      setOptions(defaults(initial));
      setError("");
    }
  }, [open, initial]);
  const preview = useMemo(() => {
    try {
      return { dates: dateRangeDates(options), error: "" };
    } catch (error) {
      return { dates: [], error: (error as Error).message };
    }
  }, [options]);
  const inputType =
    options.granularity === "month"
      ? "month"
      : options.granularity === "week" && weekInputSupported
        ? "week"
        : "date";
  function display(value: string) {
    return inputType === "month"
      ? value.slice(0, 7)
      : inputType === "week"
        ? weekValue(value)
        : value;
  }
  function read(value: string) {
    return inputType === "month"
      ? value
        ? `${value}-01`
        : ""
      : inputType === "week"
        ? weekDate(value)
        : value;
  }
  function granularity(value: DateRangeOptions["granularity"]) {
    const align = (date: string) =>
      value === "week"
        ? monday(date)
        : value === "month"
          ? `${date.slice(0, 7)}-01`
          : date;
    setOptions((current) => ({
      ...current,
      granularity: value,
      startDate: align(current.startDate || today()),
      endDate: align(current.endDate || today()),
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || preview.error || !preview.dates.length) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onSubmit({ ...options });
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
      dismissible={!busy}
      onOpenChange={(value) => {
        if (!submitting.current) onOpenChange(value);
      }}
      title="Запуск по датам"
      description="Один запрос на каждую дату. Успешные результаты добавляются в общую таблицу."
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
        <div className="date-batch-range">
          <label>
            Начало
            <input
              aria-label="Начало диапазона"
              type={inputType}
              min={
                options.granularity === "week" && !weekInputSupported
                  ? "0001-01-01"
                  : undefined
              }
              step={
                options.granularity === "week" && !weekInputSupported
                  ? 7
                  : undefined
              }
              value={display(options.startDate)}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  startDate: read(event.target.value),
                }))
              }
              disabled={busy}
              required
            />
          </label>
          <label>
            Конец включительно
            <input
              aria-label="Конец диапазона"
              type={inputType}
              min={
                options.granularity === "week" && !weekInputSupported
                  ? "0001-01-01"
                  : undefined
              }
              step={
                options.granularity === "week" && !weekInputSupported
                  ? 7
                  : undefined
              }
              value={display(options.endDate)}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  endDate: read(event.target.value),
                }))
              }
              disabled={busy}
              required
            />
          </label>
        </div>
        <p className="date-batch-hint">
          {options.granularity === "week"
            ? "Для каждой недели подставляется её понедельник."
            : options.granularity === "month"
              ? "Для каждого месяца подставляется первое число."
              : "Подставляется каждый календарный день диапазона."}
        </p>
        <label>
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
                  event.target.value === "" ? NaN : Number(event.target.value),
              }))
            }
            disabled={busy}
          />
          <small>
            Дополнительные попытки для каждой даты, от 0 до 10. После ошибки
            серия продолжается.
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
