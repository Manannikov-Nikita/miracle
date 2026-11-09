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
              }),
              createElement(BoardWorkspace, {
                ...common,
                key: "deck",
                kind: "presentation",
                active: active === "presentation",
              }),
            ],
          }),
        ),
      ),
    );
  }
  beforeEach(async () => {
    localStorage.clear();
    flow.viewport = { x: 0, y: 0, zoom: 1 };
    flow.fits = [];
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
