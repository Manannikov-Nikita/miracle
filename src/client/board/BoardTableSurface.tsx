import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "@phosphor-icons/react";
import "./board-table-surface.css";

const hostUsers = new WeakMap<HTMLElement, number>();
type FocusTarget = {
  element: HTMLElement;
  label: string | null;
  title: string;
};

/** Expand into the board's coordinate space, outside the scaled flow viewport. */
export default function BoardTableSurface({
  expanded,
  onClose,
  children,
}: {
  expanded: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const previousExpanded = useRef(false);
  const focusTarget = useRef<FocusTarget | undefined>(undefined);
  const latest = useRef({ expanded, onClose });
  latest.current = { expanded, onClose };

  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element || !expanded) return;
    setHost(element.closest<HTMLElement>(".board-workspace") ?? element);
  }, [expanded]);
  useLayoutEffect(() => {
    if (!expanded || !host) return;
    hostUsers.set(host, (hostUsers.get(host) ?? 0) + 1);
    host.classList.add("board-table-surface-host");
    back.current?.focus({ preventScroll: true });
    return () => {
      const remaining = (hostUsers.get(host) ?? 1) - 1;
      if (remaining) hostUsers.set(host, remaining);
      else {
        hostUsers.delete(host);
        host.classList.remove("board-table-surface-host");
      }
    };
  }, [expanded, host]);
  useLayoutEffect(() => {
    if (previousExpanded.current && !expanded) {
      const target = focusTarget.current;
      // The grid moves between roots, so its original trigger can be remounted.
      const replacement = target?.element.isConnected
        ? target.element
        : Array.from(
            anchor.current?.querySelectorAll<HTMLElement>(
              "button,[tabindex]",
            ) ?? [],
          ).find((element) =>
            target?.label
              ? element.getAttribute("aria-label") === target.label
              : target?.title && element.title === target.title,
          );
      replacement?.focus({ preventScroll: true });
    }
    previousExpanded.current = expanded;
  }, [expanded]);

  const surface = (
    <section
      className="board-table-surface board-table-surface-expanded nodrag nopan nowheel nokey"
      role="region"
      aria-label="Таблица на всю доску"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyDownCapture={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          !event.currentTarget.contains(event.target as Node) ||
          (event.target as HTMLElement).closest(
            "input,textarea,select,[contenteditable=true],[role=dialog]",
          )
        )
          return;
        const native = event.nativeEvent;
        // Let grid/editor handlers consume Escape before returning to the board.
        queueMicrotask(() => {
          if (!native.defaultPrevented && latest.current.expanded)
            latest.current.onClose();
        });
      }}
    >
      <div className="board-table-surface-heading">
        <button
          ref={back}
          type="button"
          onClick={onClose}
          aria-label="Вернуться на доску"
          title="Вернуться на доску (Esc)"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Вернуться на доску
        </button>
      </div>
      <div className="board-table-surface-content">{children}</div>
    </section>
  );
  return (
    <div
      ref={anchor}
      className="board-table-surface-anchor"
      onFocusCapture={(event) => {
        if (expanded) return;
        const element = event.target as HTMLElement;
        focusTarget.current = {
          element,
          label: element.getAttribute("aria-label"),
          title: element.title,
        };
      }}
    >
      {expanded && host ? createPortal(surface, host) : children}
    </div>
  );
}
