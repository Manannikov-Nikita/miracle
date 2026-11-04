import { useRef, useState } from "react";
import {
  AGENT_IMAGE_MAX_BYTES,
  AGENT_IMAGE_MAX_COUNT,
  type AgentImageInput,
} from "../../shared/agents";

export interface DraftAgentImage extends AgentImageInput {
  localId: string;
}

function readImage(file: File): Promise<DraftAgentImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`Не удалось прочитать ${file.name}`));
    reader.onload = () =>
      resolve({
        localId: crypto.randomUUID(),
        name: file.name || "image.png",
        mimeType: file.type as AgentImageInput["mimeType"],
        dataUrl: String(reader.result),
      });
    reader.readAsDataURL(file);
  });
}

export function useAgentImageDrafts(
  key: string,
  onError: (message: string) => void,
) {
  const [drafts, setDrafts] = useState<Record<string, DraftAgentImage[]>>({});
  const [loading, setLoading] = useState<Record<string, number>>({});
  const current = useRef(drafts);
  const pending = useRef(new Map<string, number>());
  const update = (fn: (value: typeof drafts) => typeof drafts) => {
    current.current = fn(current.current);
    setDrafts(current.current);
  };
  const add = async (files: File[]) => {
    if (!files.length) return;
    const reserved = pending.current.get(key) || 0;
    if (
      (current.current[key]?.length || 0) + reserved + files.length >
      AGENT_IMAGE_MAX_COUNT
    ) {
      onError(`Можно прикрепить до ${AGENT_IMAGE_MAX_COUNT} изображений.`);
      return;
    }
    if (
      files.some(
        (file) =>
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            file.type,
          ),
      )
    ) {
      onError("Поддерживаются изображения PNG, JPEG, GIF и WebP.");
      return;
    }
    if (files.some((file) => !file.size || file.size > AGENT_IMAGE_MAX_BYTES)) {
      onError("Размер каждого изображения должен быть от 1 байта до 5 МБ.");
      return;
    }
    pending.current.set(key, reserved + files.length);
    setLoading((value) => ({ ...value, [key]: pending.current.get(key)! }));
    onError("");
    try {
      const images = await Promise.all(files.map(readImage));
      // The initiating draft owns the result even if the user switches chats.
      update((value) => ({
        ...value,
        [key]: [...(value[key] || []), ...images],
      }));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      const count = (pending.current.get(key) || 0) - files.length;
      pending.current.set(key, count);
      setLoading((value) => ({ ...value, [key]: count }));
    }
  };
  return {
    images: drafts[key] || [],
    loading: Boolean(loading[key]),
    add,
    remove: (id: string) =>
      update((value) => ({
        ...value,
        [key]: (value[key] || []).filter((image) => image.localId !== id),
      })),
    move: (to: string, images: DraftAgentImage[]) => {
      const ids = new Set(images.map((image) => image.localId));
      update((value) => ({
        ...value,
        [key]: (value[key] || []).filter((image) => !ids.has(image.localId)),
        [to]: images,
      }));
    },
    clear: (keys: string[], sent: DraftAgentImage[]) => {
      const ids = new Set(sent.map((image) => image.localId));
      update((value) => ({
        ...value,
        ...Object.fromEntries(
          keys.map((k) => [
            k,
            (value[k] || []).filter((image) => !ids.has(image.localId)),
          ]),
        ),
      }));
    },
  };
}
