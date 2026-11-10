import {
  BOARD_IMAGE_MAX_BYTES,
  BOARD_IMAGE_MAX_COUNT,
  BOARD_IMAGE_MIME_TYPES,
  type BoardImage,
} from "../../shared/board-images";
import { api, json } from "../api";

export function clipboardImageFiles(
  clipboard: Pick<DataTransfer, "files" | "items">,
): File[] {
  const images = Array.from(clipboard.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
  // files and items normally describe the same payload. Prefer files to avoid
  // inserting duplicate images, but support clipboard bridges with items only.
  if (images.length) return images;
  return Array.from(clipboard.items ?? []).flatMap((item) => {
    if (item.kind !== "file" || !item.type.startsWith("image/")) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

export function validateImageFiles(files: File[]) {
  if (files.length > BOARD_IMAGE_MAX_COUNT)
    throw new Error(
      `Можно добавить до ${BOARD_IMAGE_MAX_COUNT} изображений за раз.`,
    );
  for (const file of files) {
    if (!BOARD_IMAGE_MIME_TYPES.some((type) => type === file.type))
      throw new Error("Поддерживаются изображения PNG, JPEG, GIF и WebP.");
    if (!file.size || file.size > BOARD_IMAGE_MAX_BYTES)
      throw new Error(
        "Размер каждого изображения должен быть от 1 байта до 5 МиБ.",
      );
  }
}
export async function uploadBoardImage(
  file: File,
): Promise<{ image: BoardImage; width: number; height: number }> {
  validateImageFiles([file]);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`Не удалось прочитать ${file.name}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
  const size = await new Promise<{ width: number; height: number }>(
    (resolve, reject) => {
      const image = new Image();
      image.onload = () =>
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () =>
        reject(new Error(`Не удалось открыть изображение ${file.name}`));
      image.src = dataUrl;
    },
  );
  const image = await api<BoardImage>("/api/board-images", {
    method: "POST",
    body: json({
      name: file.name || "image.png",
      mimeType: file.type,
      dataUrl,
    }),
  });
  const scale = Math.min(
    1,
    640 / Math.max(1, size.width),
    480 / Math.max(1, size.height),
  );
  return {
    image,
    width: Math.max(40, size.width * scale),
    height: Math.max(40, size.height * scale),
  };
}
