import { z } from "zod";
import { clickhouseOptionsSchema } from "./clickhouseOptions.js";
import { trinoOptionsSchema } from "./trinoOptions.js";
export {
  dateRangeSchema,
  sourceSchema,
  boardEdgeAppearanceSchema,
  boardEdgePointSchema,
  boardDocumentSchema,
} from "../shared/board-schema.js";
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
    trino: trinoOptionsSchema.optional(),
  })
  .strict();
