import type { Engine } from "./types.js";

export type DateGranularity = "day" | "week" | "month";
export interface DateRangeOptions {
  startDate: string;
  endDate: string;
  granularity: DateGranularity;
  /** Additional attempts after the initial request. */
  retries: number;
}
export interface DateBatchItem {
  date: string;
  status:
    | "pending"
    | "running"
    | "retrying"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  attempts: number;
  rowCount?: number;
  error?: string;
}
export interface DateBatchProgress {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentDate?: string;
  attempt: number;
  items: DateBatchItem[];
}
export const MAX_DATE_ITERATIONS = 10000;
export const MAX_DATE_RETRIES = 10;

function calendarDate(value: string): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000-")
  )
    throw new Error("Укажите дату в формате ГГГГ-ММ-ДД");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error("Такой календарной даты не существует");
  return date;
}

/** Calendar-only arithmetic, independent of machine timezone and DST. */
export function dateRangeDates(options: DateRangeOptions): string[] {
  const start = calendarDate(options.startDate);
  const end = calendarDate(options.endDate);
  if (start > end)
    throw new Error("Дата окончания должна быть не раньше даты начала");
  if (!["day", "week", "month"].includes(options.granularity))
    throw new Error("Выберите шаг: дни, недели или месяцы");
  if (
    !Number.isInteger(options.retries) ||
    options.retries < 0 ||
    options.retries > MAX_DATE_RETRIES
  )
    throw new Error(
      `Число повторов должно быть целым от 0 до ${MAX_DATE_RETRIES}`,
    );
  if (
    options.granularity === "week" &&
    (start.getUTCDay() !== 1 || end.getUTCDay() !== 1)
  )
    throw new Error("Для недель выберите понедельник в обеих датах");
  if (
    options.granularity === "month" &&
    (start.getUTCDate() !== 1 || end.getUTCDate() !== 1)
  )
    throw new Error("Для месяцев выберите первое число в обеих датах");
  const dates: string[] = [];
  for (const cursor = new Date(start); cursor <= end;) {
    if (dates.length >= MAX_DATE_ITERATIONS)
      throw new Error(
        `В диапазоне допустимо не более ${MAX_DATE_ITERATIONS} дат`,
      );
    dates.push(cursor.toISOString().slice(0, 10));
    if (options.granularity === "month")
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else
      cursor.setUTCDate(
        cursor.getUTCDate() + (options.granularity === "week" ? 7 : 1),
      );
  }
  return dates;
}

interface Placeholder {
  start: number;
  quoted: boolean;
}
const placeholder = "{{date}}";
/** Recognize parameter values without changing comments or SQL identifiers. */
function datePlaceholders(sql: string, engine: Engine): Placeholder[] {
  const found: Placeholder[] = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (sql.startsWith("--", i) || (engine === "clickhouse" && c === "#")) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < sql.length) {
        if (engine === "clickhouse" && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) i += 2;
          else {
            i++;
            break;
          }
        } else if (quote === "'" && sql.startsWith(placeholder, i)) {
          found.push({ start: i, quoted: true });
          i += placeholder.length;
        } else i++;
      }
    } else if (
      engine === "clickhouse" &&
      c === "$" &&
      /^\$(?:[A-Za-z_][\w]*)?\$/.test(sql.slice(i))
    ) {
      const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)![0];
      i += tag.length;
      const end = sql.indexOf(tag, i);
      const stop = end < 0 ? sql.length : end;
      while (i < stop) {
        if (sql.startsWith(placeholder, i)) {
          found.push({ start: i, quoted: true });
          i += placeholder.length;
        } else i++;
      }
      i = end < 0 ? sql.length : end + tag.length;
    } else if (sql.startsWith(placeholder, i)) {
      found.push({ start: i, quoted: false });
      i += placeholder.length;
    } else i++;
  }
  return found;
}
export function hasDatePlaceholder(
  sql: string,
  engine: Engine = "clickhouse",
): boolean {
  return datePlaceholders(sql, engine).length > 0;
}
/** Both `date = {{date}}` and `date = '{{date}}'` are supported. */
export function substituteDate(
  sql: string,
  date: string,
  engine: Engine = "clickhouse",
): string {
  calendarDate(date);
  const pieces: string[] = [];
  let offset = 0;
  for (const token of datePlaceholders(sql, engine)) {
    pieces.push(
      sql.slice(offset, token.start),
      token.quoted ? date : `'${date}'`,
    );
    offset = token.start + placeholder.length;
  }
  pieces.push(sql.slice(offset));
  return pieces.join("");
}
