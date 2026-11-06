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

const response = (value: unknown) => new Response(JSON.stringify(value));
const deck = (id: string): Board => ({
  id,
  name: id,
  revision: 1,
  updatedAt: "",
  document: {
    schemaVersion: 1,
    kind: "presentation",
    slides: [{ id: "slide", title: "Slide", background: "#ffffff" }],
    nodes: [],
    edges: [],
  },
});
const insertNote = (target: Board): BoardDocument => ({
  ...target.document,
  nodes: [
    ...target.document.nodes,
    {
      id: crypto.randomUUID(),
      type: "artifact",
      position: { x: 80, y: 80 },
      slideId: target.document.slides![0].id,
      data: { kind: "note", title: "Copied note" },
    },
  ],
});

describe("addressed presentation writes", () => {
  let root: Root;
  let store: ReturnType<typeof useBoard>;
  let project: ProjectSync;
  let boards: Map<string, Board>;
  let writes: { path: string; body: string }[];
  let loseFirstAck: boolean;
  let delayRead: { id: string; until: Promise<void> } | undefined;
  const notify = () => {};
  function Host() {
    store = useBoard("project", notify, "presentation");
    return null;
  }
  beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    boards = new Map([
      ["first", deck("first")],
      ["second", deck("second")],
    ]);
    writes = [];
    loseFirstAck = true;
    delayRead = undefined;
    const receipts = new Map<string, Board>();
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards?kind=presentation")
        return response(
          [...boards.values()].map(({ document: _, ...value }) => ({
            ...value,
            kind: "presentation",
          })),
        );
      const id = path.split("/").at(-1)!;
      if (options.method === "PATCH" || options.method === "POST") {
        const raw = options.body as string;
        writes.push({ path, body: raw });
        const { document, mutationId } = JSON.parse(raw);
        const receipt = receipts.get(mutationId);
        if (receipt) return response(receipt);
        const current =
          options.method === "POST"
            ? deck(crypto.randomUUID())
            : boards.get(id)!;
        const next = { ...current, revision: current.revision + 1, document };
        boards.set(next.id, next);
        if (mutationId) receipts.set(mutationId, next);
        if (loseFirstAck && writes.length === 1)
          throw new TypeError("Lost acknowledgment");
        return response(next);
      }
      if (delayRead?.id === id) await delayRead.until;
      return response(boards.get(id));
    });
    project = new ProjectSync();
    root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(Host),
        ),
      ),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });

  it("replays an ambiguous write to the same inactive deck without adding a second block", async () => {
    const id = crypto.randomUUID();
    await act(async () => {
      await expect(store.applyTo("second", insertNote, id)).rejects.toThrow(
        "Lost acknowledgment",
      );
      await store.applyTo("second", insertNote, id);
    });
    expect(writes[0]).toEqual(writes[1]);
    expect(store.board?.id).toBe("first");
    expect(boards.get("first")?.document.nodes).toHaveLength(0);
    expect(boards.get("second")?.document.nodes).toHaveLength(1);
  });

  it("replays a lost create acknowledgment with the same slide and block IDs", async () => {
    const id = crypto.randomUUID();
    await act(async () => {
      await expect(store.applyTo(null, insertNote, id)).rejects.toThrow(
        "Lost acknowledgment",
      );
      await store.applyTo(null, insertNote, id);
    });
    expect(writes[0]).toEqual(writes[1]);
    expect(boards.size).toBe(3);
    expect(store.board?.document.nodes).toHaveLength(1);
  });

  it("undoes an addressed insert after replay without removing a disjoint remote note", async () => {
    const id = crypto.randomUUID();
    await act(async () => {
      await expect(store.applyTo("first", insertNote, id)).rejects.toThrow(
        "Lost acknowledgment",
      );
      const remote = boards.get("first")!;
      const updated: Board = {
        ...remote,
        revision: remote.revision + 1,
        document: {
          ...remote.document,
          nodes: [
            ...remote.document.nodes,
            {
              id: "agent-note",
              slideId: "slide",
              type: "artifact",
              position: { x: 100, y: 200 },
              data: { kind: "note", title: "Agent note" },
            },
          ],
        },
      };
      boards.set(updated.id, updated);
      project.emit({
        id: updated.revision,
        type: "board.updated",
        data: updated,
      });
      await store.applyTo("first", insertNote, id);
    });
    expect(store.canUndo).toBe(true);
    await act(async () => store.undo());
    expect(store.board?.document.nodes.map((node) => node.id)).toEqual([
      "agent-note",
    ]);
  });

  it("keeps the captured document when its response arrives after selecting another deck", async () => {
    loseFirstAck = false;
    let finishRead!: () => void;
    delayRead = {
      id: "first",
      until: new Promise<void>((resolve) => {
        finishRead = resolve;
      }),
    };
    let inserting!: ReturnType<typeof store.applyTo>;
    await act(async () => {
      inserting = store.applyTo("first", insertNote, crypto.randomUUID());
    });
    await act(async () => store.select("second"));
    await act(async () => {
      finishRead();
      await expect(inserting).resolves.toMatchObject({ boardId: "first" });
    });
    expect(store.board?.id).toBe("second");
    expect(boards.get("first")?.document.nodes).toHaveLength(1);
    expect(boards.get("second")?.document.nodes).toHaveLength(0);
  });
});
