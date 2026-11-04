// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactFlowProps } from "@xyflow/react";
import type { Board } from "../src/shared/types";
import BoardWorkspace from "../src/client/board/BoardWorkspace";

// Keep the actual workspace, history and persistence; jsdom cannot perform
// XYFlow's measured canvas drag, so deliver its documented change sequence.
const flow = vi.hoisted(() => ({ props: {} as ReactFlowProps }));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  const controller = {
    getZoom: () => 1,
    setViewport: async () => true,
    fitView: async () => true,
  };
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    ReactFlow: (props: ReactFlowProps) => {
      flow.props = props;
      return props.children;
    },
    useReactFlow: () => controller,
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

describe("Option drag copies board blocks", () => {
  let host: HTMLDivElement;
  let root: Root;
  let board: Board;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    flow.props = {};
    board = {
      id: "board",
      name: "Board",
      revision: 1,
      updatedAt: "2026-11-04T00:00:00.000Z",
      document: {
        schemaVersion: 1,
        nodes: [
          {
            id: "a",
            type: "artifact",
            position: { x: 0, y: 0 },
            width: 400,
            height: 260,
            data: {
              kind: "result",
              title: "Result",
              resultSetId: "snapshot",
              view: "table",
              source: { connectionId: "connection", sql: "select 1" },
              sourceRevision: 4,
            },
          },
          {
            id: "b",
            type: "artifact",
            position: { x: 600, y: 0 },
            data: { kind: "markdown", title: "Markdown", text: "**Context**" },
          },
          {
            id: "c",
            type: "artifact",
            position: { x: 1200, y: 0 },
            data: { kind: "note", title: "Note", text: "External" },
          },
        ],
        edges: [
          {
            id: "internal",
            source: "a",
            target: "b",
            sourceHandle: "right",
            targetHandle: "left",
            label: "Related",
            bend: { x: 10, y: 20 },
            appearance: { color: "#91cbb3" },
          },
          { id: "external", source: "b", target: "c" },
        ],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    };
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards")
        return response([
          {
            id: board.id,
            name: board.name,
            revision: board.revision,
            updatedAt: board.updatedAt,
          },
        ]);
      if (path !== "/api/boards/board")
        throw new Error(`Unexpected request: ${path}`);
      if (options.method === "PATCH") {
        board.document = JSON.parse(options.body as string).document;
        board.revision++;
      }
      return response(board);
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function open() {
    await act(async () =>
      root.render(
        createElement(BoardWorkspace, {
          workspaceId: "option-drag",
          onIncomingConsumed() {},
          onOpenSource() {},
          onNotify() {},
        }),
      ),
    );
  }
  const nodes = () =>
    flow.props.nodes!.filter((node) => node.type === "artifact");
  const originals = () =>
    nodes().filter((node) => ["a", "b", "c"].includes(node.id));
  const copies = () =>
    nodes().filter((node) => !["a", "b", "c"].includes(node.id));
  async function start(ids = ["a"], altKey = true) {
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousedown", { altKey }));
      flow.props.onNodesChange!(
        ids.map((id) => ({ type: "select", id, selected: true })),
      );
    });
    await act(async () =>
      flow.props.onNodeDragStart?.(
        new MouseEvent("mousemove", { altKey }),
        nodes().find((node) => node.id === ids[0])!,
        nodes().filter((node) => ids.includes(node.id)),
      ),
    );
  }
  async function position(
    ids: string[],
    x: number,
    y: number,
    dragging: boolean,
  ) {
    await act(async () =>
      flow.props.onNodesChange!(
        ids.map((id) => ({
          type: "position",
          id,
          position: { x: x + (id === "b" ? 600 : 0), y },
          dragging,
        })),
      ),
    );
  }
  async function history(label: string) {
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(),
    );
  }

  it("leaves the original snapshot fixed, moves one new identity, and saves one undoable copy", async () => {
    await open();
    const original = nodes()[0];
    await start();
    await position(["a"], 100, 150, true);
    expect(copies()).toHaveLength(1);
    const copyId = copies()[0].id;
    expect(nodes()[0].position).toEqual({ x: 0, y: 0 });
    expect(copies()[0]).toMatchObject({
      position: { x: 100, y: 150 },
      width: 400,
      height: 260,
      data: original.data,
    });
    expect(copies()[0].data).not.toBe(original.data);
    expect(copies()[0].data.source).not.toBe(original.data.source);
    await position(["a"], 250, 180, true);
    await position(["a"], 250, 180, false);
    expect(copies()).toHaveLength(1);
    expect(copies()[0]).toMatchObject({
      id: copyId,
      position: { x: 250, y: 180 },
      selected: true,
    });
    expect(nodes()[0]).toMatchObject({
      position: { x: 0, y: 0 },
      selected: false,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(board.document.nodes).toHaveLength(4);
    expect(
      board.document.nodes.find((node) => node.id === copyId)?.data,
    ).toEqual(original.data);
    await history("Отменить изменение");
    expect(copies()).toHaveLength(0);
    expect(
      host.querySelector<HTMLButtonElement>(
        '[aria-label="Отменить изменение"]',
      )!.disabled,
    ).toBe(true);
    await history("Повторить изменение");
    expect(copies()[0]).toMatchObject({
      id: copyId,
      position: { x: 250, y: 180 },
    });
  });

  it("copies a selection and its internal links without attaching copies to outside nodes", async () => {
    await open();
    await start(["a", "b"]);
    await position(["a", "b"], 200, 300, true);
    await position(["a", "b"], 200, 300, false);
    expect(originals().map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 600, y: 0 },
      { x: 1200, y: 0 },
    ]);
    expect(copies().map((node) => node.position)).toEqual([
      { x: 200, y: 300 },
      { x: 800, y: 300 },
    ]);
    const edges = flow.props.edges!;
    expect(edges).toHaveLength(3);
    const copied = edges.find(
      (edge) => !["internal", "external"].includes(edge.id),
    )!;
    expect(copied).toMatchObject({
      source: copies()[0].id,
      target: copies()[1].id,
      label: "Related",
      bend: { x: 10, y: 20 },
      appearance: { color: "#91cbb3" },
    });
    await history("Отменить изменение");
    expect(nodes()).toHaveLength(3);
    expect(flow.props.edges).toHaveLength(2);
  });

  it("preserves a marquee node group when XYFlow also selects its internal edge, while explicit edge clicks replace that group", async () => {
    await open();
    await act(async () => {
      flow.props.onNodesChange!([
        { type: "select", id: "a", selected: true },
        { type: "select", id: "b", selected: true },
      ]);
      flow.props.onEdgesChange!([
        { type: "select", id: "internal", selected: true },
      ]);
    });
    expect(
      nodes()
        .filter((node) => node.selected)
        .map((node) => node.id),
    ).toEqual(["a", "b"]);
    expect(
      flow.props.edges!.find((edge) => edge.id === "internal")!.selected,
    ).toBe(false);
    await act(async () =>
      flow.props.onEdgeClick?.(
        new MouseEvent("click") as any,
        flow.props.edges!.find((edge) => edge.id === "internal")!,
      ),
    );
    expect(nodes().filter((node) => node.selected)).toHaveLength(0);
    expect(
      flow.props.edges!.find((edge) => edge.id === "internal")!.selected,
    ).toBe(true);
  });

  it("does not copy on Option-click or Option keyboard moves, and normal dragging still moves the original", async () => {
    await open();
    await start();
    await act(async () =>
      flow.props.onNodeDragStop?.(
        new MouseEvent("mouseup", { altKey: true }),
        nodes()[0],
        [nodes()[0]],
      ),
    );
    expect(copies()).toHaveLength(0);
    await position(["a"], 10, 0, false);
    expect(copies()).toHaveLength(0);
    await start(["a"], false);
    await position(["a"], 100, 150, true);
    await position(["a"], 100, 150, false);
    expect(nodes()[0].position).toEqual({ x: 100, y: 150 });
    expect(copies()).toHaveLength(0);
  });

  it.each(["Escape", "blur", "pointercancel"])(
    "cancels a duplicate with %s and ignores remaining drag events",
    async (event) => {
      await open();
      await start();
      await position(["a"], 100, 150, true);
      expect(copies()).toHaveLength(1);
      await act(async () =>
        window.dispatchEvent(
          event === "Escape"
            ? new KeyboardEvent("keydown", { key: "Escape", altKey: true })
            : new Event(event),
        ),
      );
      await position(["a"], 400, 450, true);
      await position(["a"], 400, 450, false);
      expect(copies()).toHaveLength(0);
      expect(nodes()[0].position).toEqual({ x: 0, y: 0 });
      expect(
        host.querySelector<HTMLButtonElement>(
          '[aria-label="Отменить изменение"]',
        )!.disabled,
      ).toBe(true);
    },
  );

  it("keeps the same duplicate when Option is released during the gesture", async () => {
    await open();
    await start();
    await position(["a"], 100, 150, true);
    const id = copies()[0]?.id;
    await act(async () =>
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Alt", altKey: false }),
      ),
    );
    await position(["a"], 300, 350, true);
    await position(["a"], 300, 350, false);
    expect(copies()).toHaveLength(1);
    expect(copies()[0]).toMatchObject({ id, position: { x: 300, y: 350 } });
    expect(nodes()[0].position).toEqual({ x: 0, y: 0 });
  });

  it("waits through a zero-displacement drag event before making a copy", async () => {
    await open();
    await start();
    await position(["a"], 0, 0, true);
    expect(copies()).toHaveLength(0);
    await position(["a"], 100, 150, true);
    await position(["a"], 100, 150, false);
    expect(copies()).toHaveLength(1);
    expect(nodes()[0].position).toEqual({ x: 0, y: 0 });
  });

  it("keeps Option resizing separate from copying", async () => {
    await open();
    await start();
    await act(async () =>
      flow.props.onNodesChange!([
        {
          type: "dimensions",
          id: "a",
          dimensions: { width: 500, height: 350 },
          setAttributes: true,
          resizing: true,
        },
        { type: "position", id: "a", position: { x: 20, y: 30 } },
      ]),
    );
    await act(async () =>
      flow.props.onNodesChange!([
        {
          type: "dimensions",
          id: "a",
          dimensions: { width: 500, height: 350 },
          resizing: false,
        },
      ]),
    );
    expect(copies()).toHaveLength(0);
    expect(nodes()[0]).toMatchObject({
      width: 500,
      height: 350,
      position: { x: 20, y: 30 },
    });
  });
});
