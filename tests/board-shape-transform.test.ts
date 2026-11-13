// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createElement,
  useContext,
  type ChangeEvent,
  type ComponentProps,
  type ContextType,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactFlowProps, Viewport } from "@xyflow/react";
import type { Board, BoardNode } from "../src/shared/types";
import BoardWorkspace from "../src/client/board/BoardWorkspace";
import {
  BoardActions,
  type ArtifactFlowNode,
} from "../src/client/board/ArtifactNode";
import { lineEndpointPatch } from "../src/client/board/LineTransformControls";
import { getLineGeometry } from "../src/client/board/shape-geometry";
import { rotatePoint } from "../src/client/board/shape-rotation";
import type { Select } from "../src/client/components/Select";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";

// Keep the real workspace, history, drafts and synchronization. Only replace
// canvas measurement and the portal selector, which jsdom cannot lay out.
const flow = vi.hoisted(() => ({
  props: {} as ReactFlowProps,
  viewport: { x: 0, y: 0, zoom: 1 } as Viewport,
  actions: undefined as ContextType<typeof BoardActions> | undefined,
}));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  const controller = {
    setViewport: async (viewport: Viewport) => {
      flow.viewport = viewport;
      flow.props.onMoveEnd?.(null, viewport);
      return true;
    },
    fitView: async () => true,
    getZoom: () => flow.viewport.zoom,
  };
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
    ReactFlow: (props: ReactFlowProps) => {
      flow.props = props;
      flow.actions = useContext(BoardActions);
      return props.children;
    },
    useReactFlow: () => controller,
    useViewport: () => flow.viewport,
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});
vi.mock("../src/client/components/Select", () => ({
  Select: (props: ComponentProps<typeof Select>) =>
    createElement(
      "select",
      {
        "aria-label": props["aria-label"],
        value: props.value,
        disabled: props.disabled,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          props.onValueChange?.(event.currentTarget.value),
      },
      props.options.map((option) =>
        createElement(
          "option",
          { key: option.value, value: option.value, disabled: option.disabled },
          option.label,
        ),
      ),
    ),
}));

const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

describe("shape transform gestures in the board workspace", () => {
  let host: HTMLDivElement;
  let root: Root;
  let project: ProjectSync;
  let boards: Board[];
  const notify = vi.fn();

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
    flow.actions = undefined;
    flow.viewport = { x: 0, y: 0, zoom: 1 };
    notify.mockClear();
    boards = ["first", "second"].map((id, index) => ({
      id,
      name: id,
      revision: 3,
      updatedAt: "2026-11-01T00:00:00.000Z",
      document: {
        schemaVersion: 1,
        nodes: [
          {
            id: "shape",
            type: "artifact",
            position: { x: 10, y: 20 },
            width: 200,
            height: 100,
            data: {
              kind: "shape",
              title: "Shape",
              shape: { type: "rectangle", rotation: index ? 90 : 30 },
            },
          },
          {
            id: "note",
            type: "artifact",
            position: { x: 400, y: 20 },
            data: { kind: "note", title: "Note", text: "Original" },
          },
          {
            id: "chart",
            type: "artifact",
            position: { x: 400, y: 200 },
            data: { kind: "result", title: "Chart", view: "chart" },
          },
        ],
        edges: [],
        viewport: { x: 10, y: 20, zoom: 1 },
      },
    }));
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards")
        return response(boards.map(({ document, ...summary }) => summary));
      const board = boards.find((item) => path === `/api/boards/${item.id}`);
      if (!board) throw new Error(`Unexpected request: ${path}`);
      if (options.method === "PATCH") {
        board.document = JSON.parse(options.body as string).document;
        board.revision++;
      }
      return response(board);
    });
    project = new ProjectSync();
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
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(BoardWorkspace, {
            workspaceId: "workspace",
            onOpenSource() {},
            onNotify: notify,
          }),
        ),
      ),
    );
  }
  const node = (id = "shape") =>
    flow.props.nodes!.find((item) => item.id === id)! as BoardNode;
  const undo = () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Отменить изменение"]')!;
  const redo = () =>
    host.querySelector<HTMLButtonElement>(
      '[aria-label="Повторить изменение"]',
    )!;
  async function start(id = "shape") {
    let accepted = false;
    await act(async () => {
      accepted = flow.actions!.shapeTransformStart!(id);
    });
    return accepted;
  }
  async function end(cancelled = false) {
    await act(async () => flow.actions!.shapeTransformEnd!("shape", cancelled));
  }
  async function selectBoard(id: string) {
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(
        '[aria-label="Выбрать доску"]',
      )!;
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  async function lock(id: string, eventId = 10) {
    await act(async () =>
      project.emit({
        id: eventId,
        type: "agent.work",
        data: {
          locks: [
            {
              target: { kind: "board-node", boardId: "first", id },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        },
      }),
    );
  }

  it.each(["rectangle", "line"] as const)(
    "batches several %s rotation previews into one saved undo and redo step",
    async (type) => {
      boards[0].document.nodes[0].data.shape!.type = type;
      await open();
      expect(await start()).toBe(true);
      for (const rotation of [45, 75, 105]) {
        await act(async () =>
          flow.actions!.shapeTransform!("shape", { rotation }),
        );
        expect(node().data.shape!.rotation).toBe(rotation);
        expect(undo().disabled).toBe(true);
      }
      await end();
      await act(async () => project.prepare());
      expect(boards[0].document.nodes[0].data.shape!.rotation).toBe(105);
      expect(undo().disabled).toBe(false);
      await act(async () => undo().click());
      expect(node().data.shape!.rotation).toBe(30);
      expect(undo().disabled).toBe(true);
      await act(async () => redo().click());
      expect(node().data.shape!.rotation).toBe(105);
      expect(redo().disabled).toBe(true);
    },
  );

  it("cancels only rotation and geometry, retaining unrelated edits", async () => {
    await open();
    const original = structuredClone(node());
    expect(await start()).toBe(true);
    await act(async () =>
      flow.actions!.shapeTransform!("shape", {
        rotation: 75,
        rectangle: { x: -20, y: 30, width: 300, height: 150 },
      }),
    );
    await act(async () => {
      flow.actions!.update("note", { text: "Changed independently" });
      flow.actions!.update("shape", {
        shape: { ...node().data.shape!, fill: "#123456" },
      });
    });
    await end(true);
    expect(node().position).toEqual(original.position);
    expect(node().width).toBe(original.width);
    expect(node().height).toBe(original.height);
    expect(node().data.shape!.rotation).toBe(30);
    expect(node().data.shape!.fill).toBe("#123456");
    expect(node("note").data.text).toBe("Changed independently");
    await act(async () => {
      flow.actions!.shapeTransform!("shape", { rotation: 180 });
      flow.actions!.shapeTransformEnd!("shape", false);
    });
    expect(node().data.shape!.rotation).toBe(30);
    await act(async () => project.prepare());
    expect(boards[0].document.nodes[0].data.shape!.rotation).toBe(30);
    expect(boards[0].document.nodes[1].data.text).toBe("Changed independently");
  });

  it("does not create an undo step when a gesture is cancelled", async () => {
    await open();
    expect(await start()).toBe(true);
    await act(async () =>
      flow.actions!.shapeTransform!("shape", { rotation: 180 }),
    );
    await end(true);
    expect(node().data.shape!.rotation).toBe(30);
    expect(undo().disabled).toBe(true);
    expect(redo().disabled).toBe(true);
  });

  it("keeps line endpoint direction changes in the same cancellable undo step", async () => {
    boards[0].document.nodes[0].data.shape = {
      type: "line",
      lineDirection: "vertical",
      rotation: 30,
    };
    await open();
    expect(await start()).toBe(true);
    await act(async () =>
      flow.actions!.shapeTransform!("shape", {
        lineDirection: "horizontal",
        rotation: 120,
        rectangle: { x: 15, y: 25, width: 220, height: 100 },
      }),
    );
    expect(node().data.shape!.lineDirection).toBe("horizontal");
    await end(true);
    expect(node().data.shape!.lineDirection).toBe("vertical");
    expect(node().data.shape!.rotation).toBe(30);
    expect(undo().disabled).toBe(true);
    expect(await start()).toBe(true);
    await act(async () =>
      flow.actions!.shapeTransform!("shape", {
        lineDirection: "horizontal",
        rotation: 120,
        rectangle: { x: 15, y: 25, width: 220, height: 100 },
      }),
    );
    await end();
    await act(async () => undo().click());
    expect(node().data.shape!.lineDirection).toBe("vertical");
    await act(async () => redo().click());
    expect(node().data.shape!.lineDirection).toBe("horizontal");
    await act(async () => project.prepare());
    expect(boards[0].document.nodes[0].data.shape!.lineDirection).toBe(
      "horizontal",
    );
  });

  it.each(["vertical", "diagonal-up", "diagonal-down"] as const)(
    "restores a %s line when its endpoint is dragged away and back",
    async (lineDirection) => {
      boards[0].document.nodes[0].data.shape = {
        type: "line",
        lineDirection,
        rotation: 30,
      };
      const original = structuredClone(boards[0].document.nodes[0]);
      const shape = original.data.shape!;
      const rectangle = {
        ...original.position,
        width: original.width!,
        height: original.height!,
      };
      const localEnd = getLineGeometry(
        shape,
        rectangle.width,
        rectangle.height,
      ).end;
      const rotatedEnd = rotatePoint(
        localEnd,
        { x: rectangle.width / 2, y: rectangle.height / 2 },
        shape.rotation!,
      );
      const originalEnd = {
        x: rectangle.x + rotatedEnd.x,
        y: rectangle.y + rotatedEnd.y,
      };
      await open();
      expect(await start()).toBe(true);
      for (const requested of [
        { x: originalEnd.x + 30, y: originalEnd.y + 20 },
        originalEnd,
      ]) {
        await act(async () =>
          flow.actions!.shapeTransform!(
            "shape",
            lineEndpointPatch(shape, rectangle, "end", requested),
          ),
        );
      }
      await end();
      await act(async () => project.prepare());
      expect(boards[0].document.nodes[0]).toEqual(original);
      expect(undo().disabled).toBe(true);
    },
  );

  it("undoes the transform without reverting edits made during its preview", async () => {
    await open();
    expect(await start()).toBe(true);
    await act(async () =>
      flow.actions!.shapeTransform!("shape", { rotation: 75 }),
    );
    await act(async () => {
      flow.actions!.update("note", { text: "Changed independently" });
      flow.actions!.update("shape", {
        shape: { ...node().data.shape!, fill: "#123456" },
      });
    });
    await end();
    await act(async () => undo().click());
    expect(node().data.shape!.rotation).toBe(30);
    expect(node().data.shape!.fill).toBe("#123456");
    expect(node("note").data.text).toBe("Changed independently");
    await act(async () => redo().click());
    expect(node().data.shape!.rotation).toBe(75);
    expect(node().data.shape!.fill).toBe("#123456");
    expect(node("note").data.text).toBe("Changed independently");
  });

  it("saves a resize of a rotated shape as one undoable change", async () => {
    await open();
    const original = structuredClone(node());
    expect(await start()).toBe(true);
    for (const width of [240, 280, 320])
      await act(async () =>
        flow.actions!.shapeTransform!("shape", {
          rectangle: { x: -15, y: 45, width, height: 160 },
        }),
      );
    await end();
    await act(async () => project.prepare());
    expect(boards[0].document.nodes[0]).toMatchObject({
      position: { x: -15, y: 45 },
      width: 320,
      height: 160,
      data: { shape: { rotation: 30 } },
    });
    await act(async () => undo().click());
    expect(node().position).toEqual(original.position);
    expect(node().width).toBe(original.width);
    expect(node().height).toBe(original.height);
    expect(undo().disabled).toBe(true);
    await act(async () => redo().click());
    const rendered = node() as ArtifactFlowNode;
    const frame = rendered.data.shapeFrame!;
    expect(rendered.position.x + frame.x).toBeCloseTo(-15);
    expect(rendered.position.y + frame.y).toBeCloseTo(45);
    expect(frame.width).toBe(320);
    expect(frame.height).toBe(160);
    expect(node().data.shape!.rotation).toBe(30);
  });

  it("leaves a conflicted draft unchanged", async () => {
    const draft = structuredClone(boards[0].document);
    draft.nodes[0].data.shape!.rotation = 60;
    localStorage.setItem(
      "miracle:board-draft:workspace:first",
      JSON.stringify({ baseRevision: 2, document: draft }),
    );
    await open();
    expect(await start()).toBe(false);
    await act(async () => {
      flow.actions!.shapeTransform!("shape", { rotation: 180 });
      flow.actions!.shapeTransformEnd!("shape", false);
    });
    expect(node().data.shape!.rotation).toBe(60);
    expect(undo().disabled).toBe(true);
  });

  it("rejects charts, notes, missing nodes and agent-locked shapes", async () => {
    await open();
    for (const id of ["chart", "note", "missing"])
      expect(await start(id)).toBe(false);
    await lock("shape");
    expect(await start()).toBe(false);
    await act(async () => {
      flow.actions!.shapeTransform!("shape", { rotation: 180 });
      flow.actions!.shapeTransformEnd!("shape", false);
    });
    expect(node().data.shape!.rotation).toBe(30);
    expect(undo().disabled).toBe(true);
  });

  it("ignores stale gesture events when an agent takes ownership", async () => {
    await open();
    expect(await start()).toBe(true);
    await act(async () =>
      flow.actions!.shapeTransform!("shape", { rotation: 120 }),
    );
    await lock("shape");
    expect(node().data.shape!.rotation).toBe(30);
    await act(async () => {
      flow.actions!.shapeTransform!("shape", { rotation: 180 });
      flow.actions!.shapeTransformEnd!("shape", false);
    });
    expect(node().data.shape!.rotation).toBe(30);
    expect(undo().disabled).toBe(true);
    await act(async () =>
      project.emit({ id: 11, type: "agent.work", data: { locks: [] } }),
    );
    expect(await start()).toBe(true);
    await end(true);
  });

  it("does not apply events from the previous board to an identical node id", async () => {
    await open();
    expect(await start()).toBe(true);
    const previousActions = flow.actions!;
    await act(async () =>
      previousActions.shapeTransform!("shape", { rotation: 120 }),
    );
    await selectBoard("second");
    expect(flow.actions!.boardId).toBe("second");
    expect(node().data.shape!.rotation).toBe(90);
    await act(async () => {
      previousActions.shapeTransform!("shape", { rotation: 180 });
      previousActions.shapeTransformEnd!("shape", false);
    });
    expect(node().data.shape!.rotation).toBe(90);
    expect(undo().disabled).toBe(true);
    expect(await start()).toBe(true);
    await end(true);
  });
});
