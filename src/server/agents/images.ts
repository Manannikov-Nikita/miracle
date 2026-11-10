import { validImage } from "../image-validation.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AGENT_IMAGE_MAX_BYTES,
  AGENT_IMAGE_MAX_COUNT,
  AGENT_IMAGE_MIME_TYPES,
  type AgentImageAttachment,
  type AgentImageMimeType,
} from "../../shared/agents.js";
import { problem, type ProjectStore } from "../project-store.js";

export interface AgentProviderImage {
  name: string;
  mimeType: AgentImageMimeType;
  data: string;
}
export const agentImagesSchema = z
  .array(
    z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .refine((name) => !/[\u0000-\u001f\u007f]/.test(name)),
        mimeType: z.enum(AGENT_IMAGE_MIME_TYPES),
        dataUrl: z.string().max(Math.ceil(AGENT_IMAGE_MAX_BYTES / 3) * 4 + 64),
      })
      .strict(),
  )
  .max(AGENT_IMAGE_MAX_COUNT)
  .default([]);

export function prepareAgentImages(
  input: z.infer<typeof agentImagesSchema>,
  chatId: string,
) {
  return input.map((image) => {
    const prefix = `data:${image.mimeType};base64,`;
    if (!image.dataUrl.startsWith(prefix))
      throw problem(
        400,
        "Нужны данные изображения в формате PNG, JPEG, GIF или WebP",
        "INVALID_AGENT_IMAGE",
      );
    const encoded = image.dataUrl.slice(prefix.length);
    const bytes = Buffer.from(encoded, "base64");
    if (
      !bytes.length ||
      bytes.length > AGENT_IMAGE_MAX_BYTES ||
      bytes.toString("base64") !== encoded ||
      !validImage(bytes, image.mimeType)
    )
      throw problem(
        400,
        "Некорректное изображение или размер больше 5 МиБ",
        "INVALID_AGENT_IMAGE",
      );
    const id = createHash("sha256").update(bytes).digest("hex");
    const attachment: AgentImageAttachment = {
      id,
      name: image.name,
      mimeType: image.mimeType,
      size: bytes.length,
      url: `/api/chats/${chatId}/images/${id}`,
    };
    return { attachment, bytes };
  });
}

export function readAgentImage(
  store: ProjectStore,
  chatId: string,
  id: string,
) {
  const row = store.db.query(
    "SELECT mime_type,bytes FROM agent_images WHERE chat_id=?1 AND id=?2",
    [chatId, id],
  ).rows[0];
  if (!row) throw problem(404, "Изображение не найдено");
  return {
    mimeType: row.mime_type as AgentImageMimeType,
    bytes: Buffer.from(row.bytes),
  };
}

export function providerImages(
  store: ProjectStore,
  chatId: string,
  images: AgentImageAttachment[],
): AgentProviderImage[] {
  return images.map((image) => {
    const stored = readAgentImage(store, chatId, image.id);
    return {
      name: image.name,
      mimeType: stored.mimeType,
      data: stored.bytes.toString("base64"),
    };
  });
}
