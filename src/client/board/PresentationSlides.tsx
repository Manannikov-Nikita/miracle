import {
  type DragEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  DotsThree,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import type { BoardDocument, PresentationSlide } from "../../shared/types";
import { PRESENTATION_MAX_SLIDES } from "../../shared/presentation";
import type { AgentEntityWork } from "../../shared/agent-work";
import { AgentWorkIndicator } from "../agents/AgentWorkIndicator";
import PresentationThumbnail from "./PresentationThumbnail";
import ColorPicker from "../colors/ColorPicker";
import "./presentation-slides.css";

const noSlides: PresentationSlide[] = [];
type SlideDrag = {
  boardId: string;
  id: string;
  initialOrder: string[];
  order: string[];
};

interface Props {
  boardId: string;
  document: BoardDocument;
  selected: PresentationSlide;
  structureEditable: boolean;
  metadataEditable: boolean;
  deletionEditable: boolean;
  work?: AgentEntityWork;
  onSelect(id: string): void;
  onAdd(): void;
  onDuplicate(): void;
  onUpdate(
    id: string,
    patch: Pick<PresentationSlide, "title" | "background">,
  ): void;
  onRemove(id: string): void;
  onReorder(from: string, to: string): void;
}

export default function PresentationSlides({
  boardId,
  document,
  selected,
  structureEditable,
  metadataEditable,
  deletionEditable,
  work,
  onSelect,
  onAdd,
  onDuplicate,
  onUpdate,
  onRemove,
  onReorder,
}: Props) {
  const slides = document.slides ?? noSlides;
  const index = slides.findIndex((slide) => slide.id === selected.id);
  const [dialog, setDialog] = useState<{
    slide: PresentationSlide;
    action: "edit" | "delete";
  } | null>(null);
  const [title, setTitle] = useState("");
  const [background, setBackground] = useState("#ffffff");
  const backgroundColor = background.trim();
  const validBackground = /^#[0-9a-f]{6}$/i.test(backgroundColor);
  const backgroundErrorId = useId();
  const dragSlide = useRef<SlideDrag | null>(null);
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const orderKey = JSON.stringify(slides.map(({ id }) => id));
  const currentDrag = () => {
    const drag = dragSlide.current;
    return drag &&
      structureEditable &&
      drag.boardId === boardId &&
      JSON.stringify(drag.initialOrder) === orderKey
      ? drag
      : null;
  };
  const displayedSlides = useMemo(() => {
    if (!currentDrag() || !previewOrder) return slides;
    const byId = new Map(slides.map((slide) => [slide.id, slide]));
    return previewOrder.map((id) => byId.get(id)!);
  }, [slides, previewOrder, boardId, structureEditable]);
  const cancelDrag = () => {
    dragSlide.current = null;
    setPreviewOrder(null);
  };
  const previousPositions = useRef(new Map<string, DOMRect>());
  const animations = useRef(new Map<string, Animation>());
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    cancelDrag();
  }, [boardId, orderKey, structureEditable]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !dragSlide.current) return;
      event.preventDefault();
      cancelDrag();
    };
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("keydown", cancel, true);
      for (const animation of animations.current.values()) animation.cancel();
    };
  }, []);
  useLayoutEffect(() => {
    const before = previousPositions.current;
    previousPositions.current = new Map();
    for (const animation of animations.current.values()) animation.cancel();
    animations.current.clear();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const item of Array.from(listRef.current?.children ?? [])) {
      if (!(item instanceof HTMLElement)) continue;
      const id = item.dataset.slideId!;
      const from = before.get(id);
      if (!from || id === dragSlide.current?.id || !item.animate) continue;
      const to = item.getBoundingClientRect();
      const x = from.left - to.left;
      const y = from.top - to.top;
      if (x || y)
        animations.current.set(
          id,
          item.animate(
            [
              { transform: `translate(${x}px, ${y}px)` },
              { transform: "translate(0, 0)" },
            ],
            { duration: 160, easing: "ease-out" },
          ),
        );
    }
  }, [displayedSlides]);
  const previewAt = (clientX: number, clientY: number) => {
    const drag = currentDrag();
    const list = listRef.current;
    if (!drag || !list) return;
    const horizontal = getComputedStyle(list).flexDirection === "row";
    const pointer = horizontal ? clientX : clientY;
    const items = Array.from(list.children) as HTMLElement[];
    const targetIndex = items.filter((item) => {
      if (item.dataset.slideId === drag.id) return false;
      const rect = item.getBoundingClientRect();
      return (
        pointer >
        (horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2)
      );
    }).length;
    if (targetIndex === drag.order.indexOf(drag.id)) return;
    const next = drag.order.filter((id) => id !== drag.id);
    next.splice(targetIndex, 0, drag.id);
    previousPositions.current = new Map(
      items.map((item) => [
        item.dataset.slideId!,
        item.getBoundingClientRect(),
      ]),
    );
    drag.order = next;
    setPreviewOrder(next);
  };
  const previewDrag = (event: DragEvent<HTMLOListElement>) => {
    if (!currentDrag()) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    previewAt(event.clientX, event.clientY);
  };
  const [visible, setVisible] = useState<Set<string>>(() => new Set());
  const slidesWithContent = useMemo(
    () =>
      new Set(
        [...document.nodes, ...document.edges].map(({ slideId }) => slideId),
      ),
    [document.nodes, document.edges],
  );
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = new Map<Element, string>(
      Array.from(list.children, (item) => [
        item,
        (item as HTMLElement).dataset.slideId!,
      ]),
    );

    if (typeof IntersectionObserver === "function") {
      const slideIds = new Set(items.values());
      let observing = true;
      const observer = new IntersectionObserver(
        (entries) => {
          if (!observing) return;
          setVisible((previous) => {
            const next = new Set(
              [...previous].filter((id) => slideIds.has(id)),
            );
            for (const { target, isIntersecting } of entries) {
              const id = items.get(target);
              if (!id) continue;
              if (isIntersecting) next.add(id);
              else next.delete(id);
            }
            return next;
          });
        },
        { root: list },
      );
      for (const item of items.keys()) observer.observe(item);
      return () => {
        observing = false;
        observer.disconnect();
      };
    }

    // Keep the fallback bounded to the scroll range too; a deck can hold 100 slides.
    const scan = () => {
      const viewport = list.getBoundingClientRect();
      const next = new Set<string>();
      for (const [item, id] of items) {
        const bounds = item.getBoundingClientRect();
        if (
          Math.min(bounds.right, viewport.right) >
            Math.max(bounds.left, viewport.left) &&
          Math.min(bounds.bottom, viewport.bottom) >
            Math.max(bounds.top, viewport.top)
        )
          next.add(id);
      }
      setVisible((previous) =>
        previous.size === next.size && [...next].every((id) => previous.has(id))
          ? previous
          : next,
      );
    };
    scan();
    list.addEventListener("scroll", scan, { passive: true });
    window.addEventListener("resize", scan);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(scan) : null;
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", scan);
      window.removeEventListener("resize", scan);
      observer?.disconnect();
    };
  }, [displayedSlides]);
  const startDialog = (action: "edit" | "delete") => {
    setTitle(selected.title);
    setBackground(selected.background);
    setDialog({ slide: selected, action });
  };
  const canAdd = structureEditable && slides.length < PRESENTATION_MAX_SLIDES;

  return (
    <nav className="presentation-slides" aria-label="Слайды презентации">
      <div className="presentation-slide-tools">
        <span>Слайды</span>
        <AgentWorkIndicator work={work} compact />
        <button
          className="board-header-icon"
          type="button"
          aria-label="Добавить слайд"
          title="Добавить слайд"
          disabled={!canAdd}
          onClick={onAdd}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              ref={menuTrigger}
              className="board-header-icon"
              aria-label="Действия со слайдом"
              title="Действия со слайдом"
            >
              <DotsThree size={19} weight="bold" aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="dropdown-menu"
              sideOffset={6}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <DropdownMenu.Item
                disabled={!metadataEditable}
                onSelect={() => startDialog("edit")}
              >
                <PencilSimple size={16} aria-hidden="true" /> Название и фон
              </DropdownMenu.Item>
              <DropdownMenu.Item disabled={!canAdd} onSelect={onDuplicate}>
                <Copy size={16} aria-hidden="true" /> Дублировать слайд
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={!structureEditable || index < 1}
                onSelect={() => onReorder(selected.id, slides[index - 1].id)}
              >
                <ArrowLeft size={16} aria-hidden="true" /> Переместить раньше
              </DropdownMenu.Item>
              <DropdownMenu.Item
                disabled={!structureEditable || index >= slides.length - 1}
                onSelect={() => onReorder(selected.id, slides[index + 1].id)}
              >
                <ArrowRight size={16} aria-hidden="true" /> Переместить позже
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                className="board-menu-danger"
                disabled={!deletionEditable || slides.length < 2}
                onSelect={() => startDialog("delete")}
              >
                <Trash size={16} aria-hidden="true" /> Удалить слайд
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <ol
        className="presentation-slide-list"
        ref={listRef}
        onDragEnter={previewDrag}
        onDragOver={previewDrag}
        onDrop={(event) => {
          const drag = currentDrag();
          if (!drag) return;
          event.preventDefault();
          event.stopPropagation();
          previewAt(event.clientX, event.clientY);
          const target = drag.initialOrder[drag.order.indexOf(drag.id)];
          cancelDrag();
          if (target !== drag.id) onReorder(drag.id, target);
        }}
      >
        {slides.map((slide) => (
          <li
            key={slide.id}
            data-slide-id={slide.id}
            style={{
              order: displayedSlides.findIndex(({ id }) => id === slide.id),
            }}
            className={`presentation-slide-item${currentDrag()?.id === slide.id ? " is-dragging" : ""}`}
          >
            <button
              type="button"
              className="presentation-slide-thumbnail"
              aria-current={slide.id === selected.id ? "true" : undefined}
              title={slide.title}
              draggable={structureEditable}
              onClick={() => onSelect(slide.id)}
              onDragStart={(event) => {
                if (!structureEditable) {
                  event.preventDefault();
                  return;
                }
                const order = slides.map(({ id }) => id);
                dragSlide.current = {
                  boardId,
                  id: slide.id,
                  initialOrder: order,
                  order,
                };
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  "application/x-miracle-slide",
                  slide.id,
                );
                const card = event.currentTarget.parentElement;
                if (card && event.dataTransfer.setDragImage) {
                  const bounds = card.getBoundingClientRect();
                  event.dataTransfer.setDragImage(
                    card,
                    event.clientX - bounds.left,
                    event.clientY - bounds.top,
                  );
                }
                setPreviewOrder(order);
              }}
              onDragEnd={cancelDrag}
            >
              <span
                className="presentation-thumbnail-slot"
                aria-hidden="true"
              />
              <span>
                <small>
                  {displayedSlides.findIndex(({ id }) => id === slide.id) + 1}
                </small>{" "}
                {slide.title}
              </span>
            </button>
            <PresentationThumbnail
              boardId={boardId}
              document={document}
              slide={slide}
              visible={visible.has(slide.id) && slidesWithContent.has(slide.id)}
            />
          </li>
        ))}
      </ol>
      <Dialog.Root
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="board-dialog-overlay" />
          <Dialog.Content
            className="board-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              menuTrigger.current?.focus({ preventScroll: true });
            }}
          >
            <Dialog.Title>
              {dialog?.action === "delete"
                ? "Удалить слайд?"
                : "Название и фон слайда"}
            </Dialog.Title>
            <Dialog.Description>
              {dialog?.action === "delete"
                ? `Слайд «${dialog.slide.title}» и его блоки будут удалены.`
                : "Настройки применяются к выбранному слайду."}
            </Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (dialog?.action === "delete") onRemove(dialog.slide.id);
                else if (dialog && title.trim() && validBackground)
                  onUpdate(dialog.slide.id, {
                    title: title.trim(),
                    background: backgroundColor,
                  });
                else return;
                setDialog(null);
              }}
            >
              {dialog?.action === "edit" && (
                <>
                  <label>
                    Название
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      maxLength={200}
                      required
                    />
                  </label>
                  <div className="presentation-slide-colors">
                    <label>
                      Цвет фона
                      <ColorPicker
                        label="Цвет фона"
                        value={(validBackground
                          ? backgroundColor
                          : dialog.slide.background
                        ).toLowerCase()}
                        onChange={setBackground}
                      />
                    </label>
                    <label>
                      Код цвета фона
                      <input
                        type="text"
                        value={background}
                        onChange={(event) => setBackground(event.target.value)}
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        aria-invalid={!validBackground || undefined}
                        aria-describedby={
                          validBackground ? undefined : backgroundErrorId
                        }
                      />
                    </label>
                    {!validBackground && (
                      <span
                        id={backgroundErrorId}
                        className="presentation-slide-color-error"
                      >
                        Введите цвет в формате #RRGGBB.
                      </span>
                    )}
                  </div>
                </>
              )}
              <div className="board-dialog-actions">
                <button type="button" onClick={() => setDialog(null)}>
                  Отмена
                </button>
                <button
                  type="submit"
                  className={
                    dialog?.action === "delete"
                      ? "board-danger"
                      : "board-primary"
                  }
                  disabled={
                    dialog?.action === "edit" &&
                    (!title.trim() || !validBackground)
                  }
                >
                  {dialog?.action === "delete" ? "Удалить" : "Сохранить"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </nav>
  );
}
