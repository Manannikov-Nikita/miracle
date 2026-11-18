import { Decimal } from "decimal.js";
import { HISTOGRAM_BIN_LIMIT } from "../../shared/chart-appearance";

export interface HistogramBin {
  lower: number;
  upper: number;
}

/** Decimal interpolation keeps a decimal boundary such as 0.3 on the correct side. */
export function histogramBins(
  min: number,
  max: number,
  count: number,
): HistogramBin[] {
  if (min === max) return [{ lower: min, upper: max }];
  const low = new Decimal(min);
  const high = new Decimal(max);
  const bins: HistogramBin[] = [];
  let lower = min;
  for (let i = 1; i < count; i++) {
    const upper = low
      .times(count - i)
      .plus(high.times(i))
      .div(count)
      .toNumber();
    // Narrow Float64 ranges can have fewer distinct boundaries than requested.
    if (upper > lower && upper < max) {
      bins.push({ lower, upper });
      lower = upper;
    }
  }
  bins.push({ lower, upper: max });
  return bins;
}

// Round the target interval width in decimal space; 25 ms belongs on the same
// ladder as 20 ms and 50 ms. Float64 subtraction alone can overflow or underflow.
const niceSteps = [1, 2, 2.5, 5, 10];

export function autoHistogramBins(
  min: number,
  max: number,
  observations: number,
  limit = HISTOGRAM_BIN_LIMIT,
): HistogramBin[] {
  if (min === max) return [{ lower: min, upper: max }];
  const target = Math.min(limit, Math.ceil(Math.log2(observations)) + 1);
  const low = new Decimal(min),
    high = new Decimal(max);
  const ideal = high.minus(low).div(target);
  const decade = new Decimal(10).pow(ideal.e);
  const fraction = ideal.div(decade).toNumber();
  let index = 0;
  while (
    index + 1 < niceSteps.length &&
    fraction >= Math.sqrt(niceSteps[index] * niceSteps[index + 1])
  )
    index++;
  for (const factor of niceSteps.slice(index)) {
    const step = decade.times(factor);
    const first = low.div(step).floor();
    const last = high.div(step).ceil();
    const count = last.minus(first).toNumber();
    if (count < 1 || count > limit) continue;
    const lower = first.isZero() ? 0 : first.times(step).toNumber(),
      upper = last.isZero() ? 0 : last.times(step).toNumber();
    if (
      !Number.isFinite(lower) ||
      !Number.isFinite(upper) ||
      lower > min ||
      upper < max
    )
      break;
    const bins = histogramBins(lower, upper, count);
    if (bins.length === count) return bins;
    break;
  }
  // A rounded endpoint may be beyond MAX_VALUE, or the proposed step may be
  // smaller than one ULP. The observed finite range is always a safe fallback.
  return histogramBins(min, max, target);
}

/** First upper bound strictly above the observation, with the maximum in the final bin. */
export function histogramBinIndex(bins: HistogramBin[], value: number) {
  let lo = 0,
    hi = bins.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (value < bins[mid].upper) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
