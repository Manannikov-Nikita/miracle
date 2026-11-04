import {
  AGENT_IMAGE_MIME_TYPES,
  type AgentImageAttachment,
} from "../../shared/agents";

function isSavedImage(value: unknown): value is AgentImageAttachment {
  if (!value || typeof value !== "object") return false;
  const image = value as Record<string, unknown>;
  return (
    typeof image.id === "string" &&
    image.id.length > 0 &&
    typeof image.name === "string" &&
    image.name.length > 0 &&
    typeof image.mimeType === "string" &&
    AGENT_IMAGE_MIME_TYPES.some((mimeType) => mimeType === image.mimeType) &&
    typeof image.size === "number" &&
    Number.isSafeInteger(image.size) &&
    image.size > 0 &&
    typeof image.url === "string" &&
    /^\/api\/chats\/[A-Za-z0-9_-]+\/images\/[A-Za-z0-9_-]+$/.test(image.url)
  );
}

export default function AgentMessageImages({ images }: { images: unknown }) {
  const saved = Array.isArray(images) ? images.filter(isSavedImage) : [];
  if (!saved.length) return null;
  return (
    <div
      className="agent-message-images"
      aria-label="Прикреплённые изображения"
    >
      {saved.map((image, index) => (
        <a
          key={`${image.id}:${index}`}
          href={image.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img src={image.url} alt={image.name} loading="lazy" />
        </a>
      ))}
    </div>
  );
}
