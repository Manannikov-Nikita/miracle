// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactFlowProps } from "@xyflow/react";
import type { Board } from "../src/shared/types";
import BoardWorkspace from "../src/client/board/BoardWorkspace";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";

// Keep the workspace, XYFlow, cards and editors real. Observe the documented
// XYFlow change boundary and editor renders; only browser layout and HTTP are fake.
const probe = vi.hoisted(() => ({
  flow: {} as ReactFlowProps,
  renders: new Map<string, number>(),
}));
vi.mock("../src/client/board/BoardFlow", async (load) => {
  const { default: BoardFlow } =
    await load<typeof import("../src/client/board/BoardFlow")>();
  return {
    default: (props: Parameters<typeof BoardFlow>[0]) => {
      probe.flow = props as ReactFlowProps;
      return createElement(BoardFlow, { ...props, width: 1000, height: 800 });
    },
  };
});
vi.mock("../src/client/board/StickyNoteEditor", async (load) => {
  const { default: Editor } =
    await load<typeof import("../src/client/board/StickyNoteEditor")>();
  return {
    default: (props: Parameters<typeof Editor>[0]) => {
      probe.renders.set(props.value, (probe.renders.get(props.value) ?? 0) + 1);
      return createElement(Editor, props);
    },
  };
});

let host: HTMLDivElement;
let root: Root;
let board: Board;
let project: ProjectSync;
beforeEach(() => {
  project = new ProjectSync();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 800,
    width: 1000,
    height: 800,
    toJSON() {},
  });
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  board = {
    id: "drag-render",
    name: "Drag rendering",
    revision: 1,
    updatedAt: "2026-11-06T00:00:00Z",
    document: {
      schemaVersion: 1,
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: ["moving", "stationary"].map((id, index) => ({
        id,
        type: "artifact",
        position: { x: index * 600, y: 0 },
        width: 360,
        height: 260,
        data: { kind: "note", title: id, text: id },
      })),
    },
  };
  vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
    if (path !== "/api/boards" && path !== "/api/boards/drag-render")
      throw new Error(`Unexpected request: ${path}`);
    if (options.method === "PATCH") {
      board = {
        ...board,
        revision: board.revision + 1,
        document: JSON.parse(options.body as string).document,
      };
    }
    return new Response(
      JSON.stringify(path === "/api/boards" ? [board] : board),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  });
  probe.renders.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function open() {
  await act(async () =>
    root.render(
      createElement(
        ProjectSyncContext.Provider,
        { value: project },
        createElement(BoardWorkspace, {
          workspaceId: "drag-render",
          onIncomingConsumed() {},
          onOpenSource() {},
          onNotify() {},
        }),
      ),
    ),
  );
  expect(host.querySelectorAll("textarea")).toHaveLength(2);
  await act(async () =>
    probe.flow.onNodesChange!([
      { type: "select", id: "moving", selected: true },
    ]),
  );
  probe.renders.clear();
}
async function move(x: number, dragging = true) {
  await act(async () =>
    probe.flow.onNodesChange!([
      { type: "position", id: "moving", position: { x, y: 87 }, dragging },
    ]),
  );
}

it("keeps unchanged card contents out of position-only drag updates", async () => {
  await open();
  await move(123);
  await move(151);
  await move(151, false);
  expect(probe.flow.nodes!.find((n) => n.id === "moving")!.position).toEqual({
    x: 151,
    y: 87,
  });
  expect(probe.renders.get("stationary") ?? 0).toBe(0);
  expect(probe.renders.get("moving") ?? 0).toBe(0);
});

it("keeps card actions current and displays undo changes after a drag", async () => {
  await open();
  await move(123);
  await move(123, false);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        'article[aria-label="stationary"] button[aria-label="Удалить блок"]',
      )!
      .click(),
  );
  expect(host.querySelector('article[aria-label="stationary"]')).toBeNull();
  expect(
    probe.flow.nodes!.map((n) => ({ id: n.id, position: n.position })),
  ).toEqual([{ id: "moving", position: { x: 123, y: 87 } }]);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Отменить изменение"]',
      )!
      .click(),
  );
  expect(
    host.querySelector('article[aria-label="stationary"] textarea'),
  ).not.toBeNull();
  expect(probe.flow.nodes!.find((n) => n.id === "moving")!.position).toEqual({
    x: 123,
    y: 87,
  });
});

it("locks one card without blocking its neighbor or copying and selection", async () => {
  await open();
  await act(async () =>
    project.emit({
      id: 10,
      type: "agent.work",
      data: {
        locks: [
          {
            target: { kind: "board-node", boardId: board.id, id: "moving" },
            turnId: "turn",
            chatId: "chat",
            startedAt: "now",
          },
        ],
      },
    }),
  );
  const locked = host.querySelector('article[aria-label="moving"]')!;
  expect(locked.classList.contains("agent-work-active")).toBe(true);
  expect(locked.querySelector("textarea")!.readOnly).toBe(true);
  expect(
    host.querySelector<HTMLTextAreaElement>(
      'article[aria-label="stationary"] textarea',
    )!.readOnly,
  ).toBe(false);
  expect(
    probe.flow.nodes!.find((node) => node.id === "moving")!.draggable,
  ).toBe(false);
  await move(99);
  expect(
    probe.flow.nodes!.find((node) => node.id === "moving")!.position.x,
  ).toBe(0);
  await act(async () =>
    probe.flow.onNodesChange!([
      {
        type: "position",
        id: "stationary",
        position: { x: 700, y: 50 },
        dragging: false,
      },
      { type: "remove", id: "moving" },
    ]),
  );
  expect(host.querySelector('article[aria-label="moving"]')).not.toBeNull();
  expect(
    probe.flow.nodes!.find((node) => node.id === "stationary")!.position,
  ).toEqual({ x: 700, y: 50 });
  expect(probe.flow.elementsSelectable).toBe(true);
  await act(async () =>
    project.emit({ id: 11, type: "agent.work", data: { locks: [] } }),
  );
  expect(
    host.querySelector<HTMLTextAreaElement>(
      'article[aria-label="moving"] textarea',
    )!.readOnly,
  ).toBe(false);
});
