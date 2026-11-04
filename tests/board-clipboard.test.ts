// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createElement,
  useContext,
  type ContextType,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactFlowProps } from "@xyflow/react";
import type { Board } from "../src/shared/types";
import BoardWorkspace from "../src/client/board/BoardWorkspace";
import { BoardActions } from "../src/client/board/ArtifactNode";

const flow = vi.hoisted(() => ({
  props: {} as ReactFlowProps,
  actions: undefined as ContextType<typeof BoardActions> | undefined,
}));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  const controller = {
    getZoom: () => 1,
    setViewport: async () => true,
    fitView: async () => true,
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
      x: x / 2,
      y: y / 2,
    }),
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
    useViewport: () => ({ x: 0, y: 0, zoom: 2 }),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
const mime = "application/x-miracle-board+json";

describe("board clipboard", () => {
  let host: HTMLDivElement;
  let root: Root;
  let boards: Board[];
  let writes: number;
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
    notify.mockClear();
    flow.props = {};
    flow.actions = undefined;
    writes = 0;
    boards = ["first", "second"].map((id) => ({
      id,
      name: id,
      revision: 1,
      updatedAt: "2026-11-04T00:00:00.000Z",
      document: {
        schemaVersion: 1,
        nodes:
          id === "first"
            ? [
                {
                  id: "a",
                  type: "artifact",
                  position: { x: 0, y: 0 },
                  width: 400,
                  height: 200,
                  data: {
                    kind: "result",
                    title: "Result",
                    resultSetId: "00000000-0000-4000-8000-000000000001",
                    source: {
                      connectionId: "00000000-0000-4000-8000-000000000002",
                      sql: "select 1",
                    },
                    sourceRevision: 4,
                    view: "table",
                    visibleColumns: ["value"],
                  },
                },
                {
                  id: "b",
                  type: "artifact",
                  position: { x: 600, y: 0 },
                  width: 400,
                  height: 200,
                  data: {
                    kind: "markdown",
                    title: "Markdown",
                    text: "**Context**",
                  },
                },
                {
                  id: "c",
                  type: "artifact",
                  position: { x: 1200, y: 0 },
                  width: 400,
                  height: 200,
                  data: { kind: "note", title: "Note", text: "External" },
                },
              ]
            : [],
        edges:
          id === "first"
            ? [
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
              ]
            : [],
        viewport: { x: 0, y: 0, zoom: 2 },
      },
    }));
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards")
        return response(boards.map(({ document: _, ...summary }) => summary));
      const board = boards.find((board) => path === `/api/boards/${board.id}`);
      if (!board) throw new Error(`Unexpected request: ${path}`);
      if (options.method === "PATCH") {
        board.document = JSON.parse(options.body as string).document;
        board.revision++;
        writes++;
      }
      return response(board);
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    window.getSelection()?.removeAllRanges();
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function open(board = "first", workspaceId = "project") {
    localStorage.setItem(`miracle:selected-board:${workspaceId}`, board);
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        createElement(BoardWorkspace, {
          workspaceId,
          onIncomingConsumed() {},
          onOpenSource() {},
          onNotify: notify,
        }),
      ),
    );
    const canvas = host.querySelector(".board-canvas")!;
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 200,
      width: 1000,
      height: 600,
      right: 1100,
      bottom: 800,
      x: 100,
      y: 200,
      toJSON() {},
    });
  }
  const nodes = () =>
    flow.props.nodes!.filter((node) => node.type === "artifact");
  async function select(ids: string[]) {
    await act(async () =>
      flow.props.onNodesChange!(
        nodes().map((node) => ({
          type: "select",
          id: node.id,
          selected: ids.includes(node.id),
        })),
      ),
    );
  }
  function clipboard(values: Record<string, string> = {}) {
    const data = new Map(Object.entries(values));
    return {
      getData: (key: string) => data.get(key) ?? "",
      setData: (key: string, value: string) => {
        data.set(key, value);
      },
      get types() {
        return [...data.keys()];
      },
    };
  }
  async function event(
    kind: "copy" | "paste",
    data: ReturnType<typeof clipboard>,
    target = host.querySelector(".board-workspace")!,
    prevented = false,
  ) {
    const event = new Event(kind, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: data });
    if (prevented) event.preventDefault();
    await act(async () => target.dispatchEvent(event));
    return event;
  }
  async function copied(ids = ["a", "b"]) {
    await select(ids);
    const data = clipboard();
    expect((await event("copy", data)).defaultPrevented).toBe(true);
    return data;
  }
  async function history(label: string) {
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click(),
    );
  }

  it("pastes an immutable selected snapshot with new identities/internal links, selects it and creates one undo step", async () => {
    await open();
    const data = await copied();
    const before = structuredClone(
      nodes()
        .slice(0, 2)
        .map((node) => node.data),
    );
    await act(async () =>
      flow.actions!.update("a", { title: "Edited after copy" }),
    );
    expect((await event("paste", data)).defaultPrevented).toBe(true);
    const pasted = nodes().filter((node) => node.selected);
    expect(pasted).toHaveLength(2);
    expect(pasted.map((node) => node.position)).toEqual([
      { x: 32, y: 32 },
      { x: 632, y: 32 },
    ]);
    expect(pasted.map((node) => node.data)).toEqual(before);
    expect(pasted.every((node) => !["a", "b", "c"].includes(node.id))).toBe(
      true,
    );
    expect(nodes()[0].data.title).toBe("Edited after copy");
    expect(flow.props.edges).toHaveLength(3);
    expect(flow.props.edges![2]).toMatchObject({
      source: pasted[0].id,
      target: pasted[1].id,
      label: "Related",
      bend: { x: 10, y: 20 },
    });
    expect(flow.props.edges![2].id).not.toBe("internal");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(writes).toBe(1);
    expect(boards[0].document.nodes).toHaveLength(5);
    await history("Отменить изменение");
    expect(nodes()).toHaveLength(3);
    expect(nodes()[0].data.title).toBe("Edited after copy");
    await history("Повторить изменение");
    expect(nodes()).toHaveLength(5);
  });

  it("survives a board switch/remount via plain-text clipboard fallback and centers the whole group in the visible viewport", async () => {
    await open();
    const data = await copied();
    const fallback = clipboard({ "text/plain": data.getData("text/plain") });
    await open("second");
    await event("paste", fallback);
    expect(nodes()).toHaveLength(2);
    // Canvas center (600,500) maps to board (300,250); copied bounds are 1000x200.
    expect(nodes().map((node) => node.position)).toEqual([
      { x: -200, y: 150 },
      { x: 400, y: 150 },
    ]);
    expect(nodes().every((node) => node.selected)).toBe(true);
    expect(flow.props.edges).toHaveLength(1);
    expect(nodes()[0].data).toMatchObject({
      resultSetId: "00000000-0000-4000-8000-000000000001",
      source: { sql: "select 1" },
      sourceRevision: 4,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(boards[0].document.nodes).toHaveLength(3);
    expect(boards[1].document.nodes).toHaveLength(2);
  });

  it("staggers repeated pastes with fresh identities and does not overlap after a reload", async () => {
    await open();
    const data = await copied(["a"]);
    await event("paste", data);
    const first = nodes().find((node) => node.selected)!;
    await event("paste", data);
    const second = nodes().find((node) => node.selected)!;
    expect(second.id).not.toBe(first.id);
    expect(second.position).toEqual({ x: 64, y: 64 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    await open();
    await event("paste", data);
    expect(nodes().find((node) => node.selected)?.position).toEqual({
      x: 96,
      y: 96,
    });
  });

  it("leaves native text editing and selected table text alone", async () => {
    await open();
    const data = await copied();
    const section = host.querySelector(".board-workspace")!;
    for (const markup of [
      '<input value="native">',
      "<textarea>native</textarea>",
      '<div contenteditable="">native</div>',
      '<div class="cm-editor"><span>native</span></div>',
      '<div class="monaco-editor"><span>native</span></div>',
    ]) {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = markup;
      section.append(wrapper);
      const target =
        wrapper.querySelector("span") ?? wrapper.firstElementChild!;
      expect((await event("copy", clipboard(), target)).defaultPrevented).toBe(
        false,
      );
      expect((await event("paste", data, target)).defaultPrevented).toBe(false);
      wrapper.remove();
    }
    const text = document.createElement("span");
    text.textContent = "Selected table value";
    section.append(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.addRange(range);
    expect((await event("copy", clipboard())).defaultPrevented).toBe(false);
    expect((await event("paste", data)).defaultPrevented).toBe(false);
    expect(nodes()).toHaveLength(3);
  });

  it("ignores unrelated, malformed and future clipboard data without swallowing paste", async () => {
    await open();
    const valid = await copied();
    const envelope = JSON.parse(valid.getData(mime));
    const invalid = [
      clipboard({ "text/plain": "select * from table" }),
      clipboard({ [mime]: "not-json" }),
      clipboard({ [mime]: JSON.stringify({ ...envelope, version: 999 }) }),
      clipboard({
        [mime]: JSON.stringify({
          ...envelope,
          document: {
            schemaVersion: 1,
            nodes: [
              { ...envelope.document.nodes[0], position: { x: "bad", y: 0 } },
            ],
            edges: [],
          },
        }),
      }),
      clipboard({
        [mime]: JSON.stringify({
          ...envelope,
          document: {
            schemaVersion: 1,
            nodes: envelope.document.nodes,
            edges: [{ id: "dangling", source: "a", target: "missing" }],
          },
        }),
      }),
    ];
    for (const data of invalid)
      expect((await event("paste", data)).defaultPrevented).toBe(false);
    expect(nodes()).toHaveLength(3);
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects fragments from another project without creating broken snapshot references", async () => {
    await open();
    const data = await copied();
    await open("second", "other-project");
    await event("paste", data);
    expect(nodes()).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("другого проекта"),
      "error",
    );
  });

  it("enforces the destination board limit atomically", async () => {
    await open();
    const data = await copied();
    boards[1].document.nodes = Array.from({ length: 199 }, (_, i) => ({
      id: `existing-${i}`,
      type: "artifact",
      position: { x: i * 2, y: 0 },
      data: { kind: "note", title: `Existing ${i}` },
    }));
    await open("second");
    await event("paste", data);
    expect(nodes()).toHaveLength(199);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("200"),
      "error",
    );
  });

  it("preserves an existing clipboard without a selection and respects a handled event", async () => {
    await open();
    const original = clipboard({ "text/plain": "keep me" });
    expect((await event("copy", original)).defaultPrevented).toBe(false);
    expect(original.getData("text/plain")).toBe("keep me");
    const data = await copied();
    await event("paste", data, undefined, true);
    expect(nodes()).toHaveLength(3);
  });
});
