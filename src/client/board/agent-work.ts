import type { AgentEntityWork } from "../../shared/agent-work";
import type { BoardDocument } from "../../shared/types";
import {
  boardChangedEntities,
  boardValuesEqual,
} from "../../shared/board-merge";

export function nodeWork(
  locks: AgentEntityWork[],
  boardId: string,
  id: string,
) {
  return locks.find(
    ({ target }) =>
      target.kind === "board-node" &&
      target.boardId === boardId &&
      target.id === id,
  );
}
export function edgeWork(
  locks: AgentEntityWork[],
  boardId: string,
  id: string,
  document: BoardDocument,
) {
  const direct = locks.find(
    ({ target }) =>
      target.kind === "board-edge" &&
      target.boardId === boardId &&
      target.id === id,
  );
  const edge = document.edges.find((edge) => edge.id === id);
  return (
    direct ||
    (edge?.source ? nodeWork(locks, boardId, edge.source) : undefined) ||
    (edge?.target ? nodeWork(locks, boardId, edge.target) : undefined)
  );
}
export function boardWork(
  locks: AgentEntityWork[],
  boardId: string,
  any = false,
) {
  return locks.find(
    ({ target }) =>
      (target.kind === "board" && target.id === boardId) ||
      (any && "boardId" in target && target.boardId === boardId),
  );
}

export function slideWork(
  locks: AgentEntityWork[],
  boardId: string,
  id: string,
) {
  return locks.find(
    ({ target }) =>
      target.kind === "board-slide" &&
      target.boardId === boardId &&
      target.id === id,
  );
}

export function slideDeletionWork(
  locks: AgentEntityWork[],
  boardId: string,
  id: string,
  document: BoardDocument,
) {
  return (
    boardWork(locks, boardId) ||
    slideWork(locks, boardId, id) ||
    document.nodes
      .filter((node) => node.slideId === id)
      .map((node) => nodeWork(locks, boardId, node.id))
      .find(Boolean) ||
    document.edges
      .filter((edge) => edge.slideId === id)
      .map((edge) => edgeWork(locks, boardId, edge.id, document))
      .find(Boolean)
  );
}

function sameEntityOrder<T extends { id: string }>(
  left: T[],
  right: T[],
  ids: string[],
) {
  const l = new Map(left.map((item, index) => [item.id, index]));
  const r = new Map(right.map((item, index) => [item.id, index]));
  return ids.every(
    (id) =>
      !l.has(id) ||
      !r.has(id) ||
      [...l.keys()].every(
        (other) =>
          !r.has(other) ||
          Math.sign(l.get(id)! - l.get(other)!) ===
            Math.sign(r.get(id)! - r.get(other)!),
      ),
  );
}

/** Keep protected objects at their base value; independent changes still apply. */
export function protectBoardChanges(
  boardId: string,
  base: BoardDocument,
  next: BoardDocument,
  locks: AgentEntityWork[],
) {
  const changes = boardChangedEntities(base, next);
  const nodes = new Set(
    changes.nodeIds.filter((id) => nodeWork(locks, boardId, id)),
  );
  const edges = new Set(
    changes.edgeIds.filter(
      (id) =>
        edgeWork(locks, boardId, id, base) ||
        edgeWork(locks, boardId, id, next),
    ),
  );
  // Deleting an endpoint must not delete or strand a protected arrow.
  for (const id of changes.nodeIds) {
    if (next.nodes.some((node) => node.id === id)) continue;
    for (const edge of base.edges) {
      if (
        (edge.source === id || edge.target === id) &&
        edgeWork(locks, boardId, edge.id, base)
      ) {
        nodes.add(id);
        edges.add(edge.id);
      }
    }
  }
  const beforeSlides = base.slides ?? [];
  const nextSlides = next.slides ?? [];
  const beforeSlideIds = new Set(beforeSlides.map((slide) => slide.id));
  const nextSlideIds = new Set(nextSlides.map((slide) => slide.id));
  const structureProtected =
    !!changes.slidesStructureChanged && !!boardWork(locks, boardId);
  const slides = new Set(
    (changes.slideIds ?? []).filter((id) => slideWork(locks, boardId, id)),
  );
  for (const slide of beforeSlides) {
    if (
      nextSlideIds.has(slide.id) ||
      !slideDeletionWork(locks, boardId, slide.id, base)
    )
      continue;
    slides.add(slide.id);
    for (const node of base.nodes)
      if (node.slideId === slide.id) nodes.add(node.id);
    for (const edge of base.edges)
      if (edge.slideId === slide.id) edges.add(edge.id);
  }
  if (!nodes.size && !edges.size && !slides.size && !structureProtected)
    return next;
  const restore = <T extends { id: string }>(
    before: T[],
    after: T[],
    ids: Set<string>,
    forceOrder = false,
    protectOrder = true,
  ) => {
    const values = new Map(
      [
        ...after.filter((value) => !ids.has(value.id)),
        ...before.filter((value) => ids.has(value.id)),
      ].map((value) => [value.id, value]),
    );
    const orderProtected =
      forceOrder || (protectOrder && !sameEntityOrder(before, after, [...ids]));
    const primary = orderProtected ? before : after;
    const secondary = orderProtected ? after : before;
    const order = primary
      .map((value) => value.id)
      .filter((id) => values.has(id));
    for (let index = 0; index < secondary.length; index++) {
      const id = secondary[index].id;
      if (!values.has(id) || order.includes(id)) continue;
      const successor = secondary
        .slice(index + 1)
        .find((value) => order.includes(value.id));
      if (successor) order.splice(order.indexOf(successor.id), 0, id);
      else order.push(id);
    }
    return order.map((id) => values.get(id)!);
  };
  const restoredSlides = restore(
    beforeSlides,
    structureProtected
      ? nextSlides.filter((slide) => beforeSlideIds.has(slide.id))
      : nextSlides,
    slides,
    structureProtected,
    false,
  );
  const slideIds = new Set(restoredSlides.map((slide) => slide.id));
  const restoredNodes = restore(base.nodes, next.nodes, nodes).filter(
    (node) => !node.slideId || slideIds.has(node.slideId),
  );
  const ids = new Set(restoredNodes.map((node) => node.id));
  return {
    ...next,
    ...(next.slides ? { slides: restoredSlides } : {}),
    nodes: restoredNodes,
    edges: restore(base.edges, next.edges, edges).filter(
      (edge) =>
        (!edge.slideId || slideIds.has(edge.slideId)) &&
        (!edge.source || ids.has(edge.source)) &&
        (!edge.target || ids.has(edge.target)),
    ),
  };
}

/** An SSE echo may contain unrelated server changes and skip many revisions. */
export function containsBoardChanges(
  base: BoardDocument,
  sent: BoardDocument,
  remote: BoardDocument,
) {
  const changes = boardChangedEntities(base, sent);
  const sentSlides = sent.slides ?? [];
  const remoteSlides = remote.slides ?? [];
  const slideIds = new Set([
    ...(changes.slideIds ?? []),
    ...sentSlides
      .filter((slide) => !base.slides?.some((item) => item.id === slide.id))
      .map((slide) => slide.id),
  ]);
  return (
    (!changes.slidesStructureChanged ||
      sameEntityOrder(
        sentSlides,
        remoteSlides,
        sentSlides.map((slide) => slide.id),
      )) &&
    [...slideIds].every((id) =>
      boardValuesEqual(
        sentSlides.find((slide) => slide.id === id),
        remoteSlides.find((slide) => slide.id === id),
      ),
    ) &&
    sameEntityOrder(sent.nodes, remote.nodes, changes.nodeIds) &&
    sameEntityOrder(sent.edges, remote.edges, changes.edgeIds) &&
    changes.nodeIds.every((id) =>
      boardValuesEqual(
        sent.nodes.find((node) => node.id === id),
        remote.nodes.find((node) => node.id === id),
      ),
    ) &&
    changes.edgeIds.every((id) =>
      boardValuesEqual(
        sent.edges.find((edge) => edge.id === id),
        remote.edges.find((edge) => edge.id === id),
      ),
    )
  );
}
