import type { BoardDocument, PresentationSlide } from "../../shared/types";
import {
  PRESENTATION_HEIGHT,
  PRESENTATION_MAX_SLIDES,
  PRESENTATION_WIDTH,
} from "../../shared/presentation";
import { boardDocumentSchema } from "../../shared/board-schema";
import { CUSTOM_CHART_LIMITS } from "../../shared/custom-charts";

export function presentationSlideContent(
  document: BoardDocument,
  slideId: string,
) {
  return {
    nodes: document.nodes.filter((node) => node.slideId === slideId),
    edges: document.edges.filter((edge) => edge.slideId === slideId),
  };
}

export function validateCanvasInsertion(document: BoardDocument) {
  if (document.nodes.length > 200)
    throw new Error("В документе может быть не больше 200 блоков.");
  if (document.edges.length > 500)
    throw new Error("В документе может быть не больше 500 связей.");
  if (!boardDocumentSchema.safeParse(document).success)
    throw new Error("Не удалось разместить блоки в этой области.");
  const bytes = new TextEncoder().encode(JSON.stringify(document)).byteLength;
  if (
    bytes > 2 * 1024 * 1024 - 1024 ||
    (document.nodes.some((node) => node.data.customChart) &&
      bytes > CUSTOM_CHART_LIMITS.boardBytes)
  )
    throw new Error(
      "В документе слишком много данных для вставки этих блоков.",
    );
}

export function addPresentationSlide(document: BoardDocument) {
  const slides = document.slides ?? [];
  if (slides.length >= PRESENTATION_MAX_SLIDES)
    throw new Error(
      `В презентации может быть не больше ${PRESENTATION_MAX_SLIDES} слайдов.`,
    );
  const titles = new Set(slides.map((slide) => slide.title));
  let number = slides.length + 1;
  while (titles.has(`Слайд ${number}`)) number++;
  const slide: PresentationSlide = {
    id: crypto.randomUUID(),
    title: `Слайд ${number}`,
    background: "#ffffff",
  };
  return { slide, document: { ...document, slides: [...slides, slide] } };
}

export function duplicatePresentationSlide(
  document: BoardDocument,
  slideId: string,
) {
  const slides = document.slides ?? [];
  const index = slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) throw new Error("Слайд удалён.");
  const { slide } = addPresentationSlide(document);
  const suffix = " — копия";
  slide.title = slides[index].title.slice(0, 200 - suffix.length) + suffix;
  slide.background = slides[index].background;
  const content = presentationSlideContent(document, slideId);
  const ids = new Map(
    content.nodes.map((node) => [node.id, crypto.randomUUID()]),
  );
  const duplicate: BoardDocument = {
    ...document,
    slides: [...slides.slice(0, index + 1), slide, ...slides.slice(index + 1)],
    nodes: [
      ...document.nodes,
      ...content.nodes.map((node) => ({
        ...structuredClone(node),
        id: ids.get(node.id)!,
        slideId: slide.id,
      })),
    ],
    edges: [
      ...document.edges,
      ...content.edges.map((edge) => ({
        ...structuredClone(edge),
        id: crypto.randomUUID(),
        slideId: slide.id,
        source: edge.source ? ids.get(edge.source) : undefined,
        target: edge.target ? ids.get(edge.target) : undefined,
      })),
    ],
  };
  validateCanvasInsertion(duplicate);
  return { slide, document: duplicate };
}

export function removePresentationSlide(
  document: BoardDocument,
  slideId: string,
): BoardDocument {
  const slides = (document.slides ?? []).filter(
    (slide) => slide.id !== slideId,
  );
  if (!slides.length)
    throw new Error("В презентации должен остаться хотя бы один слайд.");
  return {
    ...document,
    slides,
    nodes: document.nodes.filter((node) => node.slideId !== slideId),
    edges: document.edges.filter((edge) => edge.slideId !== slideId),
  };
}

export function fitPresentationSlide(
  width: number,
  height: number,
  gutter = 24,
) {
  const zoom = Math.max(
    0.01,
    Math.min(
      (width - gutter * 2) / PRESENTATION_WIDTH,
      (height - gutter * 2) / PRESENTATION_HEIGHT,
    ),
  );
  return {
    x: (width - PRESENTATION_WIDTH * zoom) / 2,
    y: (height - PRESENTATION_HEIGHT * zoom) / 2,
    zoom,
  };
}
