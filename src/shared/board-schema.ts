import { z } from "zod";
import { tableSpecSchema } from "./table-schema.js";
import { dateRangeDates } from "./date-batch.js";
import { customChartSchema } from "./custom-chart-schema.js";
import {
  CHART_SERIES_COLOR_KEY_LIMIT,
  CHART_SERIES_COLOR_LIMIT,
} from "./chart-appearance.js";
export const dateRangeSchema = z
  .object({
    startDate: z.string(),
    endDate: z.string(),
    granularity: z.enum(["day", "week", "month"]),
    weekStartsOn: z.enum(["monday", "sunday"]).optional(),
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
const identifier = z.string().min(1).max(200);
const finite = z.number().finite().min(-1000000).max(1000000);
export const chartSpecSchema = z.object({
  kind: z.enum(["bar", "line", "area", "scatter"]),
  orientation: z.enum(["vertical", "horizontal"]).optional(),
  x: z.string().max(200),
  y: z.array(z.string().max(200)).max(20),
  series: z.string().max(200).optional(),
  stacked: z.boolean().optional(),
  legend: z.boolean(),
  legendPosition: z.enum(["top", "bottom", "left", "right"]).optional(),
  legendAlign: z.enum(["start", "center", "end"]).optional(),
  showXAxis: z.boolean().optional(),
  showYAxis: z.boolean().optional(),
  showGrid: z.boolean().optional(),
  showLabels: z.boolean().optional(),
  labelPosition: z.enum(["auto", "outside", "inside"]).optional(),
  palette: z.enum(["default", "cool", "warm", "vivid"]).optional(),
  seriesColors: z
    .record(
      z.string().min(1).max(CHART_SERIES_COLOR_KEY_LIMIT),
      z.string().regex(/^#[0-9a-fA-F]{6}$/),
    )
    .refine(
      (colors) => Object.keys(colors).length <= CHART_SERIES_COLOR_LIMIT,
      "Не более 5 000 цветов серий",
    )
    .optional(),
  xLabel: z.string().max(200).optional(),
  yLabel: z.string().max(200).optional(),
  numberFormat: z
    .enum(["auto", "integer", "decimal", "percent", "compact"])
    .optional(),
  sort: z.enum(["none", "asc", "desc"]).optional(),
});
export const boardEdgeAppearanceSchema = z
  .object({
    path: z.enum(["smoothstep", "straight", "bezier"]).optional(),
    line: z.enum(["solid", "dashed", "dotted"]).optional(),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    width: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    startArrow: z.boolean().optional(),
    endArrow: z.boolean().optional(),
  })
  .strict();
export const boardEdgePointSchema = z.object({ x: finite, y: finite }).strict();
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
              view: z.enum(["table", "chart", "custom"]).optional(),
              chart: chartSpecSchema.optional(),
              customChart: customChartSchema.optional(),
              visibleColumns: z.array(z.string().max(200)).max(2000).optional(),
              table: tableSpecSchema.optional(),
            })
            .passthrough(),
        }),
      )
      .max(200),
    edges: z
      .array(
        z
          .object({
            id: identifier,
            source: identifier.optional(),
            target: identifier.optional(),
            sourcePoint: boardEdgePointSchema.optional(),
            targetPoint: boardEdgePointSchema.optional(),
            bend: boardEdgePointSchema.optional(),
            sourceHandle: z.enum(["top", "right", "bottom", "left"]).optional(),
            targetHandle: z.enum(["top", "right", "bottom", "left"]).optional(),
            label: z.string().max(500).optional(),
            labelPosition: z.number().finite().min(0).max(1).optional(),
            appearance: boardEdgeAppearanceSchema.optional(),
          })
          .superRefine((edge, context) => {
            for (const end of ["source", "target"] as const) {
              const point = end === "source" ? "sourcePoint" : "targetPoint";
              if ((edge[end] !== undefined) === (edge[point] !== undefined))
                context.addIssue({
                  code: "custom",
                  path: [end],
                  message:
                    "Для каждого конца стрелки нужен либо блок, либо координаты",
                });
            }
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
      if (
        (e.source !== undefined && !ids.has(e.source)) ||
        (e.target !== undefined && !ids.has(e.target))
      )
        ctx.addIssue({
          code: "custom",
          message: "Связь ссылается на отсутствующий блок",
        });
    for (const n of d.nodes) {
      if (
        (n.data.view === "custom" || n.data.customChart !== undefined) &&
        n.data.kind !== "result"
      )
        ctx.addIssue({
          code: "custom",
          message: "Кастомному графику нужен блок результата SQL",
        });
      if (n.data.view === "custom" && !n.data.customChart)
        ctx.addIssue({
          code: "custom",
          message: "Для кастомного графика нужны исходники версии 1",
        });
      if (n.data.kind === "result" && (!n.data.resultSetId || !n.data.source))
        ctx.addIssue({
          code: "custom",
          message: "Результату нужны snapshot и SQL",
        });
    }
  });
