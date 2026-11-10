import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  BOARD_IMAGE_MAX_BYTES,
  BOARD_IMAGE_MIME_TYPES,
  type BoardImage,
} from "../shared/board-images.js";
import { validImage } from "./image-validation.js";
import { problem, type ProjectStore } from "./project-store.js";

const inputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((name) => !/[\u0000-\u001f\u007f]/.test(name)),
    mimeType: z.enum(BOARD_IMAGE_MIME_TYPES),
    dataUrl: z.string().max(Math.ceil(BOARD_IMAGE_MAX_BYTES / 3) * 4 + 64),
  })
  .strict();

export function registerBoardImageRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  need: (req: FastifyRequest) => void,
) {
  app.post(
    "/api/board-images",
    { bodyLimit: Math.ceil(BOARD_IMAGE_MAX_BYTES / 3) * 4 + 4096 },
    async (req) => {
      need(req);
      const input = inputSchema.parse(req.body);
      const prefix = `data:${input.mimeType};base64,`;
      if (!input.dataUrl.startsWith(prefix))
        throw problem(400, "Некорректное изображение", "INVALID_BOARD_IMAGE");
      const encoded = input.dataUrl.slice(prefix.length);
      const bytes = Buffer.from(encoded, "base64");
      if (
        !bytes.length ||
        bytes.length > BOARD_IMAGE_MAX_BYTES ||
        bytes.toString("base64") !== encoded ||
        !validImage(bytes, input.mimeType)
      )
        throw problem(
          400,
          "Нужно изображение PNG, JPEG, GIF или WebP до 5 МиБ",
          "INVALID_BOARD_IMAGE",
        );
      const id = createHash("sha256").update(bytes).digest("hex");
      // Content-addressed project assets survive copying, undo and board deletion.
      store.db.query(
        "INSERT OR IGNORE INTO board_images(id,mime_type,bytes) VALUES(?1,?2,?3)",
        [id, input.mimeType, bytes],
      );
      return {
        id,
        name: input.name,
        mimeType: input.mimeType,
        size: bytes.length,
      } satisfies BoardImage;
    },
  );
  app.get("/api/board-images/:id", async (req, reply) => {
    need(req);
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse((req.params as { id: string }).id);
    const row = store.db.query(
      "SELECT mime_type,bytes FROM board_images WHERE id=?1",
      [id],
    ).rows[0];
    if (!row) throw problem(404, "Изображение не найдено");
    return reply
      .type(row.mime_type)
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(Buffer.from(row.bytes));
  });
}
