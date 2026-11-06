import { z } from "zod";

export const textStyleSchema = z
  .object({
    textColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
    fontSize: z.number().finite().min(8).max(144).optional(),
    fontFamily: z.enum(["sans", "serif", "mono"]).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  })
  .strict();

export type TextStyleSpec = z.infer<typeof textStyleSchema>;

export function resolveTextStyle(
  style?: TextStyleSpec,
): Required<TextStyleSpec> {
  return {
    textColor: style?.textColor ?? "#172033",
    fontSize: style?.fontSize ?? 32,
    fontFamily: style?.fontFamily ?? "sans",
    bold: style?.bold ?? false,
    italic: style?.italic ?? false,
    underline: style?.underline ?? false,
    textAlign: style?.textAlign ?? "left",
    verticalAlign: style?.verticalAlign ?? "top",
  };
}
