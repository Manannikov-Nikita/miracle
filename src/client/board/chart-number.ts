import type { ChartSpec } from "../../shared/types";

const auto = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 });
const integer = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const compactFraction = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 4,
  useGrouping: false,
});
const units = ["", "k", "M", "G", "T", "P", "E", "Z", "Y"];

export function formatChartNumber(
  value: number,
  format: ChartSpec["numberFormat"] = "auto",
) {
  if (format === "compact") {
    if (value === 0) return "0";
    if (!Number.isFinite(value)) return String(value);
    const magnitude = Math.abs(value);
    // Keep small nonzero values visible instead of rounding them to zero.
    if (magnitude < 1) return compactFraction.format(value);
    let unit = Math.min(
      Math.floor(Math.log10(magnitude) / 3),
      units.length - 1,
    );
    let rounded = Math.round((magnitude / 1000 ** unit) * 10) / 10;
    // Promote after rounding as well: 999.95k is 1M, never 1000k.
    if (rounded >= 1000 && unit < units.length - 1) {
      rounded /= 1000;
      unit += 1;
    }
    return `${value < 0 ? "-" : ""}${rounded}${units[unit]}`;
  }
  if (format === "percent") return `${decimal.format(value * 100)}%`;
  return (
    format === "integer" ? integer : format === "decimal" ? decimal : auto
  ).format(value);
}
