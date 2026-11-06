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
import type { ReactFlowProps, ResizeParams, Viewport } from "@xyflow/react";
import type { Board } from "../src/shared/types";
import BoardWorkspace from "../src/client/board/BoardWorkspace";
import { BoardActions } from "../src/client/board/ArtifactNode";
import type { BoardEdgeViewData } from "../src/client/board/BoardEdgeView";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";

// XYFlow owns gestures and layout measurement; exercise our actual callbacks,
// persistence and synchronization without asking jsdom to implement a canvas.
const flow = vi.hoisted(() => ({
  props: {} as ReactFlowProps,
  viewport: { x: 0, y: 0, zoom: 1 } as Viewport,
  restored: [] as Viewport[],
  actions: undefined as ContextType<typeof BoardActions> | undefined,
}));
vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  const controller = {
    setViewport: async (viewport: Viewport) => {
      flow.viewport = viewport;
      flow.restored.push(viewport);
      flow.props.onMoveEnd?.(null, viewport);
      return true;
    },
    fitView: async () => {
      flow.viewport = { x: 15, y: 30, zoom: 0.8 };
      flow.props.onMoveEnd?.(null, flow.viewport);
      return true;
    },
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

const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

describe("board navigation is local view state", () => {
  let host: HTMLDivElement;
  let root: Root;
  let project: ProjectSync;
  let boards: Board[];
  let patches: unknown[];
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
    flow.restored = [];
    flow.props = {};
    flow.actions = undefined;
    flow.viewport = { x: 0, y: 0, zoom: 1 };
    boards = ["first", "second"].map((id) => ({
      id,
      name: id,
      revision: 3,
      updatedAt: "2026-11-01T00:00:00.000Z",
      document: {
        schemaVersion: 1,
        nodes: [
          {
            id: "note",
            type: "artifact",
            position: { x: 0, y: 0 },
            data: { kind: "note", title: "Note", text: id },
          },
        ],
        edges: [],
        viewport: { x: 10, y: 20, zoom: 1 },
      },
    }));
    patches = [];
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards")
        return response(boards.map(({ document, ...summary }) => summary));
      const board = boards.find((item) => path === `/api/boards/${item.id}`);
      if (!board) throw new Error(`Unexpected request: ${path}`);
      if (options.method === "PATCH") {
        const patch = JSON.parse(options.body as string);
        patches.push(patch);
        board.document = patch.document;
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

  async function open(workspace = "workspace-a", board = "first") {
    localStorage.setItem(`miracle:selected-board:${workspace}`, board);
    await act(async () => root.render(null));
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(BoardWorkspace, {
            workspaceId: workspace,
            onIncomingConsumed() {},
            onOpenSource() {},
            onNotify: notify,
          }),
        ),
      ),
    );
  }
  async function move(viewport: Viewport) {
    await act(async () => {
      flow.viewport = viewport;
      flow.props.onMoveEnd?.(null, viewport);
    });
  }
  const status = () => host.querySelector('[role="status"]')?.textContent;
  const arrowData = () => flow.props.edges![0].data as BoardEdgeViewData;

  const resizeStart = { x: 100, y: 200, width: 400, height: 300 };
  function resizeFixture(
    view: "chart" | "custom" | "table" | "note" = "chart",
  ) {
    const node = boards[0].document.nodes[0];
    node.position = { x: resizeStart.x, y: resizeStart.y };
    node.width = resizeStart.width;
    node.height = resizeStart.height;
    node.data =
      view === "note"
        ? { kind: "note", title: "Note" }
        : {
            kind: "result",
            title: "Chart",
            view,
            resultSetId: "result",
            source: { connectionId: "connection", sql: "select 1" },
          };
    return node;
  }
  async function resizeMove(
    raw: ResizeParams,
    shiftKey: boolean,
    altKey = false,
  ) {
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { shiftKey, altKey }));
      // XYFlow adds this non-geometric array to onResize, but not onResizeEnd.
      const movingRaw: ResizeParams & { direction: [number, number] } = {
        ...raw,
        direction: [1, 1],
      };
      flow.actions!.resize("note", movingRaw, true);
      flow.props.onNodesChange?.([
        { type: "position", id: "note", position: { x: raw.x, y: raw.y } },
        {
          type: "dimensions",
          id: "note",
          dimensions: { width: raw.width, height: raw.height },
          resizing: true,
          setAttributes: true,
        },
      ]);
    });
  }
  async function resizeEnd(raw: ResizeParams) {
    await act(async () => {
      // Mouseup may arrive after Shift was released. Keep the last displayed
      // rectangle instead of applying the now-unconstrained raw dimensions.
      window.dispatchEvent(new MouseEvent("mouseup"));
      flow.actions!.resize("note", raw, false);
      flow.props.onNodesChange?.([
        {
          type: "dimensions",
          id: "note",
          dimensions: { width: raw.width, height: raw.height },
          resizing: false,
        },
      ]);
    });
  }

  it.each(["chart", "custom"] as const)(
    "preserves %s corner ratio through release, save and one undo step",
    async (view) => {
      const original = structuredClone(resizeFixture(view));
      // This nearby target would otherwise independently snap the width to600.
      boards[0].document.nodes.push({
        id: "target",
        type: "artifact",
        position: { x: 700, y: 900 },
        width: 400,
        height: 300,
        data: { kind: "note", title: "Target" },
      });
      await open();
      await act(async () =>
        flow.actions!.resizeStart(
          "note",
          { right: true, bottom: true },
          resizeStart,
        ),
      );
      await resizeMove({ ...resizeStart, width: 500, height: 330 }, true);
      expect(flow.props.nodes![0]).toMatchObject({ width: 500, height: 375 });
      const end = { ...resizeStart, width: 596, height: 330 };
      await resizeMove(end, true);
      expect(flow.props.nodes![0]).toMatchObject({
        width: 596,
        height: 447,
        position: original.position,
      });
      expect(host.querySelector(".board-alignment-guides")).toBeNull();
      await resizeEnd(end);
      await act(async () => project.prepare());
      expect(boards[0].document.nodes[0]).toMatchObject({
        width: 596,
        height: 447,
      });
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '[aria-label="Отменить изменение"]',
          )!
          .click(),
      );
      expect(flow.props.nodes![0]).toMatchObject(original);
      expect(
        host.querySelector<HTMLButtonElement>(
          '[aria-label="Отменить изменение"]',
        )!.disabled,
      ).toBe(true);
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '[aria-label="Повторить изменение"]',
          )!
          .click(),
      );
      expect(flow.props.nodes![0]).toMatchObject({ width: 596, height: 447 });
      await act(async () => project.prepare());
      expect(boards[0].document.nodes[0]).toMatchObject({
        width: 596,
        height: 447,
      });
    },
  );

  it("tracks Shift during corner movement and combines it with Alt without creating a copy", async () => {
    resizeFixture();
    await open();
    await act(async () =>
      flow.actions!.resizeStart("note", { left: true, top: true }, resizeStart),
    );
    await resizeMove({ x: 0, y: 170, width: 500, height: 330 }, false);
    expect(flow.props.nodes![0]).toMatchObject({
      position: { x: 0, y: 170 },
      width: 500,
      height: 330,
    });
    await resizeMove({ x: 0, y: 170, width: 500, height: 330 }, true, true);
    expect(flow.props.nodes![0]).toMatchObject({
      position: { x: 0, y: 125 },
      width: 500,
      height: 375,
    });
    await resizeMove({ x: -20, y: 150, width: 520, height: 350 }, false);
    expect(flow.props.nodes![0]).toMatchObject({
      position: { x: -20, y: 150 },
      width: 520,
      height: 350,
    });
    expect(flow.props.nodes).toHaveLength(1);
    await resizeEnd({ x: -20, y: 150, width: 520, height: 350 });
    expect(flow.props.nodes![0]).toMatchObject({ width: 520, height: 350 });
  });

  it.each(["table", "note"] as const)(
    "keeps Shift corner resizing of %s free",
    async (view) => {
      resizeFixture(view);
      await open();
      await act(async () =>
        flow.actions!.resizeStart(
          "note",
          { right: true, bottom: true },
          resizeStart,
        ),
      );
      const raw = { ...resizeStart, width: 500, height: 330 };
      await resizeMove(raw, true);
      await resizeEnd(raw);
      expect(flow.props.nodes![0]).toMatchObject({ width: 500, height: 330 });
    },
  );

  it("keeps chart edge resizing free while Shift is held", async () => {
    resizeFixture();
    await open();
    await act(async () =>
      flow.actions!.resizeStart("note", { right: true }, resizeStart),
    );
    const raw = { ...resizeStart, width: 500 };
    await resizeMove(raw, true);
    await resizeEnd(raw);
    expect(flow.props.nodes![0]).toMatchObject({ width: 500, height: 300 });
  });

  function customResultWithoutRevision() {
    const spec = {
      version: 1 as const,
      description: "Custom refresh",
      html: "<svg></svg>",
      css: "",
      javascript: "api.root.title = 'chart'",
    };
    boards[0].document.nodes[0].data = {
      title: "Custom",
      kind: "result",
      view: "custom",
      resultSetId: "old-result",
      source: { connectionId: "connection", sql: "select 1" },
      customChart: spec,
    };
    return spec;
  }

  it("refreshes an omitted-revision custom node using the server's zero baseline and preserves its code", async () => {
    const spec = customResultWithoutRevision();
    let refreshPayload: unknown;
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards/first/nodes/note/refresh") {
        refreshPayload = JSON.parse(options.body as string);
        return Promise.resolve(
          response({ id: "refresh-run", status: "running" }),
        );
      }
      if (path === "/api/query-runs/refresh-run")
        return Promise.resolve(
          response({
            id: "refresh-run",
            status: "completed",
            resultSetId: "fresh-result",
          }),
        );
      return originalFetch(path, options);
    });
    await open();
    await act(async () => flow.actions!.refresh("note"));
    expect(refreshPayload).toEqual({ sourceRevision: 0 });
    expect(flow.props.nodes![0].data).toMatchObject({
      resultSetId: "fresh-result",
      view: "custom",
      customChart: spec,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
      await project.prepare();
    });
    expect(boards[0].document.nodes[0].data).toMatchObject({
      resultSetId: "fresh-result",
      customChart: spec,
    });
  });

  it("waits for unlock before retrying a completed block refresh", async () => {
    customResultWithoutRevision();
    const originalFetch = globalThis.fetch;
    let finish!: (value: Response) => void;
    let polls = 0;
    let locked = false;
    const completed = () =>
      response({
        id: "refresh-run",
        status: "completed",
        resultSetId: "fresh-result",
      });
    vi.stubGlobal("fetch", (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards/first/nodes/note/refresh")
        return Promise.resolve(
          response({ id: "refresh-run", status: "running" }),
        );
      if (path === "/api/query-runs/refresh-run") {
        polls++;
        if (polls === 1)
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        if (locked) return new Promise<Response>(() => {});
        return Promise.resolve(completed());
      }
      return originalFetch(path, options);
    });
    await open();
    await act(async () => flow.actions!.refresh("note"));
    locked = true;
    await act(async () =>
      project.emit({
        id: 10,
        type: "agent.work",
        data: {
          locks: [
            {
              target: { kind: "board-node", boardId: "first", id: "note" },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        },
      }),
    );
    await act(async () => finish(completed()));
    expect(polls).toBe(1);
    expect(flow.props.nodes![0].data.resultSetId).toBe("old-result");
    locked = false;
    await act(async () =>
      project.emit({ id: 11, type: "agent.work", data: { locks: [] } }),
    );
    expect(polls).toBe(2);
    expect(flow.props.nodes![0].data.resultSetId).toBe("fresh-result");
  });

  it.each(["source change", "node removal"])(
    "rejects a late omitted-revision refresh after %s",
    async (change) => {
      notify.mockClear();
      const spec = customResultWithoutRevision();
      let finish!: (value: Response) => void;
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (path: string, options: RequestInit = {}) => {
        if (path === "/api/boards/first/nodes/note/refresh")
          return Promise.resolve(
            response({ id: "refresh-run", status: "running" }),
          );
        if (path === "/api/query-runs/refresh-run")
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        return originalFetch(path, options);
      });
      await open();
      await act(async () => flow.actions!.refresh("note"));
      await act(async () => {
        if (change === "source change")
          flow.actions!.update("note", {
            source: { connectionId: "connection", sql: "select 2" },
          });
        else flow.actions!.remove("note");
      });
      await act(async () =>
        finish(
          response({
            id: "refresh-run",
            status: "completed",
            resultSetId: "obsolete-result",
          }),
        ),
      );
      if (change === "source change")
        expect(flow.props.nodes![0].data).toMatchObject({
          resultSetId: "old-result",
          sourceRevision: 1,
          source: { sql: "select 2" },
          customChart: spec,
        });
      else expect(flow.props.nodes).toEqual([]);
      expect(notify).toHaveBeenCalledWith(
        "Источник изменился; поздний результат не применён.",
        "info",
      );
    },
  );

  function pausedRefreshFixture() {
    const spec = customResultWithoutRevision();
    const source = {
      connectionId: "connection",
      sql: "select {{date}}",
      dateRange: {
        startDate: "2026-01-01",
        endDate: "2026-01-03",
        granularity: "day",
        retries: 2,
      },
    };
    boards[0].document.nodes[0].data.source = source as any;
    let status = "paused";
    const calls = { starts: 0, resumes: 0, cancels: 0 };
    const run = () => ({
      id: "paused-run",
      status,
      source,
      resultSetId: status === "completed" ? "fresh-result" : "partial-result",
      batch: {
        total: 3,
        completed: 1,
        succeeded: 1,
        failed: 1,
        attempt: 3,
        currentDate: "2026-01-02",
        items: [
          { date: "2026-01-01", status: "completed", attempts: 1 },
          {
            date: "2026-01-02",
            status: "failed",
            attempts: 3,
            error: "Temporary failure",
          },
          { date: "2026-01-03", status: "pending", attempts: 0 },
        ],
      },
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards/first/nodes/note/refresh") {
        calls.starts++;
        return Promise.resolve(response({ ...run(), status: "running" }));
      }
      if (path === "/api/query-runs/paused-run")
        return Promise.resolve(response(run()));
      if (path === "/api/query-runs/paused-run/resume") {
        calls.resumes++;
        status = "completed";
        return Promise.resolve(response({ ...run(), status: "running" }));
      }
      if (path === "/api/query-runs/paused-run/cancel") {
        calls.cancels++;
        status = "cancelled";
        return Promise.resolve(response(run()));
      }
      return originalFetch(path, options);
    });
    return { calls, spec };
  }
  const pauseAction = (name: string) =>
    [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === name,
    )!;

  it("restores a paused board refresh after remount and resumes the same run once without replacing its previous snapshot early", async () => {
    const fixture = pausedRefreshFixture();
    await open();
    await act(async () => flow.actions!.refresh("note"));
    expect(host.textContent).toContain("Серия приостановлена");
    expect(flow.props.nodes![0].data.resultSetId).toBe("old-result");
    expect(flow.actions!.busy.note).toBe(true);
    await open();
    expect(host.textContent).toContain("Temporary failure");
    expect(fixture.calls.starts).toBe(1);
    await act(async () => {
      const button = pauseAction("Продолжить");
      button.click();
      button.click();
    });
    expect(fixture.calls.resumes).toBe(1);
    expect(fixture.calls.starts).toBe(1);
    expect(flow.props.nodes![0].data).toMatchObject({
      resultSetId: "fresh-result",
      customChart: fixture.spec,
    });
    expect(host.textContent).not.toContain("Серия приостановлена");
    expect(
      JSON.parse(localStorage.getItem("miracle:board-refreshes:workspace-a")!),
    ).toEqual([]);
  });

  it("keeps a newer node source when a paused refresh is resumed", async () => {
    notify.mockClear();
    pausedRefreshFixture();
    await open();
    await act(async () => flow.actions!.refresh("note"));
    await act(async () =>
      flow.actions!.update("note", {
        source: { connectionId: "connection", sql: "select 42" },
      }),
    );
    await act(async () => pauseAction("Продолжить").click());
    expect(flow.props.nodes![0].data).toMatchObject({
      resultSetId: "old-result",
      sourceRevision: 1,
      source: { sql: "select 42" },
    });
    expect(notify).toHaveBeenCalledWith(
      "Источник изменился; поздний результат не применён.",
      "info",
    );
  });

  it("stops a paused board refresh without resuming it or changing the previous snapshot", async () => {
    const fixture = pausedRefreshFixture();
    await open();
    await act(async () => flow.actions!.refresh("note"));
    await act(async () => pauseAction("Остановить").click());
    expect(fixture.calls).toEqual({ starts: 1, resumes: 0, cancels: 1 });
    expect(flow.props.nodes![0].data.resultSetId).toBe("old-result");
    expect(host.textContent).not.toContain("Серия приостановлена");
    expect(
      JSON.parse(localStorage.getItem("miracle:board-refreshes:workspace-a")!),
    ).toEqual([]);
  });

  it("keeps a board creation error in its dialog with collapsed details and a retry", async () => {
    await open();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (path: string, options: RequestInit = {}) =>
      options.method === "POST"
        ? Promise.resolve(
            new Response(
              JSON.stringify({
                error: "Не удалось сохранить доску",
                details: "SQLITE_BUSY: board write locked",
              }),
              {
                status: 503,
                headers: { "Content-Type": "application/json" },
              },
            ),
          )
        : originalFetch(path, options),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Создать доску"]')!
        .click(),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    await act(async () =>
      dialog
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    const alert = dialog.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Не удалось создать доску");
    const details = alert?.querySelector<HTMLDetailsElement>("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelector("pre")?.textContent).toContain(
      "SQLITE_BUSY: board write locked",
    );
    expect(dialog.querySelector<HTMLInputElement>("input")?.value).toBe(
      "Новая доска",
    );
    expect(
      dialog.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.disabled,
    ).toBe(false);
    expect(boards).toHaveLength(2);
  });

  it("does not dirty, save or add undo history for navigation or initial measurements", async () => {
    await open();
    expect(status()).toBe("Сохранено");
    await act(async () =>
      flow.props.onNodesChange?.([
        { type: "select", id: "note", selected: true },
        {
          type: "dimensions",
          id: "note",
          dimensions: { width: 360, height: 260 },
        },
      ]),
    );
    // Pan, zoom and minimap/fit all finish through this callback.
    for (const viewport of [
      { x: 140, y: 80, zoom: 1 },
      { x: 140, y: 80, zoom: 0.6 },
      { x: -80, y: -45, zoom: 0.8 },
    ]) {
      await move(viewport);
      expect(status()).toBe("Сохранено");
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
      await project.prepare();
    });
    expect(patches).toEqual([]);
    expect(boards[0].revision).toBe(3);
    expect(boards[0].document.viewport).toEqual({ x: 10, y: 20, zoom: 1 });
    expect(
      localStorage.getItem("miracle:board-draft:workspace-a:first"),
    ).toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Отменить изменение"]')
        ?.disabled,
    ).toBe(true);
  });

  it("restores the local camera independently for each board and workspace", async () => {
    await open();
    await move({ x: 140, y: 80, zoom: 0.6 });
    await open("workspace-a", "second");
    expect(flow.viewport).toEqual({ x: 10, y: 20, zoom: 1 });
    await move({ x: -50, y: -20, zoom: 0.8 });
    await open();
    expect(flow.viewport).toEqual({ x: 140, y: 80, zoom: 0.6 });
    await open("workspace-b");
    expect(flow.viewport).toEqual({ x: 10, y: 20, zoom: 1 });
    await open("workspace-a", "second");
    expect(flow.viewport).toEqual({ x: -50, y: -20, zoom: 0.8 });
    expect(patches).toEqual([]);
  });

  it("accepts a remote edit during viewing without a conflict, write-back or camera reset", async () => {
    await open();
    await move({ x: 140, y: 80, zoom: 0.6 });
    const restoresBefore = flow.restored.length;
    boards[0] = {
      ...boards[0],
      revision: 4,
      document: {
        ...boards[0].document,
        nodes: boards[0].document.nodes.map((node) => ({
          ...node,
          data: { ...node.data, text: "agent edit" },
        })),
        viewport: { x: 500, y: 500, zoom: 2 },
      },
    };
    await act(async () =>
      project.emit({
        id: 4,
        type: "board.updated",
        data: structuredClone(boards[0]),
      }),
    );
    expect(flow.props.nodes?.[0].data.text).toBe("agent edit");
    expect(host.querySelector(".board-conflict")).toBeNull();
    expect(status()).toBe("Сохранено");
    expect(flow.restored).toHaveLength(restoresBefore);
    expect(flow.viewport).toEqual({ x: 140, y: 80, zoom: 0.6 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
      await project.prepare();
    });
    expect(patches).toEqual([]);
    expect(boards[0].revision).toBe(4);
    expect(
      localStorage.getItem("miracle:board-draft:workspace-a:first"),
    ).toBeNull();
  });

  it("keeps selection and opening Markdown or edge properties outside document edits", async () => {
    boards[0].document.nodes[0].data = {
      kind: "markdown",
      title: "Markdown",
      text: "First block",
    };
    boards[0].document.nodes.push({
      id: "other-note",
      type: "artifact",
      position: { x: 400, y: 0 },
      data: { kind: "note", title: "Other note", text: "second block" },
    });
    boards[0].document.edges.push({
      id: "edge",
      source: "note",
      target: "other-note",
      label: "Related",
    });
    const originalDocument = structuredClone(boards[0].document);
    await open();
    await act(async () =>
      flow.props.onNodesChange?.([
        { type: "select", id: "note", selected: true },
      ]),
    );
    expect(
      flow.props.nodes?.filter((node) => node.selected).map((node) => node.id),
    ).toEqual(["note"]);
    await act(async () =>
      flow.props.onNodesChange?.([
        { type: "select", id: "other-note", selected: true },
        {
          type: "dimensions",
          id: "note",
          dimensions: { width: 360, height: 260 },
        },
      ]),
    );
    expect(
      flow.props.nodes?.filter((node) => node.selected).map((node) => node.id),
    ).toEqual(["note", "other-note"]);

    await act(async () => flow.actions!.inspect("note"));
    expect(
      host.querySelector<HTMLInputElement>(".board-inspector input")?.value,
    ).toBe("Markdown");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Закрыть свойства"]')!
        .click(),
    );
    expect(host.querySelector(".board-inspector")).toBeNull();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Свойства"]')!.click(),
    );
    expect(host.querySelector(".board-inspector")).not.toBeNull();
    await act(async () =>
      flow.props.onPaneClick?.(new MouseEvent("click") as never),
    );
    expect(host.querySelector(".board-inspector")).toBeNull();
    expect(flow.props.nodes?.some((node) => node.selected)).toBe(false);

    await act(async () => {
      flow.props.onEdgesChange?.([
        { type: "select", id: "edge", selected: true },
      ]);
    });
    expect(flow.props.edges![0].selected).toBe(true);
    await act(async () => {
      flow.props.onEdgeClick?.(
        new MouseEvent("click") as never,
        flow.props.edges![0],
      );
    });
    await act(async () => arrowData().onEdit());
    expect(arrowData().editing).toBe(true);
    await act(async () => arrowData().onFinishEdit());
    await act(async () => arrowData().onClose());
    expect(flow.props.edges![0].selected).toBe(false);
    expect(status()).toBe("Сохранено");
    expect(
      localStorage.getItem("miracle:board-draft:workspace-a:first"),
    ).toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Отменить изменение"]')
        ?.disabled,
    ).toBe(true);
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(false);

    boards[0] = {
      ...boards[0],
      revision: 4,
      document: {
        ...originalDocument,
        nodes: originalDocument.nodes.map((node) => ({
          ...node,
          data: { ...node.data, title: "Updated by agent" },
        })),
      },
    };
    await act(async () =>
      project.emit({
        id: 4,
        type: "board.updated",
        data: structuredClone(boards[0]),
      }),
    );
    expect(flow.props.nodes?.[0].data.title).toBe("Updated by agent");
    expect(host.querySelector(".board-conflict")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
      await project.prepare();
    });
    expect(patches).toEqual([]);
    expect(boards[0].revision).toBe(4);
    expect(
      localStorage.getItem("miracle:board-draft:workspace-a:first"),
    ).toBeNull();
  });

  it("saves inline edge edits while preserving unrelated appearance fields", async () => {
    boards[0].document.nodes.push({
      id: "other-note",
      type: "artifact",
      position: { x: 400, y: 0 },
      data: { kind: "note", title: "Other note", text: "second block" },
    });
    boards[0].document.edges.push({
      id: "edge",
      source: "note",
      target: "other-note",
      label: "Related",
      appearance: { color: "#91cbb3", width: 2 },
    });
    await open();
    await act(async () => {
      arrowData().onChange({ label: "Related" });
      await project.prepare();
    });
    expect(patches).toEqual([]);
    await act(async () => {
      arrowData().onChange({ label: "Next step" });
      arrowData().onChange({ appearance: { line: "dashed" } });
      await project.prepare();
    });
    expect(patches).toHaveLength(1);
    expect(boards[0].document.edges).toEqual([
      {
        id: "edge",
        source: "note",
        target: "other-note",
        label: "Next step",
        appearance: { color: "#91cbb3", width: 2, line: "dashed" },
      },
    ]);
    const remove = flow.props.onEdgesChange!;
    await act(async () => {
      flow.actions!.update("note", { title: "Latest title" });
      remove([{ type: "remove", id: "edge" }]);
      await project.prepare();
    });
    expect(boards[0].document.nodes[0].data.title).toBe("Latest title");
    expect(boards[0].document.edges).toEqual([]);
  });

  it("keeps sticky notes out of the inspector through actions, toolbar and selection", async () => {
    boards[0].document.nodes.push({
      id: "markdown",
      type: "artifact",
      position: { x: 400, y: 0 },
      data: { kind: "markdown", title: "Markdown", text: "Second block" },
    });
    await open();
    await act(async () =>
      flow.props.onNodesChange?.([
        { type: "select", id: "note", selected: true },
      ]),
    );
    await act(async () => flow.actions!.inspect("note"));
    expect(host.querySelector(".board-inspector")).toBeNull();

    const properties = host.querySelector<HTMLButtonElement>(
      '[aria-label="Свойства"]',
    )!;
    expect(properties.disabled).toBe(true);
    expect(properties.getAttribute("aria-pressed")).toBe("false");
    await act(async () => properties.click());
    expect(host.querySelector(".board-inspector")).toBeNull();

    await act(async () => flow.actions!.inspect("markdown"));
    expect(
      host.querySelector<HTMLInputElement>(".board-inspector input")?.value,
    ).toBe("Markdown");
    expect(properties.disabled).toBe(false);

    await act(async () =>
      flow.props.onNodesChange?.([
        { type: "select", id: "markdown", selected: false },
        { type: "select", id: "note", selected: true },
      ]),
    );
    expect(host.querySelector(".board-inspector")).toBeNull();
    expect(properties.disabled).toBe(true);
    expect(properties.getAttribute("aria-pressed")).toBe("false");
  });

  it("still saves an actual edit made in Markdown properties", async () => {
    boards[0].document.nodes[0].data = {
      kind: "markdown",
      title: "Markdown",
      text: "First block",
    };
    await open();
    await act(async () => flow.actions!.inspect("note"));
    const title = host.querySelector<HTMLInputElement>(
      ".board-inspector input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(title, "Renamed Markdown");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(status()).toBe("Изменения…");
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Отменить изменение"]')
        ?.disabled,
    ).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
      await project.prepare();
    });
    expect(patches).toHaveLength(1);
    expect(boards[0].document.nodes[0].data.title).toBe("Renamed Markdown");
    expect(boards[0].revision).toBe(4);
    expect(status()).toBe("Сохранено");
  });

  it("keeps free-arrow anchor nodes out of documents, selection and history", async () => {
    boards[0].document.edges = [
      {
        id: "free",
        sourcePoint: { x: 80, y: 100 },
        targetPoint: { x: 340, y: 240 },
      },
    ];
    await open();
    const edge = flow.props.edges![0];
    expect(typeof edge.source).toBe("string");
    expect(typeof edge.target).toBe("string");
    const anchors = flow.props.nodes!.filter(
      (node) => node.type === "edge-anchor",
    );
    expect(anchors).toHaveLength(2);
    expect(
      anchors.every(
        (node) => node.hidden && !node.selectable && !node.draggable,
      ),
    ).toBe(true);
    await act(async () => {
      flow.props.onNodesChange?.([
        { type: "select", id: anchors[0].id, selected: true },
        { type: "position", id: anchors[0].id, position: { x: 999, y: 999 } },
        { type: "remove", id: anchors[1].id },
        {
          type: "add",
          item: {
            id: "runtime-extra",
            type: "edge-anchor",
            position: { x: 0, y: 0 },
            data: {},
          },
        },
      ]);
      await project.prepare();
    });
    expect(status()).toBe("Сохранено");
    expect(patches).toEqual([]);
    expect(
      host.querySelector<HTMLButtonElement>('[aria-label="Отменить изменение"]')
        ?.disabled,
    ).toBe(true);
    await act(async () => {
      flow.actions!.update("note", { title: "Updated title" });
      await project.prepare();
    });
    expect(boards[0].document.nodes.map((node) => node.id)).toEqual(["note"]);
    expect(boards[0].document.edges).toEqual([
      {
        id: "free",
        sourcePoint: { x: 80, y: 100 },
        targetPoint: { x: 340, y: 240 },
      },
    ]);
  });

  it("commits an arrow drag as one undo step while preserving adjacent edits", async () => {
    boards[0].document.nodes.push({
      id: "other-note",
      type: "artifact",
      position: { x: 600, y: 0 },
      data: { kind: "note", title: "Other", text: "" },
    });
    boards[0].document.edges = [
      { id: "edge", source: "note", target: "other-note", label: "Related" },
    ];
    await open();
    const beforeDrag = arrowData().edge;
    await act(async () => {
      arrowData().onChange({ appearance: { color: "#91cbb3" } });
      flow.actions!.update("note", { title: "Latest title" });
      await project.prepare();
    });
    await act(async () => {
      arrowData().onGeometryChange(
        {
          source: undefined,
          target: undefined,
          sourcePoint: { x: 200, y: 150 },
          targetPoint: { x: 750, y: 150 },
        },
        beforeDrag,
      );
      await project.prepare();
    });
    expect(patches).toHaveLength(2);
    expect(boards[0].document.edges[0]).toEqual({
      id: "edge",
      label: "Related",
      appearance: { color: "#91cbb3" },
      sourcePoint: { x: 200, y: 150 },
      targetPoint: { x: 750, y: 150 },
    });
    expect(boards[0].document.nodes[0].data.title).toBe("Latest title");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Отменить изменение"]')!
        .click(),
    );
    await act(async () => project.prepare());
    expect(boards[0].document.edges[0]).toEqual({
      ...beforeDrag,
      appearance: { color: "#91cbb3" },
    });
    expect(boards[0].document.nodes[0].data.title).toBe("Latest title");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Повторить изменение"]')!
        .click(),
    );
    await act(async () => project.prepare());
    expect(boards[0].document.edges[0].sourcePoint).toEqual({ x: 200, y: 150 });
    expect(boards[0].document.edges[0].source).toBeUndefined();
  });

  it("discards stale arrow gestures and connections to removed nodes", async () => {
    boards[0].document.edges = [
      {
        id: "edge",
        sourcePoint: { x: 100, y: 100 },
        targetPoint: { x: 600, y: 100 },
      },
    ];
    await open();
    const beforeDrag = arrowData().edge;
    const finishDrag = arrowData().onGeometryChange;
    boards[0] = {
      ...boards[0],
      revision: 4,
      document: {
        ...boards[0].document,
        edges: [{ ...beforeDrag, sourcePoint: { x: 200, y: 300 } }],
      },
    };
    await act(async () =>
      project.emit({
        id: 4,
        type: "board.updated",
        data: structuredClone(boards[0]),
      }),
    );
    await act(async () => {
      finishDrag({ sourcePoint: { x: 999, y: 999 } }, beforeDrag);
      arrowData().onGeometryChange(
        { target: "removed-node", targetPoint: undefined },
        arrowData().edge,
      );
      await project.prepare();
    });
    expect(patches).toEqual([]);
    expect(status()).toBe("Сохранено");
    expect(arrowData().edge.sourcePoint).toEqual({ x: 200, y: 300 });
    expect(arrowData().edge.target).toBeUndefined();
  });

  it("does not show the empty-board prompt when only free arrows remain", async () => {
    boards[0].document.nodes = [];
    boards[0].document.edges = [
      {
        id: "edge",
        sourcePoint: { x: 100, y: 100 },
        targetPoint: { x: 600, y: 100 },
      },
    ];
    await open();
    expect(host.querySelector(".board-canvas-empty")).toBeNull();
  });

  it("saves a manual bend and path together without losing appearance or accepting stale bends", async () => {
    const original = {
      id: "edge",
      sourcePoint: { x: 100, y: 100 },
      targetPoint: { x: 600, y: 100 },
      label: "Related",
      appearance: {
        path: "straight" as const,
        color: "#91cbb3",
        line: "dashed" as const,
        width: 2 as const,
      },
    };
    boards[0].document.edges = [original];
    await open();
    await act(async () => {
      arrowData().onGeometryChange(
        { bend: { x: 40, y: 90 }, appearance: { path: "bezier" } },
        original,
      );
      await project.prepare();
    });
    expect(patches).toHaveLength(1);
    expect(boards[0].document.edges[0]).toEqual({
      ...original,
      bend: { x: 40, y: 90 },
      appearance: { ...original.appearance, path: "bezier" },
    });
    const stale = { ...arrowData().edge, bend: undefined };
    await act(async () => {
      arrowData().onGeometryChange({ labelPosition: 0.8 }, stale);
      await project.prepare();
    });
    expect(patches).toHaveLength(1);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Отменить изменение"]')!
        .click(),
    );
    await act(async () => project.prepare());
    expect(boards[0].document.edges[0]).toEqual(original);
  });
});
