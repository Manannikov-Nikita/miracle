import Decimal from "decimal.js";
import type {
  VisualTableColumn,
  VisualTableScalar,
} from "../../shared/visual-table";

/** Preserve exact numeric text until DuckDB assigns the storage type. */
export function parseSqlTableCell(
  raw: unknown,
  type: VisualTableColumn["type"],
): VisualTableScalar {
  if (raw === null) return null;
  const text = String(raw ?? "");
  if (type === "text") return text;
  const value = text.trim();
  if (!value) return null;
  if (type === "boolean") {
    if (["true", "да", "1"].includes(value.toLowerCase())) return true;
    if (["false", "нет", "0"].includes(value.toLowerCase())) return false;
    throw new Error(
      "Введите true / false, да / нет или оставьте ячейку пустой.",
    );
  }
  const normalized = value.replace(",", ".");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized))
    throw new Error("Введите число или оставьте ячейку пустой.");
  return normalized;
}

export function formatSqlTableCell(
  value: unknown,
  type: VisualTableColumn["type"],
): string {
  if (value === null || value === undefined) return "—";
  if (type === "boolean")
    return value === true ? "Да" : value === false ? "Нет" : String(value);
  if (type !== "number") return String(value);
  try {
    const number = new Decimal(String(value));
    // Huge exponents should not allocate an enormous display string.
    if (!number.isFinite() || Math.abs(number.e) > 100) return String(value);
    const [integer, decimal] = number.toFixed().split(".");
    return (
      integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0") +
      (decimal ? `,${decimal}` : "")
    );
  } catch {
    return String(value);
  }
}
