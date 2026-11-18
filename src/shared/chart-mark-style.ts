import { z } from "zod";
import {
  CHART_MARK_RULE_LIMIT,
  CHART_SERIES_COLOR_KEY_LIMIT,
  CHART_SERIES_COLOR_LIMIT,
} from "./chart-appearance.js";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const seriesKey = z.string().min(1).max(CHART_SERIES_COLOR_KEY_LIMIT);
const markStyleSchema = z.strictObject({
  color: color.optional(),
  opacity: z.number().min(0).max(1).optional(),
  borderColor: color.optional(),
  borderWidth: z.number().min(0).max(8).optional(),
  borderStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  pattern: z.enum(["none", "diagonal", "crosshatch", "dots"]).optional(),
});

const comparison = {
  op: z.enum(["eq", "ne", "gt", "gte", "lt", "lte"]),
  value: z.union([
    z.string().max(10000),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ]),
};
const markConditionSchema = z.discriminatedUnion("field", [
  z.strictObject({
    field: z.literal("position"),
    op: z.enum(["first", "last"]),
  }),
  z.strictObject({ field: z.enum(["x", "value"]), ...comparison }),
  z.strictObject({
    field: z.literal("column"),
    columnId: z.string().min(1).max(200),
    ...comparison,
  }),
]);
const markRuleSchema = z.strictObject({
  seriesKey: seriesKey.optional(),
  when: markConditionSchema,
  style: markStyleSchema,
});
export const chartSeriesStylesSchema = z
  .record(seriesKey, markStyleSchema)
  .refine(
    (styles) => Object.keys(styles).length <= CHART_SERIES_COLOR_LIMIT,
    "Не более 5 000 стилей серий",
  );
export const chartMarkRulesSchema = z
  .array(markRuleSchema)
  .max(CHART_MARK_RULE_LIMIT);

export type ChartMarkStyle = z.infer<typeof markStyleSchema>;
export type ChartMarkCondition = z.infer<typeof markConditionSchema>;
export type ChartMarkRule = z.infer<typeof markRuleSchema>;
