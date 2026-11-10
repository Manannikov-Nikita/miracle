import { useState } from "react";
import { boardImageUrl, type BoardImage } from "../../shared/board-images";
import "./image-content.css";

export default function ImageContent({
  image,
  title,
}: {
  image: BoardImage;
  title: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="board-image-content">
      {failed ? (
        <span
          className="board-image-error"
          role="img"
          aria-label={image.alt || title}
        >
          Изображение недоступно
        </span>
      ) : (
        <img
          src={boardImageUrl(image.id)}
          alt={image.alt ?? title}
          draggable={false}
          decoding="async"
          style={{ objectFit: image.fit ?? "contain" }}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
