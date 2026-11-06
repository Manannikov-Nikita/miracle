import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const defaultWidth = 228;
const minimumWidth = 200;
const maximumWidth = 720;

export default function ExplorerPanel({
  workspaceId,
  drawer,
  minWorkspaceWidth,
  children,
}: {
  workspaceId: string;
  drawer: boolean;
  minWorkspaceWidth: number;
  children: ReactNode;
}) {
  const storageKey = `miracle:explorer-width:${workspaceId}`;
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (
        Number.isFinite(saved) &&
        saved >= minimumWidth &&
        saved <= maximumWidth
      )
        return saved;
    } catch {}
    return defaultWidth;
  });
  const panel = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [availableWidth, setAvailableWidth] = useState(maximumWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );
  const max = Math.max(0, Math.min(maximumWidth, availableWidth));
  const min = Math.min(minimumWidth, max);
  const width = Math.max(min, Math.min(preferredWidth, max));
  const currentWidth = useRef(width);
  currentWidth.current = width;

  function persist(value: number) {
    try {
      localStorage.setItem(storageKey, String(value));
    } catch {}
  }
  function resize(value: number, save = true) {
    const next = Math.max(min, Math.min(value, max));
    currentWidth.current = next;
    setPreferredWidth(next);
    if (save) persist(next);
  }
  function reset() {
    setPreferredWidth(defaultWidth);
    try {
      localStorage.removeItem(storageKey);
    } catch {}
  }
  useLayoutEffect(() => {
    const measure = () => {
      const left = panel.current?.getBoundingClientRect().left ?? 0;
      // Keep a usable work area on desktop; drawers may cover the workspace.
      setAvailableWidth(
        window.innerWidth - left - (drawer ? 8 : minWorkspaceWidth),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("miracle:reset-layout", reset);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("miracle:reset-layout", reset);
    };
  }, [drawer, minWorkspaceWidth, storageKey]);

  return (
    <div
      ref={panel}
      className={`explorer-panel${drawer ? " explorer-panel-drawer" : ""}`}
      style={{ width }}
    >
      <div id={contentId} className="explorer-panel-content">
        {children}
      </div>
      <div
        className="resize-separator vertical explorer-resize"
        role="separator"
        tabIndex={0}
        aria-label="Ширина обозревателя"
        aria-orientation="vertical"
        aria-controls={contentId}
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(width)}
        aria-valuetext={`${Math.round(width)} пикселей`}
        data-separator={resizing ? "active" : undefined}
        onDoubleClick={reset}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 16;
          const next =
            event.key === "ArrowLeft"
              ? width - step
              : event.key === "ArrowRight"
                ? width + step
                : event.key === "Home"
                  ? min
                  : event.key === "End"
                    ? max
                    : undefined;
          if (next === undefined) return;
          event.preventDefault();
          resize(next);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            width,
          };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.pointerId !== event.pointerId) return;
          resize(start.width + event.clientX - start.x, false);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          persist(currentWidth.current);
          drag.current = null;
          setResizing(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          if (drag.current) persist(currentWidth.current);
          drag.current = null;
          setResizing(false);
        }}
        onLostPointerCapture={() => {
          if (drag.current) persist(currentWidth.current);
          drag.current = null;
          setResizing(false);
        }}
      />
    </div>
  );
}
