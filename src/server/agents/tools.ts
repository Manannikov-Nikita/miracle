import { z } from "zod";
import { customChartGuide } from "../custom-chart-guide.js";
import { chartGuide, chartInputSchema } from "../chart-guide.js";
import { boardKindSchema, sourceSchema } from "../validation.js";
import { problem } from "../project-store.js";
import type { AgentManager, ActiveAgent } from "./manager.js";
import { entityWorkInput } from "./entity-work.js";
import { shapeSpecSchema } from "../../shared/shapes.js";
import { textStyleSchema } from "../../shared/text-style.js";

const shapeGuide =
  "Shapes use data {title,kind:'shape',text,shape:{type,...}}. Shape type is rectangle|rounded-rectangle|ellipse|triangle|diamond|hexagon|arrow|line. A line is a standalone visual shape node, not an edge; it has no connection handles. Line fields: lineDirection (horizontal|vertical|diagonal-down|diagonal-up), lineStart/lineEnd (none|arrow). Defaults are horizontal with no arrowheads; set lineEnd:arrow for an arrow. Use width/height to control length and diagonal slope; fill and text are not rendered for lines. Optional shape fields: rotation (0–360 degrees clockwise around the shape center; default 0), fill (#RRGGBB or transparent), stroke/textColor (#RRGGBB), strokeWidth (0-12), strokeStyle (solid|dashed|dotted), opacity (0-1), cornerRadius (0-50 percent), fontSize (8-144), fontFamily (sans|serif|mono), bold/italic/underline (boolean), textAlign (left|center|right), verticalAlign (top|middle|bottom). Shape text is plain text, up to 200000 characters; do not supply SVG or HTML markup as geometry. Use node width/height to resize; interactive shapes have a 40×40 minimum.";
const textGuide =
  " Standalone text blocks have no container and use data {title,kind:'text',text,textStyle:{...}}. Text is plain multiline text, up to 200000 characters. Optional textStyle fields: textColor (#RRGGBB), fontSize (8-144), fontFamily (sans|serif|mono), bold/italic/underline (boolean), textAlign (left|center|right), verticalAlign (top|middle|bottom). Settings apply to the whole block. Choose textColor with sufficient contrast against the board or slide background.";

const string = { type: "string" };
const integer = { type: "integer", minimum: 0 };
const object = { type: "object" };
const id = { type: "string", format: "uuid" };
const kind = { type: "string", enum: ["board", "presentation"] };
const slideProperties = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  background: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
};
const mutation = { baseRevision: integer, mutationId: id };
const entityTargets = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [
          "editor",
          "query",
          "file",
          "board",
          "board-node",
          "board-edge",
          "board-slide",
        ],
      },
      id: string,
      boardId: id,
    },
    required: ["kind", "id"],
    additionalProperties: false,
  },
};
const nodePatchSchema = {
  type: "object",
  properties: {
    position: {
      type: "object",
      properties: {
        x: { type: "number", minimum: -1000000, maximum: 1000000 },
        y: { type: "number", minimum: -1000000, maximum: 1000000 },
      },
      required: ["x", "y"],
    },
    width: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 10000,
      description:
        "Node width in board coordinates. For proportional resizing set width and height together; read chart_guide.",
    },
    height: {
      type: "number",
      exclusiveMinimum: 0,
      maximum: 10000,
      description: "Node height in board coordinates.",
    },
    data: {
      type: "object",
      properties: {
        title: string,
        kind: {
          type: "string",
          enum: ["result", "note", "markdown", "shape", "text"],
        },
        text: { type: "string", maxLength: 200000 },
        textStyle: {
          ...z.toJSONSchema(textStyleSchema),
          description:
            "Complete standalone text typography. Replaces the previous textStyle object; preserve unchanged settings from read_board.",
        },
        shape: {
          ...z.toJSONSchema(shapeSpecSchema),
          description:
            "Complete shape settings, including type. Replaces the previous shape object; preserve unchanged settings from read_board.",
        },
        view: { type: "string", enum: ["table", "chart", "custom"] },
        chart: chartInputSchema,
        table: object,
        customChart: object,
        resultSetId: id,
        source: object,
      },
      additionalProperties: true,
    },
  },
  // The same envelope is used by update_edge and update_slide.
  additionalProperties: true,
};
const textPaging = {
  offset: integer,
  limit: { type: "integer", minimum: 1, maximum: 64000 },
};
const responseLimit = 512000;
function textPage(text: string, args: Record<string, unknown>) {
  const offset = z
    .number()
    .int()
    .nonnegative()
    .max(1000000000)
    .default(0)
    .parse(args.offset);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(64000)
    .default(64000)
    .parse(args.limit);
  const value = text.slice(offset, offset + limit);
  return {
    value,
    offset,
    totalLength: text.length,
    nextOffset:
      offset + value.length < text.length ? offset + value.length : null,
  };
}
function sqlPage<T extends { sql: string }>(
  document: T,
  args: Record<string, unknown>,
) {
  const page = textPage(document.sql, args);
  return {
    ...document,
    sql: page.value,
    sqlOffset: page.offset,
    sqlLength: page.totalLength,
    nextOffset: page.nextOffset,
  };
}
function compactResult(result: unknown, name: string) {
  const value = result as Record<string, unknown>;
  // A completed mutation must remain successful even when its full document is too large for a tool response.
  const fields = [
    "id",
    "name",
    "revision",
    "updatedAt",
    "status",
    "resultSetId",
    "rowCount",
    "startedAt",
    "finishedAt",
  ];
  const receipt: Record<string, unknown> = { compact: true };
  for (const key of fields)
    if (value[key] !== undefined) receipt[key] = value[key];
  if (["create_editor", "edit_editor"].includes(name))
    receipt.readWith = {
      tool: "read_editor",
      arguments: { id: value.id, offset: 0 },
    };
  else if (name === "save_query")
    receipt.readWith = {
      tool: "read_query",
      arguments: { id: value.id, offset: 0 },
    };
  else if (["create_board", "board_patch", "read_board"].includes(name))
    receipt.readWith = {
      tool: "read_board",
      arguments: { id: value.id, format: "json", offset: 0 },
    };
  return receipt;
}
const documentFields = {
  name: string,
  sql: string,
  connectionId: string,
  database: string,
  catalog: string,
  schema: string,
  dateRange: object,
};
const tool = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  readOnlyHint = true,
) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
  annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false },
});
export const miracleTools = [
  tool(
    "begin_entity_work",
    "Before reading an entity for editing, claim the exact entities you will work on. Use board-node/board-edge with boardId for blocks and links; board-slide with boardId and the slide id for slide metadata; board for the name and slide list/order. Slide deletion also touches its blocks and links. File id is a project-relative path; claim before native file writes. Read fresh content after claiming. Locks remain until end_entity_work or task end.",
    { entities: entityTargets },
    ["entities"],
    false,
  ),
  tool(
    "end_entity_work",
    "Release the exact entities whose work is complete, including their linked aliases. Other work remains locked.",
    { entities: entityTargets },
    ["entities"],
    false,
  ),
  tool(
    "project_context",
    "Read project and task target IDs. Focus changes in the browser do not retarget this task.",
  ),
  tool(
    "list_connections",
    "List connection names, IDs and public SQL context. Credentials are never returned.",
  ),
  tool(
    "read_schema",
    "Read paginated schemas, tables or columns from a connection. Tables/columns require schema; continue with nextCursor.",
    {
      connectionId: id,
      kind: { type: "string", enum: ["schemas", "tables", "columns"] },
      schema: string,
      table: string,
      catalog: string,
      cursor: string,
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
    ["connectionId"],
  ),
  tool(
    "list_editors",
    "List current server-persisted SQL documents and revisions.",
  ),
  tool(
    "read_editor",
    "Read SQL, source context and revision. SQL is chunked by UTF-16 character offset/limit (default/max 64000); follow nextOffset until null. Check revision remains unchanged across pages.",
    { id, ...textPaging },
    ["id"],
  ),
  tool(
    "create_editor",
    "Open a SQL document, also available when browser reconnects. Required id UUID identifies this creation and deduplicates retries. Large mutations return a compact id/revision receipt; use read_editor for SQL.",
    { id, ...documentFields },
    ["id", "name", "sql", "connectionId"],
    false,
  ),
  tool(
    "edit_editor",
    "Update SQL/document fields at expected revision. Stale versions fail; read again before retrying. mutationId must be a fresh UUID per operation.",
    { id, ...mutation, ...documentFields },
    ["id", "baseRevision", "mutationId"],
    false,
  ),
  tool(
    "list_queries",
    "List saved query metadata and SQL lengths without full SQL; use read_query for content.",
  ),
  tool(
    "read_query",
    "Read a saved query and revision. SQL is chunked by UTF-16 character offset/limit (default/max 64000); follow nextOffset until null. Check revision remains unchanged across pages.",
    { id, ...textPaging },
    ["id"],
  ),
  tool(
    "save_query",
    "Create/update a saved query. For update provide id and baseRevision. mutationId deduplicates retries.",
    { id, ...mutation, ...documentFields },
    ["name", "sql", "connectionId", "mutationId"],
    false,
  ),
  tool(
    "run_query",
    "Start one read-only SQL query or date batch under normal limits. Poll query_status, then read_result. Retrying the same mutationId never executes again.",
    { ...documentFields, mutationId: id },
    ["sql", "connectionId", "mutationId"],
    false,
  ),
  tool("query_status", "Read query status and resultSetId.", { id }, ["id"]),
  tool(
    "cancel_query",
    "Cancel a query in this project.",
    { id },
    ["id"],
    false,
  ),
  tool(
    "read_result",
    "Read bounded result rows (default 100, maximum 500) and columns; continue with offset. Source metadata includes sqlLength rather than full SQL.",
    {
      id,
      offset: integer,
      limit: { type: "integer", minimum: 1, maximum: 500 },
    },
    ["id"],
  ),
  tool(
    "list_boards",
    "List board and presentation IDs, names, kinds and revisions. Supply kind to filter.",
    { kind },
  ),
  tool(
    "read_board",
    "Read a board and revision. Large boards return a compact receipt. For any board, format json returns exact document JSON in UTF-16 character offset/limit chunks (default/max 64000); concatenate json fields until nextOffset is null and parse. Check revision remains unchanged across pages.",
    {
      id,
      revision: integer,
      format: { type: "string", enum: ["document", "json"] },
      ...textPaging,
    },
    ["id"],
  ),
  tool(
    "create_board",
    "Create a named board or presentation. A new presentation starts with one slide unless a full document is supplied. Optional document uses schemaVersion 1 and flat nodes and edges arrays. A presentation document has kind:'presentation' and ordered slides [{id,title,background}], and every node and edge has slideId. For nodes: type artifact, position {x,y}, data {title,kind: result|note|markdown|shape|text}; result nodes reference resultSetId. Use mutationId UUID. " +
      shapeGuide +
      textGuide,
    { name: string, kind, document: object, mutationId: id },
    ["name", "mutationId"],
    false,
  ),
  tool(
    "board_patch",
    "Apply atomic board or presentation operations at expected revision. Types: add_node {node}, update_node {id,patch:{position,width,height,data}}, remove_node {id}, add_edge {edge}, update_edge {id,patch}, remove_edge {id}. Presentations also support add_slide {slide:{id,title,background}}, update_slide {id,patch:{title?,background?}}, remove_slide {id} (includes children), reorder_slides {slideIds} (a complete permutation). Use slideId on every new presentation node and edge, including free-ended links; an edge cannot span slides. Presentation coordinates are 1600×900. Standard chart controls include showXAxis/showYAxis/showGrid, showLabels/labelPosition, palette/seriesColors, orientation, stacking, legend and number formatting. Read chart_guide for exact controls, color keys and proportional width/height resizing. Read custom_chart_guide before creating custom source. Data is merged one level only: chart/table/customChart/shape/textStyle are replaced as complete objects; read_board and preserve their unchanged fields. " +
      shapeGuide +
      textGuide,
    {
      id,
      ...mutation,
      name: string,
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "add_node",
                "update_node",
                "remove_node",
                "add_edge",
                "update_edge",
                "remove_edge",
                "add_slide",
                "update_slide",
                "remove_slide",
                "reorder_slides",
              ],
            },
            id: string,
            patch: nodePatchSchema,
            node: object,
            edge: object,
            slide: {
              type: "object",
              properties: { id: string, ...slideProperties },
              required: ["id", "title", "background"],
              additionalProperties: false,
            },
            slideIds: { type: "array", maxItems: 100, items: string },
          },
          required: ["type"],
        },
        maxItems: 200,
      },
    },
    ["id", "baseRevision", "mutationId", "operations"],
    false,
  ),
  tool(
    "chart_guide",
    "Read standard chart controls: axes, auxiliary grid lines, value labels, palettes and individual series colors; binding, defaults, full chart replacement, and proportional block resizing via width/height. Use before editing standard chart settings or chart dimensions.",
  ),
  tool(
    "custom_chart_guide",
    "Read the exact custom chart v1 runtime, data binding, SVG example, resize/events/cleanup, limits and diagnostic workflow. Use before creating or editing programmable chart source.",
  ),
  tool(
    "read_custom_chart_status",
    "Read current browser diagnostics. Aggregate status covers all fresh observations; reports are paged (default10/max20). Follow nextOffset until null and inspect total. not_observed means no browser confirmation; rendered means initialization completed, not visual correctness.",
    {
      id,
      nodeId: string,
      offset: integer,
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    ["id", "nodeId"],
  ),
  tool(
    "refresh_node",
    "Run the SQL source pinned to a board node. On completion attach the resulting snapshot with board_patch; existing result remains until then.",
    { id, nodeId: string, sourceRevision: integer, mutationId: id },
    ["id", "nodeId", "sourceRevision", "mutationId"],
    false,
  ),
  tool(
    "permission_prompt",
    "Native Claude runtime permission callback; do not call as part of a task.",
    { tool_name: string, input: object },
    [],
    false,
  ),
];

export async function callMiracleTool(
  manager: AgentManager,
  active: ActiveAgent,
  name: string,
  input: unknown,
) {
  return manager.store.work.runAs(
    {
      turnId: active.turn.id,
      chatId: active.turn.chatId,
      isActive: () =>
        manager.active === active &&
        !active.cancelled &&
        ["running", "waiting"].includes(
          manager.store.turn(active.turn.id).status,
        ),
    },
    () => executeMiracleTool(manager, active, name, input),
  );
}

async function executeMiracleTool(
  manager: AgentManager,
  active: ActiveAgent,
  name: string,
  input: unknown,
) {
  manager.store.work.assertActor();
  if (manager.active !== active || active.cancelled)
    throw problem(401, "Agent task is no longer active");
  const args = z.record(z.string(), z.unknown()).parse(input || {});
  const key = () => z.uuid().parse(args.id);
  const store = manager.store,
    ops = manager.operations,
    services = manager.services;
  let result: unknown;
  switch (name) {
    case "begin_entity_work": {
      const { entities } = entityWorkInput.parse(args);
      result = store.work.begin(entities);
      break;
    }
    case "end_entity_work":
      result = store.work.end(entityWorkInput.parse(args).entities);
      break;
    case "project_context":
      result = { ...store.context, targets: active.turn.context };
      break;
    case "list_connections":
      result = services.connections();
      break;
    case "read_schema":
      result = await services.schema(z.uuid().parse(args.connectionId), args);
      break;
    case "list_editors":
      result = store.editors().map((d) => ({
        id: d.id,
        name: d.name,
        revision: d.revision,
        connectionId: d.connectionId,
      }));
      break;
    case "read_editor":
      result = sqlPage(store.editor(key()), args);
      break;
    case "create_editor":
      key();
      result = store.createEditor(args);
      break;
    case "edit_editor":
      result = store.updateEditor(key(), args);
      break;
    case "list_queries":
      result = ops.queries().map(({ sql, ...metadata }) => ({
        ...metadata,
        sqlLength: sql.length,
      }));
      break;
    case "read_query":
      result = sqlPage(ops.query(key()), args);
      break;
    case "save_query":
      z.uuid().parse(args.mutationId);
      result = await ops.saveQuery(
        args,
        args.id === undefined ? undefined : key(),
      );
      break;
    case "run_query": {
      const run = await services.run(
        sourceSchema.parse(args),
        z.uuid().parse(args.mutationId),
      );
      active.runIds.add(run.id);
      result = run;
      break;
    }
    case "query_status":
      result = services.status(key());
      break;
    case "cancel_query":
      result = services.cancel(key());
      break;
    case "read_result": {
      const id = key(),
        offset = z
          .number()
          .int()
          .min(0)
          .max(100000000)
          .default(0)
          .parse(args.offset),
        limit = z.number().int().min(1).max(500).default(100).parse(args.limit);
      const meta = await services.result(id);
      const rows = await services.rows(id, offset, limit);
      result = {
        result: {
          ...meta,
          source: {
            ...meta.source,
            sql: undefined,
            sqlLength: meta.source.sql.length,
          },
        },
        rows,
        offset,
        total: meta.rowCount,
        nextOffset:
          offset + rows.length < meta.rowCount ? offset + rows.length : null,
      };
      break;
    }
    case "list_boards":
      result = ops.boards(boardKindSchema.optional().parse(args.kind));
      break;
    case "read_board": {
      const board =
        args.revision === undefined
          ? ops.board(key())
          : ops.boardAtRevision(
              key(),
              z.number().int().nonnegative().parse(args.revision),
            );
      const format = z
        .enum(["document", "json"])
        .default("document")
        .parse(args.format);
      if (format === "json") {
        const { document, ...metadata } = board;
        const { value, ...page } = textPage(JSON.stringify(document), args);
        result = { ...metadata, format, json: value, ...page };
      } else result = board;
      break;
    }
    case "create_board":
      z.uuid().parse(args.mutationId);
      result = ops.createBoard(args);
      break;
    case "board_patch":
      result = ops.patchBoard(key(), args);
      break;
    case "custom_chart_guide":
      result = customChartGuide;
      break;
    case "chart_guide":
      result = chartGuide;
      break;
    case "read_custom_chart_status": {
      const status = ops.customChartStatus(
        key(),
        z.string().min(1).max(200).parse(args.nodeId),
      );
      const offset = z
        .number()
        .int()
        .min(0)
        .max(1000000000)
        .default(0)
        .parse(args.offset);
      const limit = z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(10)
        .parse(args.limit);
      const reports = status.reports.slice(offset, offset + limit);
      result = {
        status: status.status,
        reports,
        offset,
        total: status.reports.length,
        nextOffset:
          offset + reports.length < status.reports.length
            ? offset + reports.length
            : null,
      };
      break;
    }
    case "refresh_node": {
      const board = ops.board(key()),
        node = board.document.nodes.find(
          (n) => n.id === z.string().parse(args.nodeId),
        );
      if (!node?.data.source) throw problem(400, "У блока нет источника SQL");
      if (
        (node.data.sourceRevision ?? 0) !==
        z.number().int().nonnegative().parse(args.sourceRevision)
      )
        throw problem(409, "Источник блока изменён", "REVISION_CONFLICT");
      const run = await services.run(
        node.data.source,
        z.uuid().parse(args.mutationId),
      );
      active.runIds.add(run.id);
      result = run;
      break;
    }
    case "permission_prompt":
      return manager.requestPermission(active, args);
    default:
      throw problem(404, "Unknown Miracle tool");
  }
  store.work.assertActor();
  if (manager.active !== active || active.cancelled)
    throw problem(401, "Agent task ended during tool call");
  store.message(active.turn.chatId, active.turn.id, "action", name, {
    tool: name,
  });
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > responseLimit) {
    if (
      result &&
      typeof result === "object" &&
      "id" in result &&
      [
        "create_editor",
        "edit_editor",
        "save_query",
        "run_query",
        "query_status",
        "cancel_query",
        "create_board",
        "board_patch",
        "read_board",
        "refresh_node",
      ].includes(name)
    )
      return compactResult(result, name);
    throw problem(
      413,
      "Результат инструмента слишком велик. Запросите меньший объём данных.",
    );
  }
  return result;
}
