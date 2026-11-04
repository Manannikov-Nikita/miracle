import { z } from "zod";

const field = z.string().min(1).max(10000);
const color = z.enum(["green", "yellow", "red", "blue", "purple"]);
const aggregate = z.enum(["sum", "avg", "min", "max", "count"]);
const numeric = z
  .string()
  .max(1100)
  .regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d{1,4})?$/i)
  .refine(
    (value) => Math.abs(Number(value.split(/[eE]/)[1] ?? 0)) <= 1000,
    "Слишком большой порядок числа",
  );
const column = z.object({
  label: z.string().max(200).optional(),
  hidden: z.boolean().optional(),
  width: z.number().int().min(80).max(800).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  format: z
    .enum([
      "auto",
      "number",
      "compact",
      "percent",
      "percent100",
      "currency",
      "date",
      "datetime",
      "duration",
      "text",
    ])
    .optional(),
  decimals: z.number().int().min(0).max(12).optional(),
  currency: z.enum(["RUB", "USD", "EUR"]).optional(),
  prefix: z.string().max(100).optional(),
  suffix: z.string().max(100).optional(),
  nullText: z.string().max(200).optional(),
  display: z.enum(["auto", "color-text", "color-background", "bar"]).optional(),
  thresholds: z
    .array(z.object({ value: numeric, color }))
    .max(12)
    .optional(),
  mappings: z
    .array(
      z.object({
        value: z.string().max(2000).nullable(),
        text: z.string().max(200),
        color: color.optional(),
      }),
    )
    .max(20)
    .optional(),
  summary: z.enum(["none", "sum", "avg", "min", "max", "count"]).optional(),
});
export const tableSpecSchema = z.object({
  version: z.literal(1),
  sourceSchema: z.string().max(1000000),
  columns: z
    .record(field, column)
    .refine(
      (value) => Object.keys(value).length <= 2000,
      "Слишком много столбцов",
    )
    .optional(),
  order: z.array(field).max(2000).optional(),
  filters: z
    .array(
      z.object({
        column: field,
        op: z.enum([
          "contains",
          "eq",
          "neq",
          "gt",
          "gte",
          "lt",
          "lte",
          "isNull",
          "notNull",
        ]),
        value: z.string().max(2000).optional(),
      }),
    )
    .max(20)
    .optional(),
  sort: z
    .object({ column: field, direction: z.enum(["asc", "desc"]) })
    .optional(),
  pivot: z
    .object({ row: field, column: field, value: field, aggregate })
    .optional(),
  density: z.enum(["compact", "comfortable"]).optional(),
  frozenColumns: z.number().int().min(0).max(3).optional(),
  wrap: z.boolean().optional(),
});
