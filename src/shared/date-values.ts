import type { Cell } from "./types.js";

const isoDate = /^(\d{4})-(\d{2})-(\d{2})(.*)$/;
const dottedDate = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(.*)$/;
const time =
  /^(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?: ?(Z|UTC|[+-]\d{2}:?\d{2}))?)?$/i;

/**
 * Parse explicit calendar dates only; numbers and ambiguous locale formats are
 * not guessed. Zone-less SQL timestamps use UTC consistently in every browser.
 * Nanoseconds preserve ordering of ClickHouse DateTime64 values.
 */
export function dateValue(value: Cell | undefined): bigint | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const iso = isoDate.exec(text);
  const dotted = iso ? undefined : dottedDate.exec(text);
  if (!iso && !dotted) return undefined;
  const year = Number(iso ? iso[1] : dotted![3]);
  const month = Number(iso ? iso[2] : dotted![2]);
  const day = Number(iso ? iso[3] : dotted![1]);
  const suffix = time.exec((iso ?? dotted)![4]);
  if (!suffix) return undefined;
  const hour = Number(suffix[1] ?? 0);
  const minute = Number(suffix[2] ?? 0);
  const second = Number(suffix[3] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return undefined;
  const zone = suffix[5];
  let offsetMinutes = 0;
  if (zone && !/^(Z|UTC)$/i.test(zone)) {
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2));
    if (hours > 23 || minutes > 59) return undefined;
    offsetMinutes = (hours * 60 + minutes) * (zone[0] === "+" ? 1 : -1);
  }
  return (
    BigInt(date.getTime() - offsetMinutes * 60_000) * 1_000_000n +
    BigInt((suffix[4] ?? "").padEnd(9, "0"))
  );
}

/** Valid dates first in either direction; unparseable values retain source order. */
export function compareDateValues(
  a: Cell | undefined,
  b: Cell | undefined,
  direction: "asc" | "desc" = "asc",
): number {
  const left = dateValue(a);
  const right = dateValue(b);
  if (left === undefined || right === undefined)
    return left === right ? 0 : left === undefined ? 1 : -1;
  return (
    (left === right ? 0 : left < right ? -1 : 1) *
    (direction === "desc" ? -1 : 1)
  );
}
