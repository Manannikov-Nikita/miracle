import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Board,
  BoardKind,
  BoardSummary,
  ResultSet,
} from "../shared/types";
import type { BoardFragment } from "./board/clipboard";
import { api, json } from "./api";
import { ErrorBox, Modal, Spinner } from "./components/UI";
import type { CanvasSearchTarget } from "../shared/canvas-search-text";
import type { CanvasTool } from "./board/canvas-tools";

export type CanvasDestination = {
  kind: BoardKind;
  boardId: string;
  slideId?: string;
};
type Point = { x: number; y: number };
export interface CanvasHandle {
  acceptsToolPoint?(point: Point): boolean;
  toolAppearance?(): {
    zoom: number;
    presentation: boolean;
    background?: string;
  };
  createTool?(
    tool: CanvasTool,
    destination: CanvasDestination,
    point: Point,
  ): void;
  openSearchResult?(
    target: CanvasSearchTarget,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  ready?(): boolean;
  visible?(): boolean;
  destination(): CanvasDestination | null;
  insertResult(
    result: ResultSet,
    destination: CanvasDestination | null,
    actionId?: string,
  ): Promise<void>;
  insertFragment(
    fragment: BoardFragment,
    destination: CanvasDestination | null,
    position?: Point,
    actionId?: string,
  ): Promise<void>;
  containsPoint(point: Point): boolean;
  screenToCanvas(point: Point): Point;
}

/** Routes one user action to the document captured before layout/focus changes. */
export class CanvasWorkspace {
  private canvases = new Map<BoardKind, CanvasHandle>();
  private searchNavigation?: AbortController;
  private attempts = new Map<string, { id: string; pending?: Promise<void> }>();
  constructor(
    private callbacks: {
      onOpen(kind: BoardKind): void;
      onTransfer(fragment: BoardFragment): void;
    },
  ) {}
  register(kind: BoardKind, handle: CanvasHandle) {
    this.canvases.set(kind, handle);
    return () => {
      if (this.canvases.get(kind) === handle) this.canvases.delete(kind);
    };
  }
  getCanvas(kind: BoardKind) {
    return this.canvases.get(kind);
  }
  toolTarget(point: Point) {
    return [...this.canvases.values()].find(
      (handle) =>
        handle.createTool &&
        handle.ready?.() !== false &&
        handle.visible?.() !== false &&
        handle.containsPoint(point) &&
        handle.acceptsToolPoint?.(point) !== false,
    );
  }
  createToolAt(tool: CanvasTool, point: Point): boolean {
    const handle = this.toolTarget(point);
    const destination = handle?.destination();
    if (!handle || !destination) return false;
    // Keep this synchronous: the image picker requires the pointer-up activation.
    handle.createTool!(
      tool,
      structuredClone(destination),
      handle.screenToCanvas(point),
    );
    return true;
  }
  open(kind: BoardKind) {
    this.callbacks.onOpen(kind);
  }
  cancelSearchNavigation() {
    this.searchNavigation?.abort();
    this.searchNavigation = undefined;
  }
  async openSearchResult(
    target: CanvasSearchTarget,
    options: { signal?: AbortSignal } = {},
  ) {
    this.cancelSearchNavigation();
    const controller = new AbortController();
    this.searchNavigation = controller;
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    signal.throwIfAborted();
    const handle = this.canvases.get(target.kind);
    if (!handle?.openSearchResult)
      throw new Error("Переход к документу ещё недоступен. Попробуйте снова.");
    this.open(target.kind);
    await handle.openSearchResult(structuredClone(target), { signal });
    signal.throwIfAborted();
  }
  async addResult(kind: BoardKind, result: ResultSet) {
    const handle = this.requireCanvas(kind);
    const destination = structuredClone(handle.destination());
    this.open(kind);
    await this.attempt(
      JSON.stringify(["result", kind, result.id, destination]),
      (actionId) => handle.insertResult(result, destination, actionId),
    );
  }
  transfer(fragment: BoardFragment) {
    this.callbacks.onTransfer(structuredClone(fragment));
  }
  async drop(fragment: BoardFragment, point: Point): Promise<boolean> {
    const handle = this.canvases.get("presentation");
    if (!handle?.containsPoint(point)) return false;
    this.requireCanvas("presentation");
    const destination = structuredClone(handle.destination());
    const position = handle.screenToCanvas(point);
    await this.attempt(
      JSON.stringify(["fragment", fragment.copyId, destination, position]),
      (actionId) =>
        handle.insertFragment(
          structuredClone(fragment),
          destination,
          position,
          actionId,
        ),
    );
    return true;
  }
  async insertTransfer(
    fragment: BoardFragment,
    destination: CanvasDestination,
  ) {
    const handle = this.requireCanvas(destination.kind);
    await this.attempt(
      JSON.stringify(["fragment", fragment.copyId, destination]),
      (actionId) =>
        handle.insertFragment(
          structuredClone(fragment),
          structuredClone(destination),
          undefined,
          actionId,
        ),
    );
  }
  private async attempt(
    key: string,
    insert: (actionId: string) => Promise<void>,
  ) {
    let attempt = this.attempts.get(key);
    if (attempt?.pending) return attempt.pending;
    if (!attempt) {
      attempt = { id: crypto.randomUUID() };
      this.attempts.set(key, attempt);
    }
    const entry = attempt;
    // Failed attempts retain their ID: retry reconciles the original mutation.
    entry.pending = insert(entry.id)
      .then(() => {
        if (this.attempts.get(key) === entry) this.attempts.delete(key);
      })
      .finally(() => {
        entry.pending = undefined;
      });
    return entry.pending;
  }
  private requireCanvas(kind: BoardKind) {
    const handle = this.canvases.get(kind);
    if (!handle || handle.ready?.() === false)
      throw new Error(
        "Область ещё загружается. Повторите добавление через несколько секунд.",
      );
    return handle;
  }
}

const CanvasContext = createContext<CanvasWorkspace | null>(null);
export const useCanvasWorkspace = () => useContext(CanvasContext);

export function CanvasWorkspaceProvider({
  children,
  workspaceId,
  onOpen,
  onTransferOpen,
  onNotify,
}: {
  children: ReactNode;
  workspaceId: string;
  onOpen(kind: BoardKind): void;
  onTransferOpen(): void;
  onNotify(message: string, tone?: "error" | "success" | "info"): void;
}) {
  const callbacks = useRef({ onOpen, onTransferOpen, onNotify });
  callbacks.current = { onOpen, onTransferOpen, onNotify };
  const [fragment, setFragment] = useState<BoardFragment | null>(null);
  const transferTrigger = useRef<HTMLElement | null>(null);
  const [registry] = useState(
    () =>
      new CanvasWorkspace({
        onOpen: (kind) => callbacks.current.onOpen(kind),
        onTransfer: (value) => {
          transferTrigger.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          callbacks.current.onTransferOpen();
          setFragment(value);
        },
      }),
  );
  useEffect(() => () => registry.cancelSearchNavigation(), [registry]);
  return (
    <CanvasContext.Provider value={registry}>
      {children}
      {fragment && (
        <TransferPicker
          key={fragment.copyId}
          registry={registry}
          fragment={fragment}
          workspaceId={workspaceId}
          onClose={() => setFragment(null)}
          onNotify={onNotify}
          restoreFocus={() => {
            const trigger = transferTrigger.current;
            if (trigger?.isConnected && !trigger.closest("[inert],[hidden]"))
              trigger.focus();
          }}
        />
      )}
    </CanvasContext.Provider>
  );
}

function TransferPicker({
  registry,
  fragment,
  workspaceId,
  onClose,
  onNotify,
  restoreFocus,
}: {
  registry: CanvasWorkspace;
  fragment: BoardFragment;
  workspaceId: string;
  onClose(): void;
  onNotify(message: string, tone?: "error" | "success" | "info"): void;
  restoreFocus(): void;
}) {
  const [decks, setDecks] = useState<BoardSummary[]>([]);
  const [deckId, setDeckId] = useState("");
  const [deck, setDeck] = useState<Board | null>(null);
  const [slideId, setSlideId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [newName, setNewName] = useState("Новая презентация");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    api<BoardSummary[]>("/api/boards?kind=presentation")
      .then((items) => {
        if (!live) return;
        setDecks(items);
        const current = registry.getCanvas("presentation")?.destination();
        setDeckId((chosen) =>
          items.some((item) => item.id === chosen)
            ? chosen
            : items.some((item) => item.id === current?.boardId)
              ? current!.boardId
              : items[0]?.id || "",
        );
      })
      .catch((failure) => {
        if (live) setError(failure);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [registry, workspaceId, refresh]);
  useEffect(() => {
    let live = true;
    setDeck(null);
    setSlideId("");
    if (deckId)
      api<Board>(`/api/boards/${encodeURIComponent(deckId)}`)
        .then((value) => {
          if (!live) return;
          setDeck(value);
          const current = registry.getCanvas("presentation")?.destination();
          setSlideId(
            current?.boardId === value.id &&
              value.document.slides?.some(
                (slide) => slide.id === current.slideId,
              )
              ? current.slideId!
              : value.document.slides?.[0]?.id || "",
          );
        })
        .catch((failure) => {
          if (live) setError(failure);
        });
    return () => {
      live = false;
    };
  }, [deckId, registry, refresh]);
  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await api<Board>("/api/boards", {
        method: "POST",
        body: json({
          name: newName.trim() || "Новая презентация",
          kind: "presentation",
          mutationId: crypto.randomUUID(),
        }),
      });
      setDecks((items) => [
        ...items,
        {
          id: created.id,
          name: created.name,
          revision: created.revision,
          updatedAt: created.updatedAt,
          kind: "presentation",
        },
      ]);
      setDeckId(created.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  async function insert() {
    if (!deck || !slideId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await registry.insertTransfer(fragment, {
        kind: "presentation",
        boardId: deck.id,
        slideId,
      });
      onNotify("Блоки добавлены в презентацию", "success");
      onClose();
    } catch (failure) {
      setError(failure);
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Добавить в презентацию"
      dismissible={!busy}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        restoreFocus();
      }}
    >
      {error !== undefined && <ErrorBox error={error} />}
      <button
        className="text-button"
        aria-label="Обновить презентации и слайды"
        disabled={busy || loading}
        onClick={() => {
          setError(undefined);
          setRefresh((value) => value + 1);
        }}
      >
        Обновить список
      </button>
      {loading ? (
        <Spinner />
      ) : (
        <div className="canvas-transfer-fields">
          {!!decks.length && (
            <>
              <label>
                Презентация
                <select
                  value={deckId}
                  disabled={busy}
                  onChange={(event) => {
                    setError(undefined);
                    setDeckId(event.target.value);
                  }}
                >
                  {decks.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Слайд
                <select
                  value={slideId}
                  disabled={busy || !deck}
                  onChange={(event) => setSlideId(event.target.value)}
                >
                  {deck?.document.slides?.map((slide, index) => (
                    <option key={slide.id} value={slide.id}>
                      {index + 1}. {slide.title}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <details open={!decks.length}>
            <summary>Новая презентация</summary>
            <label>
              Название
              <input
                value={newName}
                maxLength={200}
                disabled={busy}
                onChange={(event) => setNewName(event.target.value)}
              />
            </label>
            <button
              className="button"
              disabled={busy || !newName.trim()}
              onClick={() => void create()}
            >
              Создать презентацию
            </button>
          </details>
          <div className="modal-actions">
            <button className="button" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button
              className="button primary"
              disabled={busy || !deck || !slideId}
              onClick={() => void insert()}
            >
              {busy ? "Добавляем…" : "Добавить блоки"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
