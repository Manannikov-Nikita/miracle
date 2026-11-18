export interface BandPoint {
  category: number;
  value: number | null;
  base: number;
  end: number;
  oppositeBase: number;
}

/** A diverging ribbon pinches to its own side of the stack when it changes sign. */
export function splitSignedArea<T extends BandPoint>(points: T[]): T[] {
  const path: T[] = [];
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const previous = points[index - 1];
    if (
      previous &&
      previous.value !== null &&
      current.value !== null &&
      previous.value < 0 !== current.value < 0
    ) {
      // Normalize the ratio first so opposite Float64 extremes can cross safely.
      const a = Math.abs(previous.value);
      const b = Math.abs(current.value);
      const unit = Math.max(a, b);
      const fraction = a / unit / (a / unit + b / unit);
      const between = (start: number, end: number) =>
        start * (1 - fraction) + end * fraction;
      const category = between(previous.category, current.category);
      if (previous.value !== 0) {
        const base = between(previous.base, current.oppositeBase);
        // Both halves belong to the same incoming observed segment.
        path.push({ ...current, category, base, end: base, value: 0 });
      }
      // Distinct positive and negative baselines must not be joined by paint.
      path.push({ ...current, category, value: null });
      if (current.value !== 0) {
        const base = between(previous.oppositeBase, current.base);
        path.push({ ...current, category, base, end: base, value: 0 });
      }
    }
    path.push(current);
  }
  return path;
}
