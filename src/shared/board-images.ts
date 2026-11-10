import { z } from "zod";

export const BOARD_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const BOARD_IMAGE_MAX_COUNT = 10;
export const BOARD_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export const boardImageSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    name: z.string().trim().min(1).max(255),
    mimeType: z.enum(BOARD_IMAGE_MIME_TYPES),
    size: z.number().int().positive().max(BOARD_IMAGE_MAX_BYTES),
    alt: z.string().max(2000).optional(),
    fit: z.enum(["contain", "cover"]).optional(),
  })
  .strict();
export type BoardImage = z.infer<typeof boardImageSchema>;
export const boardImageUrl = (id: string) =>
  `/api/board-images/${encodeURIComponent(id)}`;
