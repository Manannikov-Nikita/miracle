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

// Check the declared media type against the actual container and its boundaries.
// Images remain opaque bytes; no SVG/HTML, remote URLs or local paths are accepted.
function validImage(bytes: Buffer, mime: AgentImageMimeType): boolean {
  if (mime === "image/png") {
    if (
      bytes.length < 57 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    )
      return false;
    let offset = 8,
      data = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset),
        type = bytes.toString("ascii", offset + 4, offset + 8);
      if (offset + 12 + length > bytes.length) return false;
      if (
        offset === 8 &&
        (type !== "IHDR" ||
          length !== 13 ||
          !bytes.readUInt32BE(16) ||
          !bytes.readUInt32BE(20))
      )
        return false;
      if (type === "IDAT") data = true;
      offset += length + 12;
      if (type === "IEND")
        return data && length === 0 && offset === bytes.length;
    }
    return false;
  }
  if (mime === "image/jpeg") {
    if (
      bytes.length < 12 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9
    )
      return false;
    let offset = 2,
      frame = false;
    while (offset + 4 < bytes.length) {
      if (bytes[offset++] !== 0xff) return false;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) return false;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      if (marker === 0xda)
        return frame && length >= 6 && offset + length < bytes.length - 2;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (
          length < 8 ||
          !bytes.readUInt16BE(offset + 3) ||
          !bytes.readUInt16BE(offset + 5)
        )
          return false;
        frame = true;
      }
      offset += length;
    }
    return false;
  }
  if (mime === "image/gif")
    return (
      bytes.length >= 20 &&
      ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) &&
      bytes.readUInt16LE(6) > 0 &&
      bytes.readUInt16LE(8) > 0 &&
      bytes.includes(0x2c, 13) &&
      bytes.at(-1) === 0x3b
    );
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    return false;
  let offset = 12,
    frame = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4),
      size = bytes.readUInt32LE(offset + 4);
    if (!size || offset + 8 + size > bytes.length) return false;
    if (["VP8 ", "VP8L", "ANMF"].includes(type)) frame = true;
    offset += 8 + size + (size % 2);
  }
  return frame && offset === bytes.length;
}

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
