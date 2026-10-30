import { z } from "zod";
import { clickhouseOptionsSchema } from "./clickhouseOptions.js";
import { tableSpecSchema } from "./tableValidation.js";
import { dateRangeDates } from "../shared/date-batch.js";
export const dateRangeSchema = z
  .object({
    startDate: z.string(),
    endDate: z.string(),
    granularity: z.enum(["day", "week", "month"]),
    retries: z.number().int().min(0).max(10),
  })
  .strict()
  .superRefine((range, context) => {
    try {
      dateRangeDates(range);
    } catch (error) {
      context.addIssue({ code: "custom", message: (error as Error).message });
    }
  });
export const sourceSchema = z.object({
  dateRange: dateRangeSchema.optional(),
  connectionId: z.uuid(),
  sql: z.string().min(1).max(1000000),
  database: z.string().max(200).optional(),
  catalog: z.string().max(200).optional(),
  schema: z.string().max(200).optional(),
});
export const connectionSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    engine: z.enum(["clickhouse", "trino"]),
    url: z.string().max(2000),
    username: z.string().max(200),
    password: z.string().max(10000).optional(),
    database: z.string().max(200).optional(),
    catalog: z.string().max(200).optional(),
    schema: z.string().max(200).optional(),
    clickhouse: clickhouseOptionsSchema.optional(),
  })
  .strict();
const identifier = z.string().min(1).max(200);
const finite = z.number().finite().min(-1000000).max(1000000);
const chart = z.object({
  kind: z.enum(["bar", "line", "area", "scatter"]),
  orientation: z.enum(["vertical", "horizontal"]).optional(),
  x: z.string().max(200),
  y: z.array(z.string().max(200)).max(20),
  series: z.string().max(200).optional(),
  stacked: z.boolean().optional(),
  legend: z.boolean(),
  legendPosition: z.enum(["top", "bottom", "left", "right"]).optional(),
  legendAlign: z.enum(["start", "center", "end"]).optional(),
  xLabel: z.string().max(200).optional(),
  yLabel: z.string().max(200).optional(),
  numberFormat: z
    .enum(["auto", "integer", "decimal", "percent", "compact"])
    .optional(),
  sort: z.enum(["none", "asc", "desc"]).optional(),
});
export const boardDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z
      .array(
        z.object({
          id: identifier,
          type: z.literal("artifact"),
          position: z.object({ x: finite, y: finite }),
          width: z.number().positive().max(10000).optional(),
          height: z.number().positive().max(10000).optional(),
          data: z
            .object({
              title: z.string().max(500),
              kind: z.enum(["result", "note", "markdown"]),
              text: z.string().max(200000).optional(),
              color: z.string().max(100).optional(),
              resultSetId: z.uuid().optional(),
              source: sourceSchema.optional(),
              sourceRevision: z.number().int().nonnegative().optional(),
              view: z.enum(["table", "chart"]).optional(),
              chart: chart.optional(),
              visibleColumns: z.array(z.string().max(200)).max(2000).optional(),
              table: tableSpecSchema.optional(),
            })
            .passthrough(),
        }),
      )
      .max(200),
    edges: z
      .array(
        z.object({
          id: identifier,
          source: identifier,
          target: identifier,
          sourceHandle: z.enum(["top", "right", "bottom", "left"]).optional(),
          targetHandle: z.enum(["top", "right", "bottom", "left"]).optional(),
          label: z.string().max(500).optional(),
        }),
      )
      .max(500),
    viewport: z
      .object({ x: finite, y: finite, zoom: z.number().min(0.05).max(10) })
      .optional(),
  })
  .superRefine((d, ctx) => {
    const ids = new Set(d.nodes.map((n) => n.id));
    if (ids.size !== d.nodes.length)
      ctx.addIssue({ code: "custom", message: "Повторяющийся id блока" });
    if (new Set(d.edges.map((e) => e.id)).size !== d.edges.length)
      ctx.addIssue({ code: "custom", message: "Повторяющийся id связи" });
    for (const e of d.edges)
      if (!ids.has(e.source) || !ids.has(e.target))
        ctx.addIssue({
          code: "custom",
          message: "Связь ссылается на отсутствующий блок",
        });
    for (const n of d.nodes)
      if (n.data.kind === "result" && (!n.data.resultSetId || !n.data.source))
        ctx.addIssue({
          code: "custom",
          message: "Результату нужны snapshot и SQL",
        });
  });
