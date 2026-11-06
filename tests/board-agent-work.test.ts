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

const documentWith = (a = "A", b = "B"): BoardDocument => ({
  schemaVersion: 1,
  nodes: [
    ["a", a],
    ["b", b],
  ].map(([id, text]) => ({
    id,
    type: "artifact",
    position: { x: 0, y: 0 },
    data: { title: id, kind: "note", text },
  })),
  edges: [],
});
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

describe("independent edits during agent work", () => {
  let project: ProjectSync, root: Root, host: HTMLDivElement;
  let store: ReturnType<typeof useBoard>;
  let remote: Board;
  let completeSave: ((value: Board) => void) | undefined;
  let sent: BoardDocument[];
  function Workspace() {
    store = useBoard("workspace", () => {});
    return null;
  }
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    localStorage.clear();
    remote = {
      id: "board",
      name: "Board",
      revision: 1,
      updatedAt: "now",
      document: documentWith(),
    };
    sent = [];
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (options.method === "PATCH") {
        sent.push(JSON.parse(options.body as string).document);
        return new Promise<Response>((resolve) => {
          completeSave = (value) => resolve(response(value));
        });
      }
      return response(path === "/api/boards" ? [remote] : remote);
    });
    project = new ProjectSync();
    host = document.createElement("div");
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
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  async function emit(document: BoardDocument, revision: number) {
    remote = { ...remote, revision, document };
    await act(async () =>
      project.emit({ id: revision, type: "board.updated", data: remote }),
    );
  }
  it("merges a remote block and undoes only the user's block", async () => {
    await act(async () => store.change(documentWith("A", "mine")));
    await emit(documentWith("agent", "B"), 2);
    expect(store.conflict).toBe(false);
    expect(store.board?.document).toEqual(documentWith("agent", "mine"));
    await act(async () => store.undo());
    expect(store.board?.document).toEqual(documentWith("agent", "B"));
    await act(async () => store.redo());
    expect(store.board?.document).toEqual(documentWith("agent", "mine"));
  });
  it("merges a rebased acknowledgment and preserves newer local input", async () => {
    await act(async () => store.change(documentWith("A", "sent")));
    let saving!: Promise<void>;
    await act(async () => {
      saving = store.save();
    });
    await act(async () => store.change(documentWith("A", "latest")));
    await emit(documentWith("agent", "B"), 2);
    await emit(documentWith("agent", "sent"), 4);
    await act(async () => {
      completeSave!({ ...remote });
      await saving;
    });
    expect(store.conflict).toBe(false);
    expect(store.board?.revision).toBe(4);
    expect(store.board?.document).toEqual(documentWith("agent", "latest"));
  });
  it("does not make remote edits an undo entry", async () => {
    await emit(documentWith("agent", "B"), 2);
    expect(store.canUndo).toBe(false);
  });
  it("does not acknowledge a reorder merely because entity values match", async () => {
    const reordered = documentWith();
    reordered.nodes.reverse();
    await act(async () => store.change(reordered));
    let saving!: Promise<void>;
    await act(async () => {
      saving = store.save();
    });
    await emit(documentWith(), 2);
    expect(store.board?.document.nodes.map((node) => node.id)).toEqual([
      "b",
      "a",
    ]);
    await act(async () => {
      completeSave!({ ...remote, revision: 3, document: reordered });
      await saving;
    });
  });
  it("preserves protected draw order while accepting independent content edits", async () => {
    await act(async () =>
      project.emit({
        id: 10,
        type: "agent.work",
        data: {
          locks: [
            {
              target: { kind: "board-node", boardId: "board", id: "a" },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        },
      }),
    );
    const reordered = documentWith("A", "my B");
    reordered.nodes.reverse();
    await act(async () => store.change(reordered));
    expect(store.board?.document.nodes.map((node) => node.id)).toEqual([
      "a",
      "b",
    ]);
    expect(store.board?.document.nodes[1].data.text).toBe("my B");
  });
  it("keeps source undo and redo usable after sourceRevision advances", async () => {
    const sourceDocument = (sql: string): BoardDocument => {
      const value = documentWith();
      value.nodes[0].data.source = { connectionId: "connection", sql };
      return value;
    };
    await act(async () => store.change(sourceDocument("select 1")));
    await act(async () => store.change(sourceDocument("select 2")));
    await act(async () => store.undo());
    expect(store.board?.document.nodes[0].data.source?.sql).toBe("select 1");
    await act(async () => store.redo());
    expect(store.board?.document.nodes[0].data.source?.sql).toBe("select 2");
  });
  it("rebases adjacent source history after each own undo and redo", async () => {
    const sourceDocument = (sql: string): BoardDocument => {
      const value = documentWith();
      value.nodes[0].data.source = { connectionId: "connection", sql };
      value.nodes[0].data.sourceRevision = 0;
      return value;
    };
    await emit(sourceDocument("select 0"), 2);
    await act(async () => store.change(sourceDocument("select 1")));
    await act(async () => store.change(sourceDocument("select 2")));
    await act(async () => store.undo());
    await act(async () => store.undo());
    expect(store.board?.document.nodes[0].data.source?.sql).toBe("select 0");
    await act(async () => store.redo());
    await act(async () => store.redo());
    expect(store.board?.document.nodes[0].data.source?.sql).toBe("select 2");
  });
  it("parks a newly locked local block while another block remains savable", async () => {
    await act(async () => store.change(documentWith("my A", "my B")));
    await act(async () =>
      project.emit({
        id: 10,
        type: "agent.work",
        data: {
          locks: [
            {
              target: { kind: "board-node", boardId: "board", id: "a" },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        },
      }),
    );
    expect(store.board?.document).toEqual(documentWith("A", "my B"));
    expect(
      [...Object.values(localStorage)].some(
        (value) => typeof value === "string" && value.includes("my A"),
      ),
    ).toBe(true);
    await act(async () =>
      store.change(documentWith("forbidden", "still editable")),
    );
    expect(store.board?.document).toEqual(documentWith("A", "still editable"));
    let saving!: Promise<void>;
    await act(async () => {
      saving = store.save();
    });
    expect(sent).toEqual([documentWith("A", "still editable")]);
    await act(async () => {
      completeSave!({ ...remote, revision: 2, document: sent[0] });
      await saving;
    });
  });

  it("parks a locked conflict after reconnect and resumes independent editing", async () => {
    await act(async () => store.change(documentWith("my A", "my B")));
    await emit(documentWith("agent", "B"), 2);
    expect(store.conflict).toBe(true);
    await act(async () =>
      project.emit({
        id: 10,
        type: "agent.work",
        data: {
          locks: [
            {
              target: { kind: "board-node", boardId: "board", id: "a" },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        },
      }),
    );
    expect(store.conflict).toBe(false);
    expect(store.board?.document).toEqual(documentWith("agent", "my B"));
    await act(async () => store.undo());
    expect(store.board?.document).toEqual(documentWith("agent", "B"));
  });
  it("never rebases a stale restored draft against an unknown original base", async () => {
    await act(async () => root.unmount());
    remote = {
      ...remote,
      revision: 2,
      document: documentWith("A", "remote B"),
    };
    localStorage.setItem(
      "miracle:board-draft:workspace:board",
      JSON.stringify({ baseRevision: 1, document: documentWith("my A", "B") }),
    );
    project.emit({
      id: 10,
      type: "agent.work",
      data: {
        locks: [
          {
            target: { kind: "board-node", boardId: "board", id: "a" },
            turnId: "turn",
            chatId: "chat",
            startedAt: "now",
          },
        ],
      },
    });
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
    expect(store.conflict).toBe(true);
    await act(async () => store.save());
    expect(sent).toEqual([]);
    expect(remote.document.nodes[1].data.text).toBe("remote B");
    expect(
      localStorage.getItem("miracle:board-draft:workspace:board"),
    ).toContain("my A");
  });

  it("protects locked endpoints from neighbor deletion and locks metadata independently", async () => {
    await emit(
      { ...documentWith(), edges: [{ id: "edge", source: "a", target: "b" }] },
      2,
    );
    await act(async () =>
      project.emit({
        id: 10,
        type: "agent.work",
        data: {
          locks: [
            {
              target: { kind: "board-node", boardId: "board", id: "a" },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        },
      }),
    );
    await act(async () =>
      store.change({
        ...documentWith(),
        nodes: documentWith().nodes.slice(0, 1),
        edges: [],
      }),
    );
    expect(store.board?.document.nodes.map((node) => node.id)).toEqual([
      "a",
      "b",
    ]);
    expect(store.board?.document.edges).toHaveLength(1);
    expect(store.canRename()).toBe(true);
    expect(store.canDelete()).toBe(false);
    await expect(store.remove()).rejects.toThrow("агента");
    await act(async () =>
      project.emit({
        id: 11,
        type: "agent.work",
        data: {
          locks: [
            {
              target: { kind: "board", id: "board" },
              turnId: "turn",
              chatId: "chat",
              startedAt: "now",
            },
          ],
        },
      }),
    );
    expect(store.canRename()).toBe(false);
    expect(store.canEditNode("a")).toBe(true);
    await expect(store.rename("new name")).rejects.toThrow("Агент");
  });
});
