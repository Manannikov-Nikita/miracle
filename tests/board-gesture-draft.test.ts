// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import { draftKey, useBoard } from "../src/client/board/useBoard";
import type { Board, BoardDocument } from "../src/shared/types";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const initialDocument = (): BoardDocument => ({
  schemaVersion: 1,
  nodes: [
    {
      id: "note",
      type: "artifact",
      position: { x: 0, y: 0 },
      data: { kind: "note", title: "Note", text: "Keep me" },
    },
  ],
  edges: [],
});
describe("gesture draft persistence", () => {
  let host: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof useBoard>;
  let project: ProjectSync;
  let boards: Board[];
  let storage: Map<string, string>;
  let writes: string[];
  let finishSave: (() => void) | undefined;
  let finishSelect: (() => void) | undefined;
  let holdSave: boolean;
  let holdSelect: boolean;
  let rejectSave: boolean;
  let unmounted: boolean;
  const notify = vi.fn();
  let currentNotify: typeof notify;
  const key = draftKey("workspace", "first");
  function Workspace() {
    store = useBoard("workspace", currentNotify);
    return createElement(
      "div",
      null,
      `${store.board?.id}:${store.board?.document.nodes[0]?.position.x}`,
    );
  }
  const draft = (id = "first") => {
    const raw = storage.get(draftKey("workspace", id));
    return raw ? JSON.parse(raw) : null;
  };
  const moved = (x: number) => {
    const current = store.current.current!.document;
    return {
      ...current,
      nodes: current.nodes.map((node) => ({ ...node, position: { x, y: 0 } })),
    };
  };
  async function move(x: number) {
    await act(async () => store.change(moved(x), false, { deferDraft: true }));
  }
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    storage = new Map();
    writes = [];
    finishSave = undefined;
    finishSelect = undefined;
    holdSave = false;
    holdSelect = false;
    rejectSave = false;
    unmounted = false;
    notify.mockClear();
    currentNotify = notify;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
        if (key.includes("board-draft")) writes.push(value);
      },
      removeItem: (key: string) => storage.delete(key),
    });
    boards = ["first", "second"].map((id) => ({
      id,
      name: id,
      revision: 1,
      updatedAt: "2026-11-06T00:00:00Z",
      document: initialDocument(),
    }));
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards") return response(boards);
      const current = boards.find(
        (board) => path === `/api/boards/${board.id}`,
      );
      if (!current) throw new Error(`Unexpected request: ${path}`);
      if (options.method === "DELETE") {
        boards = boards.filter((b) => b !== current);
        return response({ ok: true });
      }
      if (options.method === "PATCH") {
        const input = JSON.parse(options.body as string);
        if (holdSave)
          await new Promise<void>((resolve) => {
            finishSave = resolve;
          });
        if (rejectSave)
          return response(
            { error: "Revision conflict", code: "REVISION_CONFLICT" },
            409,
          );
        current.document = input.document;
        current.revision++;
      }
      if (!options.method && holdSelect)
        await new Promise<void>((resolve) => {
          finishSelect = resolve;
        });
      return response(current);
    });
    project = new ProjectSync();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(Workspace),
        ),
      ),
    );
  });
  afterEach(async () => {
    if (!unmounted) await act(async () => root.unmount());
    host.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("keeps a burst in memory, then backs up only its newest position", async () => {
    await move(10);
    await move(20);
    await move(30);
    expect(host.textContent).toBe("first:30");
    expect(writes).toHaveLength(0);
    expect(draft()).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(writes).toHaveLength(1);
    expect(draft()).toMatchObject({
      baseRevision: 1,
      document: { nodes: [{ position: { x: 30, y: 0 } }] },
    });
  });
  it("flushes the final gesture immediately even when its last coordinates are unchanged", async () => {
    await move(25);
    await act(async () => {
      store.change(moved(25), false, { deferDraft: true });
      store.flushDraft();
    });
    expect(draft().document.nodes[0].position.x).toBe(25);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(writes).toHaveLength(1);
  });
  it("keeps the flush callback and pending gesture stable across notification callback changes", async () => {
    await move(35);
    const flush = store.flushDraft;
    currentNotify = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(Workspace),
        ),
      ),
    );
    expect(store.flushDraft).toBe(flush);
    expect(writes).toHaveLength(0);
    await act(async () => store.flushDraft());
    expect(draft().document.nodes[0].position.x).toBe(35);
  });
  it.each(["pagehide", "beforeunload"])(
    "flushes the newest position on %s",
    async (event) => {
      await move(40);
      await act(async () =>
        window.dispatchEvent(new Event(event, { cancelable: true })),
      );
      expect(draft().document.nodes[0].position.x).toBe(40);
    },
  );
  it("flushes a pending board before switching and restores it when returning", async () => {
    await move(50);
    await act(async () => store.select("second"));
    expect(draft().document.nodes[0].position.x).toBe(50);
    expect(draft("second")).toBeNull();
    await act(async () => store.select("first"));
    expect(host.textContent).toBe("first:50");
  });
  it("backs up the latest position on unmount", async () => {
    await move(60);
    await act(async () => root.unmount());
    unmounted = true;
    expect(draft().document.nodes[0].position.x).toBe(60);
  });
  it("preserves a newer movement made while the next board is loading", async () => {
    await move(55);
    holdSelect = true;
    let selecting!: Promise<void>;
    await act(async () => {
      selecting = store.select("second");
    });
    await move(56);
    await act(async () => {
      finishSelect!();
      await selecting;
    });
    expect(host.textContent).toBe("second:0");
    expect(draft().document.nodes[0].position.x).toBe(56);
  });
  it("backs up the latest position when the page becomes hidden", async () => {
    await move(65);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(draft().document.nodes[0].position.x).toBe(65);
    visibility.mockRestore();
  });
  it.each(["save", "reload", "remove"] as const)(
    "does not resurrect an outdated queued draft after %s",
    async (operation) => {
      await move(70);
      await act(async () => store[operation]());
      expect(draft()).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(draft()).toBeNull();
      if (operation === "save")
        expect(boards[0].document.nodes[0].position.x).toBe(70);
      if (operation === "reload") expect(host.textContent).toBe("first:0");
      if (operation === "remove") expect(host.textContent).toBe("second:0");
    },
  );
  it("rebases a newer drag made during an in-flight save instead of restoring its old revision", async () => {
    await move(80);
    holdSave = true;
    let saving!: Promise<void>;
    await act(async () => {
      saving = store.save();
    });
    await move(90);
    await act(async () => {
      finishSave!();
      await saving;
    });
    expect(draft()).toMatchObject({
      baseRevision: 2,
      document: { nodes: [{ position: { x: 90, y: 0 } }] },
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(draft().baseRevision).toBe(2);
    expect(draft().document.nodes[0].position.x).toBe(90);
  });
  it("retains the last gesture when a remote update conflicts before its timer fires", async () => {
    await move(100);
    const remote = structuredClone(boards[0]);
    remote.revision = 2;
    remote.document.nodes[0].data.text = "Remote";
    await act(async () =>
      project.emit({ id: 2, type: "board.updated", data: remote }),
    );
    expect(store.conflict).toBe(true);
    expect(draft().document.nodes[0].position.x).toBe(100);
    expect(draft().baseRevision).toBe(1);
  });
  it("backs up a newer gesture immediately when its in-flight save conflicts", async () => {
    await move(102);
    holdSave = true;
    rejectSave = true;
    let saving!: Promise<void>;
    await act(async () => {
      saving = store.save();
    });
    await move(103);
    await act(async () => {
      finishSave!();
      await saving;
    });
    expect(store.conflict).toBe(true);
    expect(draft().document.nodes[0].position.x).toBe(103);
    expect(draft().baseRevision).toBe(1);
  });
  it("keeps a newer queued drag rebased when its save echo precedes the HTTP response", async () => {
    await move(105);
    holdSave = true;
    const submitted = structuredClone(store.current.current!);
    let saving!: Promise<void>;
    await act(async () => {
      saving = store.save();
    });
    await move(106);
    await act(async () =>
      project.emit({
        id: 2,
        type: "board.updated",
        data: { ...submitted, revision: 2 },
      }),
    );
    expect(draft()).toMatchObject({
      baseRevision: 2,
      document: { nodes: [{ position: { x: 106, y: 0 } }] },
    });
    await act(async () => {
      finishSave!();
      await saving;
    });
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(draft().baseRevision).toBe(2);
    expect(draft().document.nodes[0].position.x).toBe(106);
  });
  it("undoes a completed gesture in one step and persists the undo instead of its queued movement", async () => {
    const start = store.current.current!.document;
    await move(110);
    await move(120);
    await act(async () => {
      store.recordHistory(start);
      store.undo();
    });
    expect(host.textContent).toBe("first:0");
    expect(store.canUndo).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(draft().document.nodes[0].position.x).toBe(0);
    await act(async () => store.redo());
    expect(draft().document.nodes[0].position.x).toBe(120);
  });
});
