export type SnapAxis = "x" | "y";
export type SnapBounds = {
  x: number;
  y: number;
  right: number;
  bottom: number;
};
export type SnapTarget = { id: string; bounds: SnapBounds };

export type SpacingGuide = {
  kind: "spacing";
  axis: SnapAxis;
  coordinate: number;
  from: number;
  to: number;
  distance: number;
};

type Interval = { start: number; end: number };
type Projection = Interval & { cross: Interval };
type Target = Projection & { id: string };
type Placement = "before" | "between" | "after";
export type SpacingSnap = {
  delta: number;
  start: number;
  first: Target;
  second: Target;
  placement: Placement;
};

const epsilon = 1e-9;

function project(bounds: SnapBounds, axis: SnapAxis): Projection {
  const { x, y, right, bottom } = bounds;
  return axis === "x"
    ? { start: x, end: right, cross: { start: y, end: bottom } }
    : { start: y, end: bottom, cross: { start: x, end: right } };
}

function overlaps(first: Interval, second: Interval): boolean {
  return first.start < second.end && second.start < first.end;
}

function byNearEnd(first: Target, second: Target): number {
  return second.end - first.end || first.id.localeCompare(second.id);
}

function byNearStart(first: Target, second: Target): number {
  return first.start - second.start || first.id.localeCompare(second.id);
}

function keepNearest(
  nearest: Target[],
  target: Target,
  compare: (first: Target, second: Target) => number,
) {
  if (!nearest[0] || compare(target, nearest[0]) < 0) {
    nearest[1] = nearest[0];
    nearest[0] = target;
  } else if (!nearest[1] || compare(target, nearest[1]) < 0) {
    nearest[1] = target;
  }
}

export function nearestSpacingSnap(
  bounds: SnapBounds,
  stationary: readonly SnapTarget[],
  axis: SnapAxis,
  threshold: number,
): SpacingSnap | undefined {
  if (stationary.length < 2) return;
  const moving = project(bounds, axis);
  const extent = moving.end - moving.start;
  const events = stationary.flatMap(({ id, bounds }) => {
    const target = { id, ...project(bounds, axis) };
    const start = Math.max(target.cross.start, moving.cross.start);
    const end = Math.min(target.cross.end, moving.cross.end);
    return end - start > epsilon
      ? [
          { coordinate: start, target, enter: true },
          { coordinate: end, target, enter: false },
        ]
      : [];
  });
  events.sort((first, second) => first.coordinate - second.coordinate);

  let best: SpacingSnap | undefined;
  function consider(placement: Placement, first?: Target, second?: Target) {
    if (!first || !second) return;
    const available = second.start - first.end;
    const gap = placement === "between" ? (available - extent) / 2 : available;
    if (gap <= epsilon) return;
    const start =
      placement === "before"
        ? first.start - gap - extent
        : (placement === "between" ? first : second).end + gap;
    const delta = start - moving.start;
    if (Math.abs(delta) > threshold) return;
    const difference = best
      ? Math.abs(delta) - Math.abs(best.delta)
      : -Infinity;
    if (
      !best ||
      difference < -epsilon ||
      (Math.abs(difference) <= epsilon &&
        (start - best.start ||
          first.id.localeCompare(best.first.id) ||
          second.id.localeCompare(best.second.id) ||
          placement.localeCompare(best.placement)) < 0)
    ) {
      best = { delta, start, first, second, placement };
    }
  }

  // A perpendicular strip has a constant set of visible objects. Only its
  // nearest two neighbors on either side can participate in an equal gap.
  const active = new Set<Target>();
  for (let index = 0; index < events.length;) {
    const coordinate = events[index].coordinate;
    do {
      const { target, enter } = events[index++];
      if (enter) active.add(target);
      else active.delete(target);
    } while (events[index]?.coordinate === coordinate);
    if (!events[index] || events[index].coordinate - coordinate <= epsilon)
      continue;

    const before: Target[] = [];
    const after: Target[] = [];
    let blocked = false;
    for (const target of active) {
      if (target.end < moving.start) keepNearest(before, target, byNearEnd);
      else if (target.start > moving.end)
        keepNearest(after, target, byNearStart);
      else {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    consider("between", before[0], after[0]);
    consider("before", after[0], after[1]);
    consider("after", before[1], before[0]);
  }
  return best;
}

export function spacingGuides(
  snap: SpacingSnap,
  bounds: SnapBounds,
  stationary: readonly SnapTarget[],
  axis: SnapAxis,
): SpacingGuide[] {
  const moving = project(bounds, axis);
  const { first, second, placement } = snap;
  const [left, middle, right] =
    placement === "before"
      ? [moving, first, second]
      : placement === "between"
        ? [first, moving, second]
        : [first, second, moving];
  const gaps = [
    { start: left.end, end: middle.start },
    { start: middle.end, end: right.start },
  ];
  const gapSizes = gaps.map(({ start, end }) => end - start);
  if (
    gapSizes.some((gap) => gap <= epsilon) ||
    Math.abs(gapSizes[0] - gapSizes[1]) > epsilon
  )
    return [];

  const cross = {
    start: Math.max(left.cross.start, middle.cross.start, right.cross.start),
    end: Math.min(left.cross.end, middle.cross.end, right.cross.end),
  };
  if (cross.end - cross.start <= epsilon) return [];
  // The other axis may have snapped as well. Choose the widest unblocked
  // common strip at the final position before producing either measurement.
  const blockers = stationary.flatMap(({ id, bounds }) => {
    if (id === first.id || id === second.id) return [];
    const target = project(bounds, axis);
    return overlaps(target.cross, cross) &&
      (overlaps(target, moving) || gaps.some((gap) => overlaps(target, gap)))
      ? [target.cross]
      : [];
  });
  blockers.sort((first, second) => first.start - second.start);
  let start = cross.start;
  let longest: Interval = { start, end: start };
  for (const blocker of blockers) {
    if (blocker.start - start > longest.end - longest.start)
      longest = { start, end: blocker.start };
    start = Math.max(start, blocker.end);
  }
  if (cross.end - start > longest.end - longest.start)
    longest = { start, end: cross.end };
  if (longest.end - longest.start <= epsilon) return [];

  const coordinate = (longest.start + longest.end) / 2;
  const distance = (gapSizes[0] + gapSizes[1]) / 2;
  return gaps.map(({ start, end }) => ({
    kind: "spacing",
    axis,
    coordinate,
    from: start,
    to: end,
    distance,
  }));
}
