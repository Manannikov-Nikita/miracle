/** A flat metric sits in the middle. Opposite Float64 extremes can overflow the span. */
export function unitPosition(value: number, min: number, max: number) {
  if (min === max) return 0.5;
  const span = max - min;
  return Number.isFinite(span)
    ? (value - min) / span
    : (value / 2 - min / 2) / (max / 2 - min / 2);
}
