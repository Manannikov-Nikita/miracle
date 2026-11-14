import { z } from "zod";
import {
  getNodeLineEndpoints,
  getNodeVisualBounds,
  normalizeRotation,
  type VisualBounds,
} from "../shared/board-geometry.js";
import {
  type Axis,
  alignBoardNodes,
  placeBoardNode,
  resizeBoardNode,
  translateBoardNode,
} from "../shared/board-layout.js";
import {
  boardKind,
  PRESENTATION_HEIGHT,
  PRESENTATION_WIDTH,
} from "../shared/presentation.js";
import { resolveShape } from "../shared/shapes.js";
import type { BoardEdge, BoardNode } from "../shared/types.js";
import { problem } from "./project-store.js";
import type { WorkspaceOperations } from "./workspace-operations.js";

const id = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const maxSpatialNodes = 32;
const ids = z.array(id).min(1).max(maxSpatialNodes);
const page = {
  id: z.uuid(),
  revision: revision
    .optional()
    .describe("Use the revision from the first page on every continuation."),
  nodeIds: ids.optional(),
  edgeIds: ids.optional(),
  offset: z.number().int().nonnegative().default(0),
};
const sceneInput = z
  .strictObject({
    ...page,
    slideId: id
      .optional()
      .describe(
        "Slide ID. Omit to list slides when no focus IDs are supplied.",
      ),
    nodeIds: page.nodeIds.describe(
      "Focus nodes. Includes their incident links and nearby objects on the same slide or board.",
    ),
    edgeIds: page.edgeIds.describe(
      "Explicit edges to include with their connected nodes.",
    ),
    includeTextPreview: z
      .boolean()
      .default(false)
      .describe("Include a short text preview when content access is allowed."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(40)
      .describe("Maximum number of scene items on this page."),
  })
  .describe(
    "Inspect painted bounds and nominal line endpoints. Attached connectors report their node ID and handle side.",
  );
const itemsInput = z.strictObject({
  ...page,
  offset: page.offset.describe(
    "Pass nextOffset from the preceding page; offsets are UTF-16 code units in the exact JSON.",
  ),
  limit: z
    .number()
    .int()
    .min(4)
    .max(48 * 1024)
    .default(24 * 1024)
    .describe(
      "Maximum UTF-8 bytes of the JSON fragment; wire encoding can require a smaller fragment.",
    ),
});
const coordinate = z.number().min(-1_000_000).max(1_000_000);
const dimension = z.number().gt(0).max(10_000);
const spatialOperation = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("move"),
      nodeIds: ids,
      dx: coordinate,
      dy: coordinate,
    })
    .describe(
      "Translate every selected node by the same board-coordinate delta.",
    ),
  z
    .strictObject({
      type: z.literal("place"),
      id,
      x: coordinate,
      y: coordinate,
    })
    .describe(
      "Translate the node so the top-left of its painted bounds is at x,y.",
    ),
  z.strictObject({
    type: z.literal("align"),
    nodeIds: ids,
    action: z.enum(["left", "center-x", "right", "top", "center-y", "bottom"]),
    anchorId: id
      .optional()
      .describe(
        "An unchanged reference node. Without it, align to the painted bounds of the group.",
      ),
  }),
  z
    .strictObject({
      type: z.literal("distribute"),
      nodeIds: ids.min(3),
      axis: z.enum(["x", "y"]),
    })
    .describe(
      "Equalize painted gaps along one axis while holding both outer nodes fixed. Requires enough span to preserve node order.",
    ),
  z
    .strictObject({
      type: z.literal("resize"),
      id,
      width: dimension.optional(),
      height: dimension.optional(),
      anchor: z
        .enum([
          "top-left",
          "top-right",
          "bottom-left",
          "bottom-right",
          "center",
        ])
        .default("top-left"),
    })
    .describe(
      "Set unrotated frame dimensions and preserve the chosen point of the painted bounds. Supplied dimensions of non-line shapes must be at least 40.",
    ),
]);
const spatialInput = z.strictObject({
  id: z.uuid(),
  baseRevision: revision.describe(
    "Exact current revision from read_board_scene or read_board.",
  ),
  mutationId: z.uuid(),
  operations: z
    .array(spatialOperation)
    .min(1)
    .max(32)
    .describe(
      "Operations applied in order in a single transaction, with at most 32 distinct nodes including anchors.",
    ),
});

export const sceneInputSchema = z.toJSONSchema(sceneInput, { io: "input" });
export const itemsInputSchema = z.toJSONSchema(itemsInput, { io: "input" });
export const spatialInputSchema = z.toJSONSchema(spatialInput, { io: "input" });

function pagedBoard(
  ops: WorkspaceOperations,
  input: z.infer<typeof sceneInput> | z.infer<typeof itemsInput>,
) {
  if (input.offset > 0 && input.revision === undefined)
    throw problem(
      400,
      "Укажите ревизию первой страницы",
      "BOARD_REVISION_REQUIRED",
    );
  return input.revision === undefined
    ? ops.board(input.id)
    : ops.boardAtRevision(input.id, input.revision);
}

function selectedItems<T extends { id: string }>(
  all: ReadonlyMap<string, T>,
  keys: readonly string[] | undefined,
) {
  const unique = new Set(keys);
  if (unique.size !== (keys?.length ?? 0))
    throw problem(
      400,
      "Укажите каждый объект только один раз",
      "DUPLICATE_BOARD_ITEM",
    );
  return [...unique].map((key) => {
    const item = all.get(key);
    if (!item)
      throw problem(404, "Объект доски не найден", "BOARD_ITEM_NOT_FOUND");
    return item;
  });
}

function byId<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item]));
}

// Tool replies are JSON text within a JSON envelope. Leave room for that
// envelope, including the JSON-RPC id and content fields.
const replyBytes = 47 * 1024;
const wireBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(JSON.stringify(value)));
function truncated(text: string, length: number) {
  const prefix = text.slice(0, length);
  return /[\uD800-\uDBFF]$/u.test(prefix) ? prefix.slice(0, -1) : prefix;
}

export function readBoardItems(ops: WorkspaceOperations, input: unknown) {
  const args = itemsInput.parse(input);
  if (!args.nodeIds?.length && !args.edgeIds?.length)
    throw problem(
      400,
      "Укажите идентификаторы блоков или связей",
      "BOARD_ITEMS_REQUIRED",
    );
  const board = pagedBoard(ops, args);
  const nodes = selectedItems(byId(board.document.nodes), args.nodeIds);
  const edges = selectedItems(byId(board.document.edges), args.edgeIds);
  const json = JSON.stringify({ nodes, edges });
  const offset = args.offset;
  if (
    offset > json.length ||
    (offset > 0 && /^[\uDC00-\uDFFF]/u.test(json.slice(offset, offset + 1)))
  )
    throw problem(400, "Неверное смещение фрагмента", "INVALID_BOARD_OFFSET");
  const makeReply = (end: number) => {
    const jsonChunk = truncated(json.slice(offset, end), end - offset);
    const next = offset + jsonChunk.length;
    return {
      id: board.id,
      revision: board.revision,
      offset,
      nextOffset: next < json.length ? next : null,
      totalLength: json.length,
      jsonChunk,
    };
  };

  // More code units never take fewer UTF-8 bytes, either before or after
  // JSON escaping. Binary search the largest safe prefix without splitting
  // an astral character across responses.
  let lo = offset;
  let hi = Math.min(json.length, offset + args.limit);
  while (lo < hi) {
    const end = Math.ceil((lo + hi) / 2);
    const reply = makeReply(end);
    if (
      Buffer.byteLength(reply.jsonChunk) <= args.limit &&
      wireBytes(reply) <= replyBytes
    )
      lo = end;
    else hi = end - 1;
  }
  return makeReply(lo);
}

function axisRelation(
  start: number,
  end: number,
  referenceStart: number,
  referenceEnd: number,
  before: string,
  after: string,
) {
  if (end <= referenceStart)
    return { side: before, gap: referenceStart - end, overlap: 0 };
  if (start >= referenceEnd)
    return { side: after, gap: start - referenceEnd, overlap: 0 };
  return {
    side: "overlap",
    gap: 0,
    overlap: Math.min(end, referenceEnd) - Math.max(start, referenceStart),
  };
}

function relation(box: VisualBounds, nodeId: string, ref: VisualBounds) {
  const x = axisRelation(box.x, box.right, ref.x, ref.right, "left", "right");
  const y = axisRelation(
    box.y,
    box.bottom,
    ref.y,
    ref.bottom,
    "above",
    "below",
  );
  return {
    nodeId,
    x: x.side,
    y: y.side,
    gapX: x.gap,
    gapY: y.gap,
    overlapX: x.overlap,
    overlapY: y.overlap,
  };
}

function compactEdge(edge: BoardEdge) {
  return {
    type: "edge" as const,
    id: edge.id,
    slideId: edge.slideId,
    title: edge.label ? truncated(edge.label, 100) : undefined,
    // Free endpoints have exact coordinates. Attached endpoints identify a
    // handle, whose rendered coordinates are resolved by the browser.
    source: edge.sourcePoint
      ? { point: edge.sourcePoint, handle: edge.sourceHandle }
      : { nodeId: edge.source, handle: edge.sourceHandle ?? "right" },
    target: edge.targetPoint
      ? { point: edge.targetPoint, handle: edge.targetHandle }
      : { nodeId: edge.target, handle: edge.targetHandle ?? "left" },
    path: edge.appearance?.path ?? "smoothstep",
    bend: edge.bend,
    startArrow: edge.appearance?.startArrow ?? false,
    endArrow: edge.appearance?.endArrow ?? true,
  };
}

export function readBoardScene(ops: WorkspaceOperations, input: unknown) {
  const args = sceneInput.parse(input);
  const board = pagedBoard(ops, args);
  const document = board.document;
  const kind = boardKind(document);
  const boardNodes = byId(document.nodes);
  const boardEdges = byId(document.edges);
  const focus = selectedItems(boardNodes, args.nodeIds);
  const focusEdges = selectedItems(boardEdges, args.edgeIds);
  const slideId = args.slideId ?? focus[0]?.slideId ?? focusEdges[0]?.slideId;
  const slide = document.slides?.find((slide) => slide.id === slideId);
  if (
    (slideId !== undefined && !slide) ||
    [...focus, ...focusEdges].some((item) => item.slideId !== slideId)
  )
    throw problem(
      404,
      "Слайд или объект на слайде не найден",
      "BOARD_SLIDE_NOT_FOUND",
    );

  const bounds = new Map<string, VisualBounds>();
  const nodeBounds = (node: BoardNode) => {
    const value = bounds.get(node.id) ?? getNodeVisualBounds(node);
    bounds.set(node.id, value);
    return value;
  };
  const relations = (node: BoardNode) =>
    focus
      .filter((reference) => reference.id !== node.id)
      .map((reference) =>
        relation(nodeBounds(node), reference.id, nodeBounds(reference)),
      )
      .sort((a, b) => Math.hypot(a.gapX, a.gapY) - Math.hypot(b.gapX, b.gapY));

  function compactNode(node: BoardNode) {
    const shape = node.data.kind === "shape" ? node.data.shape : undefined;
    return {
      type: "node" as const,
      id: node.id,
      slideId: node.slideId,
      kind: node.data.kind,
      title: truncated(node.data.title, 100),
      shape: shape?.type,
      bounds: nodeBounds(node),
      rotation: normalizeRotation(shape?.rotation ?? 0),
      // Patterned strokes may end before the nominal path endpoint.
      line: getNodeLineEndpoints(node),
      relations: focus.length ? relations(node).slice(0, 4) : undefined,
      textPreview:
        args.includeTextPreview && node.data.text
          ? truncated(node.data.text, 120)
          : undefined,
    };
  }
  const toSlide = (item: NonNullable<typeof slide>) => ({
    type: "slide" as const,
    id: item.id,
    title: truncated(item.title, 100),
  });
  type SceneItem = ReturnType<
    typeof compactNode | typeof compactEdge | typeof toSlide
  >;
  let candidateItems: (() => SceneItem)[];
  if (kind === "presentation" && !slide) {
    candidateItems = (document.slides ?? []).map((item) => () => toSlide(item));
  } else {
    const nodes = document.nodes.filter((node) => node.slideId === slideId);
    const edges = document.edges.filter((edge) => edge.slideId === slideId);
    if (focus.length || focusEdges.length) {
      const focusedIds = new Set(focus.map((node) => node.id));
      const links = [
        ...byId([
          ...focusEdges,
          ...edges.filter(
            (edge) =>
              (edge.source !== undefined && focusedIds.has(edge.source)) ||
              (edge.target !== undefined && focusedIds.has(edge.target)),
          ),
        ]).values(),
      ];
      const linkedIds = new Set(
        links.flatMap((edge) => [edge.source, edge.target]),
      );
      const nearby = focus.length
        ? nodes
            .filter(
              (node) => !focusedIds.has(node.id) && !linkedIds.has(node.id),
            )
            .map((node) => {
              const closest = relations(node)[0];
              return { node, distance: Math.hypot(closest.gapX, closest.gapY) };
            })
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 12)
            .map(({ node }) => node)
        : [];
      candidateItems = [
        ...focus.map((node) => () => compactNode(node)),
        ...links.map((edge) => () => compactEdge(edge)),
        ...nodes
          .filter((node) => linkedIds.has(node.id) && !focusedIds.has(node.id))
          .map((node) => () => compactNode(node)),
        ...nearby.map((node) => () => compactNode(node)),
      ];
    } else {
      candidateItems = [
        ...nodes.map((node) => () => compactNode(node)),
        ...edges.map((edge) => () => compactEdge(edge)),
      ];
    }
  }
  const totalItems = candidateItems.length;
  if (args.offset > totalItems)
    throw problem(400, "Неверное смещение страницы", "INVALID_BOARD_OFFSET");
  const items: SceneItem[] = [];
  let nextOffset: number | null = null;
  const result = {
    id: board.id,
    revision: board.revision,
    kind,
    name: truncated(board.name, 100),
    slideId,
    frame:
      kind === "presentation"
        ? { x: 0, y: 0, right: PRESENTATION_WIDTH, bottom: PRESENTATION_HEIGHT }
        : undefined,
    offset: args.offset,
    totalItems,
    items,
  };
  for (
    let cursor = args.offset;
    cursor < Math.min(totalItems, args.offset + args.limit);
    cursor++
  ) {
    items.push(candidateItems[cursor]());
    nextOffset = cursor + 1 === totalItems ? null : cursor + 1;
    if (wireBytes({ ...result, nextOffset }) > replyBytes) {
      items.pop();
      nextOffset = cursor;
      break;
    }
  }
  return { ...result, nextOffset };
}

function preservesPaintedOrder(
  original: BoardNode[],
  distributed: BoardNode[],
  axis: Axis,
) {
  const order = original
    .map((node) => ({ id: node.id, start: getNodeVisualBounds(node)[axis] }))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const starts = new Map(
    distributed.map((node) => [node.id, getNodeVisualBounds(node)[axis]]),
  );
  return order.every(
    ({ id }, index) =>
      index === 0 || starts.get(id)! + 1e-9 >= starts.get(order[index - 1].id)!,
  );
}

function checkShapeResize(
  node: BoardNode,
  { width, height }: { width?: number; height?: number },
) {
  if (node.data.kind !== "shape") return;
  const shape = resolveShape(node.data.shape);
  if (shape.type === "line") return;
  if (
    (width !== undefined && width < 40) ||
    (height !== undefined && height < 40) ||
    (width ?? node.width ?? 480) <= shape.strokeWidth ||
    (height ?? node.height ?? 300) <= shape.strokeWidth
  )
    throw problem(
      400,
      "Укажите для изменяемой стороны не менее 40, а для каждой стороны — больше толщины контура",
      "BOARD_SHAPE_TOO_SMALL",
    );
}

export function applyBoardSpatial(ops: WorkspaceOperations, input: unknown) {
  const args = spatialInput.parse(input);
  return ops.updateBoardGeometry(args, (current) => {
    const nodes = byId(current.document.nodes);
    const affected = new Set<string>();
    for (const op of args.operations) {
      const requested = "nodeIds" in op ? op.nodeIds : [op.id];
      const selected = selectedItems(nodes, requested);
      const anchor =
        op.type === "align" && op.anchorId !== undefined
          ? selectedItems(nodes, [op.anchorId])[0]
          : undefined;
      const dependencies = anchor ? [...selected, anchor] : selected;
      if (dependencies.some((node) => node.slideId !== selected[0].slideId))
        throw problem(
          400,
          "Пространственная операция ограничена одним слайдом",
          "BOARD_SLIDE_MISMATCH",
        );
      for (const node of dependencies) affected.add(node.id);
      if (affected.size > maxSpatialNodes)
        throw problem(
          400,
          "Слишком много объектов в одной операции доски",
          "TOO_MANY_BOARD_ITEMS",
        );
      let transformed: BoardNode[];
      switch (op.type) {
        case "align":
          if (
            anchor
              ? selected.every((node) => node.id === anchor.id)
              : selected.length < 2
          )
            throw problem(
              400,
              "Для выравнивания нужны разные объекты",
              "BOARD_ALIGNMENT_SELECTION",
            );
          transformed = alignBoardNodes(
            selected,
            new Set(requested),
            op.action,
            anchor,
          );
          break;
        case "distribute":
          transformed = alignBoardNodes(
            selected,
            new Set(requested),
            op.axis === "x" ? "distribute-x" : "distribute-y",
          );
          if (!preservesPaintedOrder(selected, transformed, op.axis))
            throw problem(
              400,
              "Недостаточно места для равных промежутков без изменения порядка блоков",
              "BOARD_DISTRIBUTION_SPAN",
            );
          break;
        case "move":
          transformed = selected.map((node) =>
            translateBoardNode(node, op.dx, op.dy),
          );
          break;
        case "place":
          transformed = [placeBoardNode(selected[0], op.x, op.y)];
          break;
        case "resize":
          if (op.width === undefined && op.height === undefined)
            throw problem(
              400,
              "Укажите ширину или высоту",
              "BOARD_RESIZE_DIMENSIONS",
            );
          checkShapeResize(selected[0], op);
          transformed = [resizeBoardNode(selected[0], op, op.anchor)];
          break;
      }
      for (const node of transformed) {
        if (
          Math.abs(node.position.x) > 1_000_000 ||
          Math.abs(node.position.y) > 1_000_000
        )
          throw problem(
            400,
            "Координаты выходят за пределы доски",
            "BOARD_COORDINATES_OUT_OF_RANGE",
          );
        nodes.set(node.id, node);
      }
    }
    ops.store.work.check(
      [...affected].map((id) => ({
        kind: "board-node",
        boardId: current.id,
        id,
      })),
    );
    return [...affected].map((id) => {
      const { position, width, height } = nodes.get(id)!;
      return { id, position, width, height };
    });
  });
}
