import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { BoardNode } from "../../shared/types";
import { getNodeVisualBounds } from "./shape-geometry";
import "./canvas-drag-overlay.css";

const activeContent = "script,object,embed,video,audio,picture source";
const canvasControls =
  ".react-flow__handle,.react-flow__resize-control,.shape-transform-controls";

function copyPixels(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement | HTMLImageElement,
) {
  try {
    const context = target.getContext("2d");
    if (context) {
      context.drawImage(source, 0, 0, target.width, target.height);
      return true;
    }
  } catch {
    // A renderer may release its pixels while the first drag frame is captured.
  }
  return false;
}

function snapshotNode(source: HTMLElement, prefix: string) {
  const copy = source.cloneNode(true) as HTMLElement;
  const originalElements = [source, ...source.querySelectorAll("*")];
  const copiedElements = [copy, ...copy.querySelectorAll("*")];
  const scrolled: { element: Element; left: number; top: number }[] = [];
  const ids = new Map<string, string>();
  for (const element of copiedElements) {
    if (!element.id) continue;
    const id = `${prefix}-${ids.size}`;
    ids.set(element.id, id);
    element.id = id;
  }
  for (let index = 0; index < copiedElements.length; index++) {
    const original = originalElements[index];
    const element = copiedElements[index];
    for (const { name, value, namespaceURI } of Array.from(
      element.attributes,
    )) {
      if (name.startsWith("on") || name === "autofocus" || name === "name")
        element.removeAttribute(name);
      else {
        let updated = value.replace(
          /url\(#([^)]*)\)/g,
          (reference, id: string) =>
            ids.has(id) ? `url(#${ids.get(id)})` : reference,
        );
        if (
          (name === "href" || name === "xlink:href") &&
          ids.has(value.slice(1)) &&
          value.startsWith("#")
        )
          updated = `#${ids.get(value.slice(1))}`;
        if (updated !== value)
          element.setAttributeNS(namespaceURI, name, updated);
      }
    }
    if (
      element instanceof HTMLCanvasElement &&
      original instanceof HTMLCanvasElement
    ) {
      copyPixels(element, original);
    } else if (
      element instanceof HTMLTextAreaElement &&
      original instanceof HTMLTextAreaElement
    ) {
      element.value = original.value;
      element.readOnly = true;
    } else if (element instanceof HTMLIFrameElement) {
      // An opaque chart frame is already isolated. Cloning it would launch a
      // second frame instead of showing the chart it has rendered.
      const label = source.ownerDocument.createElement("div");
      label.className = "canvas-drag-frame-label";
      label.textContent = element.title || "Кастомный график";
      element.replaceWith(label);
    } else if (element.matches(activeContent)) {
      element.remove();
    } else if (
      element instanceof HTMLImageElement &&
      original instanceof HTMLImageElement
    ) {
      // Reuse decoded pixels so attaching the preview cannot fetch the image.
      const image = source.ownerDocument.createElement("canvas");
      const style = getComputedStyle(original);
      const scale = Math.min(
        1,
        4096 / Math.max(original.naturalWidth, original.naturalHeight),
      );
      image.width = original.naturalWidth
        ? Math.max(1, Math.round(original.naturalWidth * scale))
        : 0;
      image.height = original.naturalHeight
        ? Math.max(1, Math.round(original.naturalHeight * scale))
        : 0;
      image.className = element.className;
      image.style.cssText = element.style.cssText;
      image.style.width = style.width;
      image.style.height = style.height;
      image.style.objectFit = style.objectFit;
      image.style.objectPosition = style.objectPosition;
      if (image.width && image.height && copyPixels(image, original))
        element.replaceWith(image);
      else {
        const placeholder = source.ownerDocument.createElement("span");
        placeholder.className = "board-image-error";
        placeholder.textContent = original.alt || "Изображение";
        element.replaceWith(placeholder);
      }
    }
    if (original.scrollTop || original.scrollLeft)
      scrolled.push({
        element,
        left: original.scrollLeft,
        top: original.scrollTop,
      });
  }
  copy.removeAttribute("data-id");
  copy.removeAttribute("data-testid");
  copy.classList.remove("dragging");
  copy.style.transform = "none";
  copy.style.opacity = "1";
  copy.style.visibility = "visible";
  copy.querySelectorAll(canvasControls).forEach((control) => control.remove());
  return { copy, scrolled };
}

function DragNode({
  node,
  source,
}: {
  node: BoardNode;
  source: HTMLElement | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const id = useId();
  const bounds = getNodeVisualBounds(node);
  useLayoutEffect(() => {
    if (!source || !host.current) return;
    const { copy, scrolled } = snapshotNode(source, id);
    host.current.append(copy);
    for (const { element, left, top } of scrolled) {
      element.scrollLeft = left;
      element.scrollTop = top;
    }
    return () => copy.remove();
  }, [source, id]);
  return (
    <div
      ref={host}
      className="canvas-drag-node"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: Math.max(0.001, bounds.right - bounds.x),
        height: Math.max(0.001, bounds.bottom - bounds.y),
        zIndex: source?.style.zIndex || undefined,
      }}
    />
  );
}

export default function CanvasDragOverlay({
  nodes,
  origin,
  viewport,
  source,
}: {
  nodes: BoardNode[];
  origin: { left: number; top: number };
  viewport: { x: number; y: number; zoom: number };
  source: HTMLElement | null;
}) {
  const elements = useRef<Map<string, HTMLElement> | null>(null);
  if (!elements.current) {
    elements.current = new Map(
      [
        ...(source?.querySelectorAll<HTMLElement>(
          ".react-flow__node[data-id]",
        ) ?? []),
      ].map((element) => [element.dataset.id!, element]),
    );
  }
  return createPortal(
    <div className="canvas-drag-overlay" aria-hidden="true" inert>
      <div
        className="canvas-drag-world board-workspace"
        style={{
          transform: `translate(${origin.left + viewport.x}px, ${origin.top + viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        {nodes.map((node) => (
          <DragNode
            key={node.id}
            node={node}
            source={elements.current!.get(node.id)}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}
