import { z } from "zod";
import { CUSTOM_CHART_LIMITS as limits } from "./custom-charts.js";

const utf8 = new TextEncoder();

export const customChartSchema = z
  .object({
    version: z.literal(1),
    description: z.string().max(limits.description),
    html: z.string().max(limits.html),
    css: z.string().max(limits.css),
    javascript: z.string().max(limits.javascript),
  })
  .strict()
  .superRefine((spec, context) => {
    const bytes = [spec.html, spec.css, spec.javascript].reduce(
      (size, source) => size + utf8.encode(source).byteLength,
      0,
    );
    if (bytes > limits.sourceBytes)
      context.addIssue({
        code: "custom",
        message: "Исходники кастомного графика превышают 256 KiB",
      });
  });
