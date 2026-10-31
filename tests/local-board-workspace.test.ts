// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import { useBoard } from "../src/client/board/useBoard";
import type { Board, BoardDocument } from "../src/shared/types";

const documentWith = (text: string): BoardDocument => ({
  schemaVersion: 1,
  nodes: [
    {
      id: "note",
      type: "artifact",
      position: { x: 0, y: 0 },
      data: { title: "Note", kind: "note", text },
    },
  ],
  edges: [],
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("personal board drafts and revisions", () => {
  let project: ProjectSync;
  let root: Root;
  let host: HTMLDivElement;
  let store: ReturnType<typeof useBoard>;
  let boards: Board[];
  let changes: unknown[];
  let rejectRevision: boolean;
  const notify = vi.fn();
  function Workspace({ id }: { id: string }) {
    store = useBoard(id, notify);
    return createElement(
      "div",
      null,
      `${store.board?.name ?? ""}: ${store.board?.document.nodes[0]?.data.text ?? ""} ${store.state}`,
    );
  }
  beforeEach(() => {
    project = new ProjectSync();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    boards = [
      {
        id: "first",
        name: "First",
        revision: 3,
        document: documentWith("server first"),
        updatedAt: "2026-10-30T00:00:00.000Z",
      },
      {
        id: "second",
        name: "Second",
        revision: 5,
        document: documentWith("server second"),
        updatedAt: "2026-10-30T00:00:00.000Z",
      },
    ];
    changes = [];
    rejectRevision = false;
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards")
        return response(boards.map(({ document, ...summary }) => summary));
      const board = boards.find((b) => path === `/api/boards/${b.id}`)!;
      if (!board) throw new Error(`Unexpected path ${path}`);
      if (options.method === "DELETE") {
        const deletion = JSON.parse(options.body as string);
        changes.push(deletion);
        if (rejectRevision || deletion.baseRevision !== board.revision)
          return response(
            { error: "Revision conflict", code: "REVISION_CONFLICT" },
            409,
          );
        boards = boards.filter((b) => b.id !== board.id);
        return new Response(null, { status: 204 });
      }
      if (options.method === "PATCH") {
        const patch = JSON.parse(options.body as string);
        changes.push(patch);
        if (rejectRevision || patch.baseRevision !== board.revision)
          return response(
            { error: "Revision conflict", code: "REVISION_CONFLICT" },
            409,
          );
        board.document = patch.document;
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
    vi.unstubAllGlobals();
  });
  async function open(id = "workspace-a") {
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(Workspace, { key: id, id }),
        ),
      ),
    );
  }

  it("restores the workspace's selected board and stale local draft without overwriting a newer revision", async () => {
    localStorage.setItem("miracle:selected-board:workspace-a", "second");
    localStorage.setItem(
      "miracle:board-draft:workspace-a:second",
      JSON.stringify({
        baseRevision: 4,
        document: documentWith("unsaved local note"),
      }),
    );
    await open();
    expect(host.textContent).toContain("Second: unsaved local note");
    expect(store.conflict).toBe(true);
    await act(async () => store.save());
    expect(changes).toEqual([]);
    expect(boards[1].document.nodes[0].data.text).toBe("server second");
    await act(async () => store.reload());
    expect(host.textContent).toContain("Second: server second");
    expect(store.conflict).toBe(false);
    expect(
      localStorage.getItem("miracle:board-draft:workspace-a:second"),
    ).toBeNull();
  });

  it("keeps drafts and selection separate between workspaces, and saves personal changes with revision protection", async () => {
    localStorage.setItem("miracle:selected-board:workspace-b", "second");
    localStorage.setItem(
      "miracle:board-draft:workspace-b:first",
      JSON.stringify({
        baseRevision: 3,
        document: documentWith("other workspace"),
      }),
    );
    await open();
    expect(host.textContent).toContain("First: server first");
    await act(async () => store.change(documentWith("my edited note")));
    expect(
      JSON.parse(
        localStorage.getItem("miracle:board-draft:workspace-a:first")!,
      ),
    ).toEqual({ baseRevision: 3, document: documentWith("my edited note") });
    await act(async () => store.save());
    expect(boards[0].document.nodes[0].data.text).toBe("my edited note");
    expect(changes).toEqual([
      {
        baseRevision: 3,
        document: documentWith("my edited note"),
        mutationId: expect.any(String),
      },
    ]);
    expect(
      localStorage.getItem("miracle:board-draft:workspace-a:first"),
    ).toBeNull();
    expect(
      localStorage.getItem("miracle:board-draft:workspace-b:first"),
    ).toContain("other workspace");
    await open("workspace-b");
    expect(host.textContent).toContain("Second: server second");
  });

  it("retains the local draft after another tab saves a conflicting version", async () => {
    await open();
    await act(async () => store.change(documentWith("recoverable edit")));
    rejectRevision = true;
    await act(async () => store.save());
    expect(store.conflict).toBe(true);
    expect(host.textContent).toContain("recoverable edit");
    expect(
      localStorage.getItem("miracle:board-draft:workspace-a:first"),
    ).toContain("recoverable edit");
    expect(boards[0].document.nodes[0].data.text).toBe("server first");
  });
  it("accepts a clean agent board update once and exposes it as one undo step", async () => {
    await open();
    const external = {
      ...boards[0],
      revision: 4,
      document: documentWith("agent note"),
    };
    await act(async () => {
      project.emit({ id: 1, type: "board.updated", data: external });
      project.emit({ id: 1, type: "board.updated", data: external });
    });
    expect(store.board?.document.nodes[0].data.text).toBe("agent note");
    expect(store.canUndo).toBe(true);
    await act(async () => store.undo());
    expect(store.board?.document.nodes[0].data.text).toBe("server first");
    expect(store.canUndo).toBe(false);
    expect(store.board?.revision).toBe(4);
  });
  it("retains a dirty local board on agent events and blocks sending until the conflict is resolved", async () => {
    await open();
    await act(async () => store.change(documentWith("my draft")));
    await act(async () =>
      project.emit({
        id: 1,
        type: "board.updated",
        data: {
          ...boards[0],
          revision: 4,
          document: documentWith("agent note"),
        },
      }),
    );
    expect(store.board?.document.nodes[0].data.text).toBe("my draft");
    expect(store.conflict).toBe(true);
    await expect(project.prepare()).rejects.toThrow("конфликт");
    expect(
      localStorage.getItem("miracle:board-draft:workspace-a:first"),
    ).toContain("my draft");
    expect(changes).toEqual([]);
  });
  it("rehydrates a changed board after reconnect without replacing a concurrent draft", async () => {
    await open();
    await act(async () => store.change(documentWith("offline draft")));
    boards[0] = {
      ...boards[0],
      revision: 4,
      document: documentWith("headless change"),
    };
    await act(async () => project.rehydrate());
    expect(store.conflict).toBe(true);
    expect(store.board?.document.nodes[0].data.text).toBe("offline draft");
  });
  it("flushes pending changes before capturing agent work and retains the original board target", async () => {
    await open();
    await act(async () => store.change(documentWith("flush me")));
    let context: unknown;
    await act(async () => {
      context = await project.prepare();
    });
    expect(context).toEqual({ boardId: "first" });
    expect(boards[0].document.nodes[0].data.text).toBe("flush me");
    expect(changes).toHaveLength(1);
  });
  it("sends the selected revision when deleting and retains a stale board on conflict", async () => {
    await open();
    rejectRevision = true;
    await act(async () => {
      await expect(store.remove()).rejects.toMatchObject({ status: 409 });
    });
    expect(changes).toEqual([
      { baseRevision: 3, mutationId: expect.any(String) },
    ]);
    expect(store.board?.id).toBe("first");
    expect(store.conflict).toBe(true);
    expect(boards).toHaveLength(2);
  });
});
