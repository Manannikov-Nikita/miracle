import type { DateGranularity } from "../../shared/date-batch";

export type CalendarWeekStart = "monday" | "sunday";
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-"))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function calendarISO(date: Date): string {
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() < 1 ||
    date.getUTCFullYear() > 9999
  )
    return "";
  return date.toISOString().slice(0, 10);
}
export function addCalendarDays(value: string, count: number): string {
  if (!isCalendarDate(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return calendarISO(date);
}
export function normalizeDateForCalendar(
  value: string,
  granularity: DateGranularity,
  weekStartsOn: CalendarWeekStart = "monday",
): string {
  if (!isCalendarDate(value)) return "";
  if (granularity === "month") return `${value.slice(0, 7)}-01`;
  if (granularity === "week") {
    const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
    return addCalendarDays(
      value,
      -((weekday - (weekStartsOn === "monday" ? 1 : 0) + 7) % 7),
    );
  }
  return value;
}
export function calendarMonthIndex(value: string): number {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
}
export function calendarMonthDate(index: number): string {
  const year = Math.floor(index / 12);
  if (year < 1 || year > 9999) return "";
  return `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`;
}
export function calendarToday(): string {
  const date = new Date();
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
