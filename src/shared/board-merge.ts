import type { BoardDocument } from "./types.js";
import { boardKind, PRESENTATION_MAX_SLIDES } from "./presentation.js";

export type BoardMergeConflict = {
  kind: "node" | "edge" | "slide" | "document";
  id: string;
};
export type BoardMergeResult = {
  document: BoardDocument;
  conflicts: BoardMergeConflict[];
};

/** JSON-value equality independent of property insertion order. Missing optional fields equal undefined. */
export function boardValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => boardValuesEqual(value, b[i]))
    );
  }
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => boardValuesEqual(left[key], right[key]));
}

type Entity = { id: string };
type SlideEntity = Entity & { slideId?: string };

function groupBySlide<T extends SlideEntity>(items: T[]) {
  const groups = new Map<string | undefined, T[]>();
  for (const item of items) {
    const group = groups.get(item.slideId);
    if (group) group.push(item);
    else groups.set(item.slideId, [item]);
  }
  return groups;
}

function reordered<T extends Entity>(base: T[], next: T[]): string[] {
  const beforeIds = new Set(base.map((item) => item.id)),
    afterIds = new Set(next.map((item) => item.id));
  const before = base.filter((item) => afterIds.has(item.id));
  const after = next.filter((item) => beforeIds.has(item.id));
  return before
    .filter((item, index) => item.id !== after[index]?.id)
    .map((item) => item.id);
}

function changedValues<T extends Entity>(base: T[], next: T[]): string[] {
  const before = new Map(base.map((item) => [item.id, item]));
  const after = new Map(next.map((item) => [item.id, item]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(
    (id) => !boardValuesEqual(before.get(id), after.get(id)),
  );
}

function changed<T extends SlideEntity>(
  base: T[],
  next: T[],
  perSlide: boolean,
): string[] {
  const ids = new Set(changedValues(base, next));
  if (perSlide) {
    const nextGroups = groupBySlide(next);
    for (const [slideId, before] of groupBySlide(base))
      for (const id of reordered(before, nextGroups.get(slideId) ?? []))
        ids.add(id);
  } else {
    for (const id of reordered(base, next)) ids.add(id);
  }
  return [...ids];
}

export type BoardChangedEntities = {
  nodeIds: string[];
  edgeIds: string[];
  slideIds?: string[];
  slidesStructureChanged?: boolean;
};

export function boardChangedEntities(
  base: BoardDocument,
  next: BoardDocument,
): BoardChangedEntities {
  const before = base.slides ?? [];
  const after = next.slides ?? [];
  const beforeIds = new Set(before.map((slide) => slide.id));
  const perSlide = boardKind(base) === "presentation";
  return {
    nodeIds: changed(base.nodes, next.nodes, perSlide),
    edgeIds: changed(base.edges, next.edges, perSlide),
    ...(base.slides || next.slides
      ? {
          // Added slides need a board claim; existing slide metadata and
          // deletions also require the corresponding slide claim.
          slideIds: changedValues(before, after).filter((id) =>
            beforeIds.has(id),
          ),
          slidesStructureChanged: !boardValuesEqual(
            before.map((slide) => slide.id),
            after.map((slide) => slide.id),
          ),
        }
      : {}),
  };
}

function hasChangedSlideChildren(
  base: BoardDocument,
  next: BoardDocument,
  slideId: string,
) {
  function hasChange<T extends Entity & { slideId?: string }>(
    before: T[],
    after: T[],
  ) {
    const previous = new Map(before.map((item) => [item.id, item]));
    return (
      after.some((item) => {
        const old = previous.get(item.id);
        return (
          (old?.slideId === slideId || item.slideId === slideId) &&
          !boardValuesEqual(old, item)
        );
      }) ||
      reordered(
        before.filter((item) => item.slideId === slideId),
        after.filter((item) => item.slideId === slideId),
      ).length > 0
    );
  }
  return hasChange(base.nodes, next.nodes) || hasChange(base.edges, next.edges);
}

/** Place additions relative to surviving neighbors without disturbing the chosen draw order. */
function ordered<T extends Entity>(
  values: Map<string, T>,
  primary: T[],
  secondary: T[],
): T[] {
  const ids = primary.map((item) => item.id).filter((id) => values.has(id));
  for (let i = 0; i < secondary.length; i++) {
    const id = secondary[i].id;
    if (!values.has(id) || ids.includes(id)) continue;
    const successor = secondary
      .slice(i + 1)
      .find((item) => ids.includes(item.id));
    if (successor) ids.splice(ids.indexOf(successor.id), 0, id);
    else ids.push(id);
  }
  for (const id of values.keys()) if (!ids.includes(id)) ids.push(id);
  return ids.map((id) => values.get(id)!);
}

/** Three-way entity merge. Conflicts retain the remote value; callers must surface/preserve local drafts. */
export function mergeBoardDocuments(
  base: BoardDocument,
  local: BoardDocument,
  remote: BoardDocument,
): BoardMergeResult {
  const conflicts: BoardMergeConflict[] = [];
  const conflict = (kind: BoardMergeConflict["kind"], id: string) => {
    if (!conflicts.some((item) => item.kind === kind && item.id === id))
      conflicts.push({ kind, id });
  };
  if (
    boardKind(base) !== boardKind(local) ||
    boardKind(base) !== boardKind(remote)
  ) {
    conflict("document", "kind");
    return { document: remote, conflicts };
  }
  function mergeOrder<T extends Entity>(
    values: Map<string, T>,
    before: T[],
    left: T[],
    right: T[],
    kind: "node" | "edge" | "slide",
  ): T[] {
    const localReorder = reordered(before, left).length > 0;
    const remoteReorder = reordered(before, right).length > 0;
    if (localReorder && remoteReorder) {
      const localIds = new Set(left.map((item) => item.id));
      const remoteIds = new Set(right.map((item) => item.id));
      const common = new Set(
        before
          .filter((item) => localIds.has(item.id) && remoteIds.has(item.id))
          .map((item) => item.id),
      );
      if (
        !boardValuesEqual(
          left.filter((item) => common.has(item.id)).map((item) => item.id),
          right.filter((item) => common.has(item.id)).map((item) => item.id),
        )
      ) {
        conflict("document", `${kind}s.order`);
      }
    }
    return localReorder && !remoteReorder
      ? ordered(values, left, right)
      : ordered(values, right, left);
  }
  const presentation = boardKind(base) === "presentation";
  function merge<T extends SlideEntity>(
    before: T[],
    left: T[],
    right: T[],
    kind: "node" | "edge" | "slide",
  ): T[] {
    const b = new Map(before.map((item) => [item.id, item]));
    const l = new Map(left.map((item) => [item.id, item]));
    const r = new Map(right.map((item) => [item.id, item]));
    const values = new Map<string, T>();
    for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
      const original = b.get(id),
        wanted = l.get(id),
        current = r.get(id);
      let value: T | undefined;
      if (boardValuesEqual(wanted, original)) value = current;
      else if (
        boardValuesEqual(current, original) ||
        boardValuesEqual(wanted, current)
      )
        value = wanted;
      else {
        conflict(kind, id);
        value = current;
      }
      if (value) values.set(id, value);
    }
    if (!presentation || kind === "slide")
      return mergeOrder(values, before, left, right, kind);

    const beforeGroups = groupBySlide(before);
    const leftGroups = groupBySlide(left);
    const rightGroups = groupBySlide(right);
    const orders = new Map<string | undefined, T[]>();
    for (const [slideId, items] of groupBySlide([...values.values()])) {
      const order = mergeOrder(
        new Map(items.map((item) => [item.id, item])),
        beforeGroups.get(slideId) ?? [],
        leftGroups.get(slideId) ?? [],
        rightGroups.get(slideId) ?? [],
        kind,
      );
      orders.set(slideId, order.reverse());
    }
    // Keep the persisted interleaving of slides. Only the order within a
    // slide affects its draw order, so fill each slot from that slide's order.
    return ordered(values, right, left).map((item) =>
      orders.get(item.slideId)!.pop()!,
    );
  }
  let slides: BoardDocument["slides"];
  if (presentation) {
    const before = base.slides ?? [];
    const left = local.slides ?? [];
    const right = remote.slides ?? [];
    const l = new Map(left.map((slide) => [slide.id, slide]));
    const r = new Map(right.map((slide) => [slide.id, slide]));
    // A slide deletion also removes every child. In a delete/edit race retain
    // the persisted document as a whole, including children the delete did
    // not know about. The caller can keep the local draft for recovery.
    for (const slide of before) {
      const localSlide = l.get(slide.id);
      const remoteSlide = r.get(slide.id);
      if (
        (!localSlide &&
          remoteSlide &&
          (!boardValuesEqual(slide, remoteSlide) ||
            hasChangedSlideChildren(base, remote, slide.id))) ||
        (!remoteSlide &&
          localSlide &&
          (!boardValuesEqual(slide, localSlide) ||
            hasChangedSlideChildren(base, local, slide.id)))
      )
        conflict("slide", slide.id);
    }
    if (conflicts.length) return { document: remote, conflicts };
    slides = merge(before, left, right, "slide");
    if (!slides.length || slides.length > PRESENTATION_MAX_SLIDES) {
      conflict("document", "slides.order");
      return { document: remote, conflicts };
    }
  }
  let nodes = merge(base.nodes, local.nodes, remote.nodes, "node");
  let edges = merge(base.edges, local.edges, remote.edges, "edge");
  const nodeMap = new Map(nodes.map((item) => [item.id, item]));
  const remoteNodes = new Map(remote.nodes.map((item) => [item.id, item]));
  const remoteEdges = new Map(remote.edges.map((item) => [item.id, item]));
  // A deletion cannot erase a concurrently created/changed relationship. Keep the server graph coherent.
  edges = edges.flatMap((edge) => {
    const missing = [edge.source, edge.target].filter(
      (id): id is string => !!id && !nodeMap.has(id),
    );
    if (!missing.length) return [edge];
    if (
      boardValuesEqual(edge, remoteEdges.get(edge.id)) &&
      missing.every((id) => remoteNodes.has(id))
    ) {
      for (const id of missing) {
        conflict("node", id);
        nodeMap.set(id, remoteNodes.get(id)!);
      }
      return [edge];
    }
    conflict("edge", edge.id);
    const fallback = remoteEdges.get(edge.id);
    if (!fallback) return [];
    for (const id of [fallback.source, fallback.target]) {
      if (id && !nodeMap.has(id) && remoteNodes.has(id)) {
        conflict("node", id);
        nodeMap.set(id, remoteNodes.get(id)!);
      }
    }
    return [fallback];
  });
  nodes = ordered(nodeMap, nodes, remote.nodes);
  if (slides) {
    const slideIds = new Set(slides.map((slide) => slide.id));
    const invalidMembership = [...nodes, ...edges].some(
      (item) => !item.slideId || !slideIds.has(item.slideId),
    );
    const invalidEdge = edges.some((edge) =>
      [edge.source, edge.target].some(
        (id) => id && nodeMap.get(id)?.slideId !== edge.slideId,
      ),
    );
    if (invalidMembership || invalidEdge) {
      conflict("document", "slides.membership");
      return { document: remote, conflicts };
    }
  }
  return {
    document: { ...remote, ...(slides ? { slides } : {}), nodes, edges },
    conflicts,
  };
}
