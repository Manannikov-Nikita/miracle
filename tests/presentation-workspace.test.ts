// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactFlowProps } from "@xyflow/react";
import type { Board, BoardNode } from "../src/shared/types";
import {
  CanvasWorkspaceProvider,
  useCanvasWorkspace,
  type CanvasWorkspace,
} from "../src/client/canvas-workspace";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import BoardWorkspace from "../src/client/board/BoardWorkspace";
import { findSearchMatch } from "../src/shared/workspace-search";

const flow = vi.hoisted(() => ({
  board: {} as ReactFlowProps,
  deck: {} as ReactFlowProps,
  viewport: { x: 0, y: 0, zoom: 1 },
  fits: [] as string[][],
}));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  const controller = {
    getZoom: () => 1,
    getViewport: () => flow.viewport,
    setViewport: async (viewport: { x: number; y: number; zoom: number }) => {
      flow.viewport = viewport;
      return true;
    },
    fitView: async (options?: { nodes?: { id: string }[] }) => {
      flow.fits.push(options?.nodes?.map((node) => node.id) ?? []);
      return true;
    },
    fitBounds: async () => true,
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
      x: x - 500,
      y,
    }),
  };
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    ReactFlow: (props: ReactFlowProps) => {
      if (props.className === "presentation-readonly-flow")
        return props.children;
      if (props.nodes?.some((node) => node.id === "source")) flow.board = props;
      else flow.deck = props;
      return props.children;
    },
    useReactFlow: () => controller,
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    ViewportPortal: ({ children }: { children: ReactNode }) => children,
  };
});
const response = (value: unknown) => new Response(JSON.stringify(value));
const note = (id: string, slideId?: string): BoardNode => ({
  id,
  slideId,
  type: "artifact",
  position: { x: 0, y: 0 },
  width: 400,
  height: 200,
  data: { kind: "note", title: id, text: "Independent context" },
});
const notify = () => {};

describe("presentation workspace routing", () => {
  let host: HTMLDivElement;
  let root: Root;
  let project: ProjectSync;
  let board: Board;
  let deck: Board;
  let writes: string[];
  let registry: CanvasWorkspace;
  let missingElementFromPoint: boolean;
  const activate = vi.fn<(kind: "board" | "presentation") => void>();
  function CaptureRegistry() {
    registry = useCanvasWorkspace()!;
    return null;
  }
  const rect = (left: number, right: number) => ({
    left,
    right,
    top: 0,
    bottom: 500,
    x: left,
    y: 0,
    width: right - left,
    height: 500,
    toJSON() {},
  });
  async function render(active: "board" | "presentation") {
    const common = {
      workspaceId: "project",
      onNotify: notify,
      onOpenSource() {},
    };
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(CanvasWorkspaceProvider, {
            workspaceId: "project",
            onOpen() {},
            onTransferOpen() {},
            onNotify: notify,
            children: [
              createElement(CaptureRegistry, { key: "registry" }),
              createElement(BoardWorkspace, {
                ...common,
                key: "board",
                kind: "board",
                active: active === "board",
                onActivate: () => activate("board"),
              }),
              createElement(BoardWorkspace, {
                ...common,
                key: "deck",
                kind: "presentation",
                active: active === "presentation",
                onActivate: () => activate("presentation"),
              }),
            ],
          }),
        ),
      ),
    );
  }
  beforeEach(async () => {
    localStorage.clear();
    activate.mockClear();
    flow.viewport = { x: 0, y: 0, zoom: 1 };
    flow.fits = [];
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    missingElementFromPoint = !document.elementFromPoint;
    if (missingElementFromPoint)
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: () => null,
        writable: true,
      });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: {
        configurable: true,
        value: () => new DOMRect(),
      },
    });
    project = new ProjectSync();
    board = {
      id: "source-board",
      name: "Board",
      revision: 1,
      updatedAt: "",
      document: { schemaVersion: 1, nodes: [note("source")], edges: [] },
    };
    deck = {
      id: "deck",
      name: "Deck",
      revision: 1,
      updatedAt: "",
      document: {
        schemaVersion: 1,
        kind: "presentation",
        slides: [
          { id: "first", title: "First", background: "#ffffff" },
          { id: "second", title: "Second", background: "#ebddad" },
        ],
        nodes: [note("first-note", "first"), note("second-note", "second")],
        edges: [],
      },
    };
    writes = [];
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      const target = path === "/api/boards/deck" ? deck : board;
      if (options.method === "PATCH") {
        target.document = JSON.parse(options.body as string).document;
        target.revision++;
        writes.push(path);
      }
      if (path === "/api/boards")
        return response([board, { ...deck, kind: "presentation" }]);
      if (path === "/api/boards?kind=presentation")
        return response([{ ...deck, kind: "presentation" }]);
      return response(target);
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render("board");
    const [source, target] = host.querySelectorAll(".board-canvas");
    vi.spyOn(source, "getBoundingClientRect").mockReturnValue(rect(0, 400));
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(rect(500, 1000));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (missingElementFromPoint)
      Reflect.deleteProperty(document, "elementFromPoint");
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });

  const moveSource = (x: number, y: number, dragging: boolean) => {
    window.dispatchEvent(
      new MouseEvent(dragging ? "mousemove" : "mouseup", {
        clientX: x,
        clientY: y,
      }),
    );
    flow.board.onNodesChange!([
      { type: "position", id: "source", position: { x, y }, dragging },
    ]);
  };
  const boardTool = (name: string) =>
    host.querySelector<HTMLButtonElement>(
      `.board-workspace:not(.presentation-workspace) button[aria-label="${name}"]`,
    )!;
  const pointer = (target: EventTarget, type: string, x: number, y: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        clientX: x,
        clientY: y,
      }),
    );
  const pointerClick = (target: HTMLElement) =>
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

  it.each([
    {
      label: "Добавить текст",
      kind: "text",
      height: 120,
      x: 350,
      boardKind: "board",
      centerX: -150,
    },
    {
      label: "Добавить заметку",
      kind: "note",
      height: 260,
      x: 750,
      boardKind: "presentation",
      centerX: 250,
    },
    {
      label: "Добавить Markdown",
      kind: "markdown",
      height: 260,
      x: 750,
      boardKind: "presentation",
      centerX: 250,
    },
  ])(
    "drags the $kind tool once into the $boardKind canvas at the release point",
    async ({ label, kind, height, x, boardKind, centerX }) => {
      const tool = boardTool(label);
      const target = boardKind === "board" ? board : deck;
      const source = boardKind === "board" ? deck : board;
      const originalIds = new Set(target.document.nodes.map((node) => node.id));
      const targetCanvas =
        host.querySelectorAll(".board-canvas")[boardKind === "board" ? 0 : 1];
      const targetPane = targetCanvas.closest(".board-workspace");
      const hit = vi
        .spyOn(document, "elementFromPoint")
        .mockReturnValue(targetCanvas);
      try {
        await act(async () => {
          pointer(tool, "pointerdown", 170, 450);
          pointer(window, "pointermove", x, 225);
        });
        const preview = document.body.querySelector<HTMLElement>(
          ".canvas-tool-preview",
        );
        expect(preview).not.toBeNull();
        expect(preview?.style.left).toBe(`${x}px`);
        expect(preview?.style.top).toBe("225px");
        expect(
          preview?.querySelector(`.board-artifact-${kind}`),
        ).not.toBeNull();
        expect(writes).toEqual([]);
        await act(async () => {
          pointer(window, "pointerup", x, 220);
          pointerClick(tool);
        });
        expect(document.body.querySelector(".canvas-tool-preview")).toBeNull();
        expect(document.activeElement?.closest(".board-workspace")).toBe(
          targetPane,
        );
        expect(activate).toHaveBeenLastCalledWith(boardKind);
        await act(async () => vi.advanceTimersByTimeAsync(1200));
        expect(writes).toEqual([`/api/boards/${target.id}`]);
        const added = target.document.nodes.filter(
          (node) => !originalIds.has(node.id),
        );
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
          width: 360,
          height,
          position: { x: centerX - 180, y: 220 - height / 2 },
          data: { kind },
        });
        expect(added[0].slideId).toBe(
          boardKind === "presentation" ? "first" : undefined,
        );
        expect(source.document.nodes.map((node) => node.id)).toEqual(
          boardKind === "board" ? ["first-note", "second-note"] : ["source"],
        );
        if (kind === "note") {
          expect(document.activeElement).toBe(targetPane);
          await render("presentation");
          await act(async () => {
            document.activeElement!.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "z",
                ctrlKey: true,
                bubbles: true,
                cancelable: true,
              }),
            );
            await vi.advanceTimersByTimeAsync(1200);
          });
          expect(deck.document.nodes.map((node) => node.id)).toEqual([
            "first-note",
            "second-note",
          ]);
          expect(board.document.nodes.map((node) => node.id)).toEqual([
            "source",
          ]);
          expect(writes).toEqual(["/api/boards/deck", "/api/boards/deck"]);
        }
      } finally {
        hit.mockRestore();
      }
    },
  );

  it.each(["outside", "toolbar", "escape", "escape before a delayed release"])(
    "discards the tool preview without insertion on %s",
    async (reason) => {
      const tool = boardTool("Добавить текст");
      const x = reason === "outside" ? 450 : reason === "toolbar" ? 300 : 750;
      const hit = vi
        .spyOn(document, "elementFromPoint")
        .mockReturnValue(
          reason === "toolbar"
            ? tool
            : host.querySelectorAll(".board-canvas")[1],
        );
      try {
        await act(async () => {
          pointer(tool, "pointerdown", 170, 450);
          pointer(window, "pointermove", x, 225);
        });
        expect(
          document.body.querySelector(".canvas-tool-preview"),
        ).not.toBeNull();
        await act(async () => {
          if (reason.startsWith("escape")) {
            window.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
            );
            if (reason === "escape before a delayed release")
              await vi.advanceTimersByTimeAsync(500);
          }
          pointer(window, "pointerup", x, 225);
          pointerClick(tool);
        });
        expect(document.body.querySelector(".canvas-tool-preview")).toBeNull();
        await act(async () => vi.advanceTimersByTimeAsync(1200));
        expect(writes).toEqual([]);
        expect(board.document.nodes.map((node) => node.id)).toEqual(["source"]);
        expect(deck.document.nodes.map((node) => node.id)).toEqual([
          "first-note",
          "second-note",
        ]);
      } finally {
        hit.mockRestore();
      }
    },
  );

  it("keeps a pointer click below the drag threshold as one ordinary insertion", async () => {
    const tool = boardTool("Добавить текст");
    await act(async () => {
      pointer(tool, "pointerdown", 170, 450);
      pointer(window, "pointermove", 173, 452);
      pointer(window, "pointerup", 173, 452);
      pointerClick(tool);
    });
    expect(document.body.querySelector(".canvas-tool-preview")).toBeNull();
    expect(
      flow.board.nodes?.filter((node) => node.data.kind === "text"),
    ).toHaveLength(1);
    expect(
      host.querySelector('[aria-label="Добавить в презентацию"]'),
    ).toBeNull();
  });

  it("drags a rectangle directly from the shape trigger while focus changes", async () => {
    const trigger = boardTool("Добавить фигуру");
    const focused = boardTool("Добавить текст");
    const targetCanvas = host.querySelectorAll(".board-canvas")[1];
    vi.spyOn(document, "elementFromPoint").mockReturnValue(targetCanvas);
    await act(async () => {
      focused.focus();
      pointer(trigger, "pointerdown", 170, 450);
      focused.blur();
      pointer(window, "pointermove", 750, 225);
    });
    expect(
      document.body.querySelector(".canvas-tool-preview .board-artifact-shape"),
    ).not.toBeNull();
    expect(document.body.querySelector(".shape-picker-menu")).toBeNull();
    await act(async () => {
      pointer(window, "pointerup", 750, 220);
      pointerClick(trigger);
    });
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(writes).toEqual(["/api/boards/deck"]);
    expect(
      deck.document.nodes.filter((node) => node.data.kind === "shape"),
    ).toEqual([
      expect.objectContaining({
        slideId: "first",
        position: { x: 130, y: 140 },
        data: expect.objectContaining({ shape: { type: "rectangle" } }),
      }),
    ]);
  });

  it("drops the chosen ellipse after its picker closes and still supports clicking a shape", async () => {
    const trigger = boardTool("Добавить фигуру");
    const targetCanvas = host.querySelectorAll(".board-canvas")[1];
    vi.spyOn(document, "elementFromPoint").mockReturnValue(targetCanvas);
    const openPicker = async () => {
      await act(async () =>
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
      return document.body.querySelector<HTMLElement>(
        '[role="menuitem"][aria-label="Эллипс"]',
      )!;
    };
    const ellipse = await openPicker();
    expect(ellipse).not.toBeNull();
    await act(async () => {
      ellipse.focus();
      pointer(ellipse, "pointerdown", 170, 380);
      pointer(window, "pointermove", 770, 245);
    });
    expect(document.body.querySelector(".shape-picker-menu")).toBeNull();
    expect(
      document.body.querySelector(".canvas-tool-preview .board-shape-ellipse"),
    ).not.toBeNull();
    await act(async () => pointer(window, "pointerup", 770, 245));
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(writes).toEqual(["/api/boards/deck"]);
    expect(
      deck.document.nodes.filter((node) => node.data.kind === "shape"),
    ).toEqual([
      expect.objectContaining({
        slideId: "first",
        position: { x: 150, y: 165 },
        data: expect.objectContaining({ shape: { type: "ellipse" } }),
      }),
    ]);

    const clicked = await openPicker();
    expect(clicked).not.toBeNull();
    await act(async () => {
      pointer(clicked, "pointerdown", 170, 380);
      pointer(window, "pointerup", 170, 380);
      pointerClick(clicked);
    });
    expect(boardTool("Добавить фигуру").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      flow.board.nodes?.filter((node) => node.data.kind === "shape"),
    ).toHaveLength(1);
  });

  it("lets Enter select a shape after cancelling a drag without a new pointer press", async () => {
    const trigger = boardTool("Добавить фигуру");
    await act(async () => {
      pointer(trigger, "pointerdown", 170, 450);
      pointer(window, "pointermove", 750, 225);
    });
    expect(document.body.querySelector(".canvas-tool-preview")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
      pointer(window, "pointerup", 750, 225);
    });
    expect(document.body.querySelector(".canvas-tool-preview")).toBeNull();
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const ellipse = document.body.querySelector<HTMLElement>(
      '[role="menuitem"][aria-label="Эллипс"]',
    )!;
    expect(ellipse).not.toBeNull();
    await act(async () =>
      ellipse.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(
      flow.board.nodes?.filter((node) => node.data.kind === "shape"),
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ shape: { type: "ellipse" } }),
      }),
    ]);
  });

  it("opens only the target image picker and inserts the chosen image at the original drop point", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 800;
        naturalHeight = 400;
        onload?: () => void;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const previousFetch = fetch;
    vi.stubGlobal("fetch", (path: string, options?: RequestInit) =>
      path === "/api/board-images"
        ? Promise.resolve(
            response({
              id: "a".repeat(64),
              name: "photo.png",
              mimeType: "image/png",
              size: 3,
            }),
          )
        : previousFetch(path, options),
    );
    const [boardInput, deckInput] = host.querySelectorAll<HTMLInputElement>(
      'input[aria-label="Файлы изображений"]',
    );
    const boardPicker = vi.spyOn(boardInput, "click");
    const deckPicker = vi.spyOn(deckInput, "click");
    vi.spyOn(document, "elementFromPoint").mockReturnValue(
      host.querySelector(".presentation-workspace .board-canvas"),
    );
    const tool = boardTool("Добавить изображение");
    await act(async () => {
      pointer(tool, "pointerdown", 170, 450);
      pointer(window, "pointermove", 750, 225);
      pointer(window, "pointerup", 760, 220);
      pointerClick(tool);
    });
    expect(boardPicker).not.toHaveBeenCalled();
    expect(deckPicker).toHaveBeenCalledOnce();
    expect(document.body.querySelector(".canvas-tool-preview")).toBeNull();
    expect(flow.deck.nodes?.some((node) => node.data.kind === "image")).toBe(
      false,
    );
    Object.defineProperty(deckInput, "files", {
      value: [
        new File([new Uint8Array([1, 2, 3])], "photo.png", {
          type: "image/png",
        }),
      ],
    });
    await act(async () =>
      deckInput.dispatchEvent(new Event("change", { bubbles: true })),
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(
        flow.deck.nodes?.find((node) => node.data.kind === "image"),
      ).toMatchObject({
        slideId: "first",
        width: 640,
        height: 320,
        position: { x: -60, y: 60 },
      });
    });
    expect(flow.board.nodes?.some((node) => node.data.kind === "image")).toBe(
      false,
    );
  });

  it("reveals a saved match on its current slide after restoring the camera", async () => {
    await act(async () =>
      registry.openSearchResult({
        kind: "presentation",
        id: deck.id,
        revision: deck.revision,
        nodeId: "second-note",
        slideId: "first",
        field: "node.text",
        match: findSearchMatch("Independent context", "context"),
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(registry.getCanvas("presentation")?.destination()?.slideId).toBe(
      "second",
    );
    expect(
      flow.deck.nodes?.find((node) => node.id === "second-note")?.selected,
    ).toBe(true);
    expect(flow.fits).toContainEqual(["second-note"]);
    expect(writes).toEqual([]);
  });

  it("waits for the search dialog to close and does not steal focus after cancellation", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);
    const controller = new AbortController();
    await act(async () =>
      registry.openSearchResult(
        {
          kind: "presentation",
          id: deck.id,
          revision: deck.revision,
          nodeId: "second-note",
          field: "node.text",
          match: findSearchMatch("Independent context", "context"),
        },
        { signal: controller.signal },
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(flow.fits).not.toContainEqual(["second-note"]);
    controller.abort();
    dialog.remove();
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(flow.fits).not.toContainEqual(["second-note"]);
    expect(
      flow.deck.nodes?.find((node) => node.id === "second-note")?.selected,
    ).not.toBe(true);
  });

  it("reuses a current board without replacing its local changes", async () => {
    await act(async () => moveSource(250, 100, false));
    await act(async () =>
      registry.openSearchResult({
        kind: "board",
        id: board.id,
        revision: board.revision,
        nodeId: "source",
        field: "node.text",
        match: findSearchMatch("Independent context", "context"),
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(
      flow.board.nodes?.find((node) => node.id === "source"),
    ).toMatchObject({
      position: { x: 250, y: 100 },
      selected: true,
    });
    expect(writes).toEqual([]);
  });

  it("refreshes a saved match through the merge without losing disjoint local changes", async () => {
    await act(async () => moveSource(250, 100, false));
    board.revision++;
    board.document.nodes.push({
      ...note("fresh"),
      data: { kind: "note", title: "New note", text: "Freshly saved target" },
    });
    await act(async () =>
      registry.openSearchResult({
        kind: "board",
        id: board.id,
        revision: board.revision,
        nodeId: "fresh",
        field: "node.text",
        match: findSearchMatch("Freshly saved target", "target"),
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(flow.board.nodes?.find((node) => node.id === "fresh")).toMatchObject(
      {
        selected: true,
        data: { text: "Freshly saved target" },
      },
    );
    expect(
      flow.board.nodes?.find((node) => node.id === "source")?.position,
    ).toEqual({ x: 250, y: 100 });
    expect(writes).toEqual([]);
  });

  it.each(["board", "presentation"] as const)(
    "creates a styled text block in the chosen %s panel and preserves it through undo/redo",
    async (kind) => {
      await render(kind);
      const panel = host.querySelector<HTMLElement>(
        kind === "presentation"
          ? ".presentation-workspace"
          : ".board-workspace:not(.presentation-workspace)",
      )!;
      const add = panel.querySelector<HTMLButtonElement>(
        '[aria-label="Добавить текст"]',
      );
      expect(add).not.toBeNull();
      await act(async () => add!.click());
      const controller = kind === "presentation" ? flow.deck : flow.board;
      const text = controller.nodes!.find((node) => node.data.kind === "text")!;
      expect(text).toMatchObject({
        width: 360,
        height: 120,
        data: {
          kind: "text",
          text: "Текст",
          textStyle: { fontFamily: "sans", fontSize: 32, textAlign: "left" },
        },
      });
      if (kind === "presentation")
        expect(text).toMatchObject({
          slideId: "first",
          position: { x: 620, y: 390 },
        });
      else expect(text.dragHandle).toBe(".board-text-content");
      const inspector = panel.querySelector('[aria-label="Свойства блока"]')!;
      expect(
        inspector.querySelector('[aria-label="Текст блока"]'),
      ).not.toBeNull();
      await act(async () => {
        inspector
          .querySelector<HTMLButtonElement>('[aria-label="Жирный"]')!
          .click();
        await vi.advanceTimersByTimeAsync(1200);
      });
      const target = kind === "presentation" ? deck : board;
      const other = kind === "presentation" ? board : deck;
      expect(
        target.document.nodes.find((node) => node.id === text.id)?.data
          .textStyle?.bold,
      ).toBe(true);
      expect(other.document.nodes.some((node) => node.id === text.id)).toBe(
        false,
      );
      await act(async () => {
        panel
          .querySelector<HTMLButtonElement>(
            '[aria-label="Отменить изменение"]',
          )!
          .click();
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(
        target.document.nodes.find((node) => node.id === text.id)?.data
          .textStyle?.bold,
      ).toBeFalsy();
      await act(async () => {
        panel
          .querySelector<HTMLButtonElement>(
            '[aria-label="Повторить изменение"]',
          )!
          .click();
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(
        target.document.nodes.find((node) => node.id === text.id)?.data
          .textStyle?.bold,
      ).toBe(true);
    },
  );

  it.each(["board", "presentation"] as const)(
    "creates a shape in the chosen %s panel and preserves it through undo/redo",
    async (kind) => {
      await render(kind);
      const panel = host.querySelector<HTMLElement>(
        kind === "presentation"
          ? ".presentation-workspace"
          : ".board-workspace:not(.presentation-workspace)",
      )!;
      const trigger = panel.querySelector<HTMLButtonElement>(
        '[aria-label="Добавить фигуру"]',
      );
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger!.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
        );
      });
      const option = document.querySelector<HTMLElement>(
        '[role="menuitem"][aria-label="Ромб"]',
      );
      expect(option).not.toBeNull();
      await act(async () => option!.click());
      const controller = kind === "presentation" ? flow.deck : flow.board;
      const shape = controller.nodes!.find(
        (node) => node.data.kind === "shape",
      )!;
      expect(shape).toMatchObject({
        width: 180,
        height: 180,
        data: { kind: "shape", text: "", shape: { type: "diamond" } },
      });
      if (kind === "presentation")
        expect(shape).toMatchObject({
          slideId: "first",
          position: { x: 710, y: 360 },
        });
      expect(
        panel.querySelector('[aria-label="Свойства блока"]'),
      ).not.toBeNull();
      await act(async () => {
        panel
          .querySelector<HTMLButtonElement>(
            '[aria-label="Отменить изменение"]',
          )!
          .click();
      });
      const undone = kind === "presentation" ? flow.deck : flow.board;
      expect(undone.nodes!.some((node) => node.id === shape.id)).toBe(false);
      await act(async () => {
        panel
          .querySelector<HTMLButtonElement>(
            '[aria-label="Повторить изменение"]',
          )!
          .click();
        await vi.advanceTimersByTimeAsync(1200);
      });
      const target = kind === "presentation" ? deck : board;
      expect(
        target.document.nodes.find((node) => node.id === shape.id)?.data,
      ).toMatchObject({ kind: "shape", shape: { type: "diamond" } });
    },
  );

  it("snaps presentation blocks to the slide frame and persists the final position", async () => {
    await render("presentation");
    await act(async () =>
      flow.deck.onNodesChange!([
        {
          type: "position",
          id: "first-note",
          position: { x: 1197, y: 696 },
          dragging: true,
        },
      ]),
    );
    expect(
      flow.deck.nodes?.find((node) => node.id === "first-note")?.position,
    ).toEqual({ x: 1200, y: 700 });
    expect(
      host.querySelectorAll(
        ".presentation-workspace .board-alignment-guides line",
      ),
    ).toHaveLength(2);
    await act(async () => {
      flow.deck.onNodesChange!([
        {
          type: "position",
          id: "first-note",
          position: { x: 1197, y: 696 },
          dragging: false,
        },
      ]);
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(
      deck.document.nodes.find((node) => node.id === "first-note")?.position,
    ).toEqual({ x: 1200, y: 700 });
    expect(
      deck.document.nodes.find((node) => node.id === "second-note")?.position,
    ).toEqual({ x: 0, y: 0 });
    expect(host.querySelector(".board-alignment-guides")).toBeNull();
  });

  it("allows a free drag past the slide frame and disables snapping with Alt mid-gesture", async () => {
    await render("presentation");
    await act(async () =>
      flow.deck.onNodesChange!([
        {
          type: "position",
          id: "first-note",
          position: { x: -80, y: 250 },
          dragging: true,
        },
      ]),
    );
    expect(
      flow.deck.nodes?.find((node) => node.id === "first-note")?.position.x,
    ).toBe(-80);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Alt", altKey: true }),
      );
      flow.deck.onNodesChange!([
        {
          type: "position",
          id: "first-note",
          position: { x: 4, y: 250 },
          dragging: true,
        },
      ]);
    });
    expect(
      flow.deck.nodes?.find((node) => node.id === "first-note")?.position.x,
    ).toBe(4);
    expect(flow.deck.nodes).toHaveLength(1);
    expect(host.querySelector(".board-alignment-guides")).toBeNull();
  });

  it.each(["board", "presentation"] as const)(
    "adds uploaded, dropped and pasted images to the active %s",
    async (kind) => {
      vi.useRealTimers();
      await render(kind);
      vi.stubGlobal(
        "Image",
        class {
          naturalWidth = 800;
          naturalHeight = 400;
          onload?: () => void;
          set src(_value: string) {
            queueMicrotask(() => this.onload?.());
          }
        },
      );
      const previousFetch = fetch;
      const uploads: unknown[] = [];
      vi.stubGlobal("fetch", (path: string, options: RequestInit = {}) => {
        if (path === "/api/board-images") {
          uploads.push(JSON.parse(String(options.body)));
          return Promise.resolve(
            response({
              id: "a".repeat(64),
              name: "photo.png",
              mimeType: "image/png",
              size: 3,
            }),
          );
        }
        return previousFetch(path, options);
      });
      const workspace =
        host.querySelectorAll<HTMLElement>(".board-workspace")[
          kind === "board" ? 0 : 1
        ];
      const file = () =>
        new File([new Uint8Array([1, 2, 3])], "photo.png", {
          type: "image/png",
        });
      const nodes = () =>
        (kind === "board" ? flow.board : flow.deck).nodes!.filter(
          (node) => node.data.kind === "image",
        );
      const waitForImage = async (count: number) => {
        for (let index = 0; index < 30 && nodes().length < count; index++)
          await act(
            async () => new Promise((resolve) => setTimeout(resolve, 5)),
          );
        expect(nodes()).toHaveLength(count);
      };
      const input =
        workspace.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", {
        configurable: true,
        value: [file()],
      });
      await act(async () =>
        input.dispatchEvent(new Event("change", { bubbles: true })),
      );
      await waitForImage(1);
      const drop = new MouseEvent("drop", {
        bubbles: true,
        cancelable: true,
        clientX: 600,
        clientY: 200,
      });
      Object.defineProperty(drop, "dataTransfer", {
        value: { files: [file()], getData: () => "" },
      });
      await act(async () =>
        workspace.querySelector(".board-canvas")!.dispatchEvent(drop),
      );
      await waitForImage(2);
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { files: [file()], getData: () => "" },
      });
      await act(async () => workspace.dispatchEvent(paste));
      await waitForImage(3);
      const itemImage = file();
      const items = [
        { kind: "string", type: "text/html", getAsFile: () => null },
        { kind: "file", type: "image/png", getAsFile: () => itemImage },
      ];
      const pastePayload = async (
        payload: { files: File[]; items?: typeof items },
        target: Element = workspace,
      ) => {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: { ...payload, getData: () => "" },
        });
        await act(async () => target.dispatchEvent(event));
        return event;
      };
      // Some clipboard bridges expose the image item without populating files.
      expect((await pastePayload({ files: [], items })).defaultPrevented).toBe(
        true,
      );
      await waitForImage(4);
      // When both representations exist, the same image is inserted only once.
      await pastePayload({ files: [itemImage], items });
      await waitForImage(5);
      expect(uploads).toHaveLength(5);
      const inputTarget = workspace.appendChild(
        document.createElement("textarea"),
      );
      expect(
        (await pastePayload({ files: [], items }, inputTarget))
          .defaultPrevented,
      ).toBe(false);
      inputTarget.remove();
      const inactiveWorkspace =
        host.querySelectorAll<HTMLElement>(".board-workspace")[
          kind === "board" ? 1 : 0
        ];
      expect(
        (await pastePayload({ files: [], items }, inactiveWorkspace))
          .defaultPrevented,
      ).toBe(false);
      expect(
        (
          await pastePayload({
            files: [
              new File(["ordinary text"], "notes.txt", { type: "text/plain" }),
            ],
          })
        ).defaultPrevented,
      ).toBe(false);
      expect(uploads).toHaveLength(5);
      expect(nodes()[0]).toMatchObject({
        width: 640,
        height: 320,
        data: { kind: "image", image: { id: "a".repeat(64) } },
      });
      expect(
        nodes().every(
          (node) =>
            node.slideId === (kind === "presentation" ? "first" : undefined),
        ),
      ).toBe(true);
    },
  );

  it("moves a static copy of rendered card content outside the clipped panes and clears it on Escape", async () => {
    const source = document.createElement("div");
    source.className = "react-flow__node react-flow__node-artifact";
    source.dataset.id = "source";
    source.style.cssText =
      "width:400px;height:200px;opacity:0;transform:translate(10px, 20px);z-index:1000";
    source.innerHTML = `
      <article class="board-artifact">
        <div id="source-title">Rendered title</div>
        <textarea></textarea>
        <canvas width="800" height="400"></canvas>
        <img alt="Rendered image" />
        <iframe title="Chart in isolated frame"></iframe>
      </article>
    `;
    const textarea = source.querySelector("textarea")!;
    textarea.value = "Currently edited text";
    textarea.scrollTop = 25;
    const canvas = source.querySelector("canvas")!;
    const image = source.querySelector("img")!;
    Object.defineProperties(image, {
      naturalWidth: { value: 320 },
      naturalHeight: { value: 240 },
    });
    host.querySelector(".board-canvas")!.append(source);
    const drawImage = vi.fn();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    getContext.mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    try {
      flow.viewport = { x: 20, y: 30, zoom: 0.5 };
      await act(async () => moveSource(750, 200, true));
      const overlay = document.body.querySelector<HTMLElement>(
        ".canvas-drag-overlay",
      )!;
      expect(overlay).not.toBeNull();
      expect(host.contains(overlay)).toBe(false);
      expect(overlay.hasAttribute("inert")).toBe(true);
      expect(
        overlay.querySelector<HTMLElement>(".canvas-drag-node")?.style.zIndex,
      ).toBe("1000");
      expect(overlay.textContent).toContain("Rendered title");
      expect(overlay.querySelector("textarea")?.value).toBe(
        "Currently edited text",
      );
      expect(overlay.querySelector("textarea")?.scrollTop).toBe(25);
      expect(overlay.querySelector("#source-title")).toBeNull();
      expect(overlay.querySelector("img,iframe")).toBeNull();
      expect(overlay.textContent).toContain("Chart in isolated frame");
      expect(drawImage.mock.calls).toEqual([
        [canvas, 0, 0, 800, 400],
        [image, 0, 0, 320, 240],
      ]);
      expect(
        overlay.querySelector<HTMLElement>(".canvas-drag-world")?.style
          .transform,
      ).toBe("translate(20px, 30px) scale(0.5)");
      expect(
        flow.board.nodes!.find((node) => node.id === "source")!.style?.opacity,
      ).toBe(0);
      const copy = overlay.querySelector(".board-artifact");
      source.querySelector("#source-title")!.textContent =
        "Changed during drag";
      await act(async () => moveSource(780, 200, true));
      expect(overlay.querySelector(".board-artifact")).toBe(copy);
      expect(overlay.textContent).toContain("Rendered title");
      expect(drawImage).toHaveBeenCalledTimes(2);
      await act(async () =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
      );
      expect(document.body.querySelector(".canvas-drag-overlay")).toBeNull();
      expect(board.document.nodes[0].position).toEqual({ x: 0, y: 0 });
    } finally {
      getContext.mockRestore();
      source.remove();
    }
  });

  it("copies across panes without persisting any intermediate source motion", async () => {
    await act(async () => {
      moveSource(750, 200, true);
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(writes).toEqual([]);
    expect(flow.board.autoPanOnNodeDrag).toBe(false);
    expect(
      localStorage.getItem("miracle:board-draft:project:source-board"),
    ).toBeNull();
    flow.viewport = { x: -360, y: 0, zoom: 1 };
    await act(async () => moveSource(750, 200, false));
    expect(flow.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(writes).toEqual(["/api/boards/deck"]);
    expect(board.document.nodes[0].position).toEqual({ x: 0, y: 0 });
    expect(deck.document.nodes.at(-1)).toMatchObject({
      slideId: "first",
      position: { x: 50, y: 100 },
      data: board.document.nodes[0].data,
    });
    expect(deck.document.nodes.at(-1)?.id).not.toBe("source");
  });

  it("cancels an out-of-pane drop and a gesture cancelled with Escape", async () => {
    await act(async () => moveSource(450, 200, true));
    await act(async () => moveSource(450, 200, false));
    await act(async () => {
      moveSource(750, 200, true);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      moveSource(750, 200, false);
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(writes).toEqual([]);
    expect(flow.board.nodes![0].position).toEqual({ x: 0, y: 0 });
    expect(deck.document.nodes).toHaveLength(2);
  });

  it("supplies only the active canvas and slide selection to the agent", async () => {
    expect(project.context()).toEqual({
      boardId: "source-board",
      boardNodes: [],
    });
    await render("presentation");
    await act(async () => {
      (
        host.querySelector(
          '.presentation-slide-thumbnail[title="Second"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(flow.deck.nodes?.map((node) => node.id)).toEqual(["second-note"]);
    await act(async () =>
      flow.deck.onNodesChange!([
        { type: "select", id: "second-note", selected: true },
      ]),
    );
    expect(project.context()).toEqual({
      boardId: "deck",
      slideId: "second",
      boardNodes: [{ id: "second-note", title: "second-note" }],
    });
    await render("board");
    expect(project.context()).toEqual({
      boardId: "source-board",
      boardNodes: [],
    });
  });

  it("captures a keyboard-selected connector only on its active slide and drops it on deletion", async () => {
    await render("presentation");
    deck = {
      ...deck,
      revision: deck.revision + 1,
      document: {
        ...deck.document,
        edges: [
          {
            id: "first-arrow",
            slideId: "first",
            label: "Переход",
            sourcePoint: { x: 100, y: 500 },
            targetPoint: { x: 700, y: 500 },
          },
          {
            id: "second-arrow",
            slideId: "second",
            sourcePoint: { x: 100, y: 500 },
            targetPoint: { x: 700, y: 500 },
          },
        ],
      },
    };
    await act(async () =>
      project.emit({ id: 10, type: "board.updated", data: deck }),
    );
    await act(async () =>
      flow.deck.onEdgesChange!([
        { type: "select", id: "first-arrow", selected: true },
      ]),
    );
    expect(project.context()).toEqual({
      boardId: "deck",
      slideId: "first",
      boardNodes: [],
      boardEdges: [{ id: "first-arrow", label: "Переход" }],
    });
    const switchSlide = async (title: string) => {
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            `.presentation-slide-thumbnail[title="${title}"]`,
          )!
          .click(),
      );
    };
    await switchSlide("Second");
    expect(project.context().boardEdges).toBeUndefined();
    await act(async () =>
      flow.deck.onEdgesChange!([
        { type: "select", id: "second-arrow", selected: true },
      ]),
    );
    expect(project.context().boardEdges).toEqual([
      { id: "second-arrow", label: "Стрелка" },
    ]);
    await switchSlide("First");
    expect(project.context().boardEdges?.[0]?.id).toBe("first-arrow");
    deck = {
      ...deck,
      revision: deck.revision + 1,
      document: { ...deck.document, edges: deck.document.edges.slice(1) },
    };
    await act(async () =>
      project.emit({ id: 11, type: "board.updated", data: deck }),
    );
    expect(project.context().boardEdges).toBeUndefined();
  });

  async function clickDeckNode(modifiers: MouseEventInit = {}) {
    await act(async () => {
      flow.deck.onNodesChange!([
        { type: "select", id: "first-note", selected: true },
      ]);
    });
    await act(async () => {
      flow.deck.onNodeClick!(
        new MouseEvent("click", modifiers) as never,
        flow.deck.nodes![0],
      );
    });
  }

  it("opens presentation block editing on click without stealing canvas focus", async () => {
    await render("presentation");
    const workspace = host.querySelector<HTMLElement>(
      '[aria-label="Презентация"]',
    )!;
    await act(async () => workspace.focus());
    await clickDeckNode();
    expect(host.querySelector('[aria-label="Свойства блока"]')).not.toBeNull();
    expect(
      host.querySelector<HTMLTextAreaElement>('[aria-label="Текст заметки"]')
        ?.value,
    ).toBe("Independent context");
    expect(document.activeElement).toBe(workspace);
  });

  it.each([true, false])(
    "accepts the next click after a drag (trailing click: %s)",
    async (trailingClick) => {
      await render("presentation");
      await act(async () => {
        const node = flow.deck.nodes![0];
        flow.deck.onNodeDragStart!(new MouseEvent("mousedown") as never, node, [
          node,
        ]);
        flow.deck.onNodeDragStop!(new MouseEvent("mouseup") as never, node, [
          node,
        ]);
        if (trailingClick)
          flow.deck.onNodeClick!(new MouseEvent("click") as never, node);
      });
      expect(host.querySelector('[aria-label="Свойства блока"]')).toBeNull();
      await act(async () => {
        host
          .querySelector('[aria-label="Презентация"]')!
          .dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      await clickDeckNode();
      expect(
        host.querySelector('[aria-label="Свойства блока"]'),
      ).not.toBeNull();
    },
  );

  it.each(["Backspace", "Delete"])(
    "%s removes the clicked slide block, preserving other slides and the board",
    async (key) => {
      await render("presentation");
      await clickDeckNode();
      const workspace = host.querySelector<HTMLElement>(
        '[aria-label="Презентация"]',
      )!;
      await act(async () => {
        workspace.focus();
        workspace.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(deck.document.nodes.map((node) => node.id)).toEqual([
        "second-note",
      ]);
      expect(board.document.nodes.map((node) => node.id)).toEqual(["source"]);
      expect(host.querySelector('[aria-label="Свойства блока"]')).toBeNull();
    },
  );

  it("preserves modifier selection, native text deletion and inactive-canvas state", async () => {
    await render("presentation");
    await clickDeckNode({ shiftKey: true });
    expect(host.querySelector('[aria-label="Свойства блока"]')).toBeNull();
    await clickDeckNode();
    const text = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Текст заметки"]',
    )!;
    await act(async () => {
      text.focus();
      text.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
      );
    });
    expect(flow.deck.nodes).toHaveLength(1);
    await render("board");
    await act(async () => {
      host
        .querySelector('[aria-label="Презентация"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
        );
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(writes).toEqual([]);
    expect(deck.document.nodes).toHaveLength(2);
  });

  it("saves presentation text from the inspector and protects an agent-locked block", async () => {
    await render("presentation");
    await clickDeckNode();
    const text = host.querySelector<HTMLTextAreaElement>(
      '[aria-label="Текст заметки"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(text, "Updated slide content");
      text.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(deck.document.nodes[0].data.text).toBe("Updated slide content");
    await act(async () => {
      project.emit({
        id: 20,
        type: "agent.work",
        data: {
          locks: [
            {
              target: { kind: "board-node", boardId: "deck", id: "first-note" },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        },
      });
    });
    expect(text.readOnly).toBe(true);
    await act(async () => {
      const workspace = host.querySelector<HTMLElement>(
        '[aria-label="Презентация"]',
      )!;
      workspace.focus();
      workspace.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(1200);
    });
    expect(deck.document.nodes).toHaveLength(2);
    expect(writes).toEqual(["/api/boards/deck"]);
  });
});
