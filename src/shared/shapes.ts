import { z } from "zod";

export const SHAPE_OPTIONS = [
  { type: "rectangle", label: "Прямоугольник" },
  { type: "rounded-rectangle", label: "Скруглённый прямоугольник" },
  { type: "ellipse", label: "Эллипс" },
  { type: "triangle", label: "Треугольник" },
  { type: "diamond", label: "Ромб" },
  { type: "hexagon", label: "Шестиугольник" },
  { type: "arrow", label: "Стрелка" },
] as const;

export type ShapeKind = (typeof SHAPE_OPTIONS)[number]["type"];

const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const shapeSpecSchema = z
  .object({
    type: z.enum(SHAPE_OPTIONS.map(({ type }) => type)),
    fill: z.union([color, z.literal("transparent")]).optional(),
    stroke: color.optional(),
    strokeWidth: z.number().finite().min(0).max(12).optional(),
    strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    cornerRadius: z.number().finite().min(0).max(50).optional(),
    textColor: color.optional(),
    fontSize: z.number().finite().min(8).max(144).optional(),
    fontFamily: z.enum(["sans", "serif", "mono"]).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
  })
  .strict();

export type ShapeSpec = z.infer<typeof shapeSpecSchema>;

export function resolveShape(spec?: ShapeSpec): Required<ShapeSpec> {
  const type = spec?.type ?? "rectangle";
  return {
    type,
    fill: spec?.fill ?? "#dbeafe",
    stroke: spec?.stroke ?? "#3b82f6",
    strokeWidth: spec?.strokeWidth ?? 2,
    strokeStyle: spec?.strokeStyle ?? "solid",
    opacity: spec?.opacity ?? 1,
    cornerRadius: spec?.cornerRadius ?? (type === "rounded-rectangle" ? 16 : 0),
    textColor: spec?.textColor ?? "#172033",
    fontSize: spec?.fontSize ?? 24,
    fontFamily: spec?.fontFamily ?? "sans",
    bold: spec?.bold ?? false,
    italic: spec?.italic ?? false,
    underline: spec?.underline ?? false,
    textAlign: spec?.textAlign ?? "center",
    verticalAlign: spec?.verticalAlign ?? "middle",
  };
}
