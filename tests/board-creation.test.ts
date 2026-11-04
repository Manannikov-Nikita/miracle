// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import { useBoard } from "../src/client/board/useBoard";
import { Select } from "../src/client/components/Select";
import type { Board } from "../src/shared/types";

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
const board = (id: string): Board => ({
  id,
  name: "Доска",
  revision: 1,
  document: { schemaVersion: 1, nodes: [], edges: [] },
  updatedAt: "2026-11-04T00:00:00.000Z",
});

describe("board creation echoes", () => {
  let project: ProjectSync;
  let root: Root;
  let host: HTMLDivElement;
  let store: ReturnType<typeof useBoard>;
  let finishCreate: (response: Response) => void;
  const notify = vi.fn();
  const existing = board("existing");
  const created = board("created");

  function Workspace() {
    store = useBoard("workspace", notify);
    return createElement(Select, {
      "aria-label": "Выбрать доску",
      value: store.board?.id ?? "",
      options: store.list.map(({ id, name }) => ({ value: id, label: name })),
    });
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("fetch", async (path: string, options: RequestInit = {}) => {
      if (path === "/api/boards" && options.method === "POST")
        return new Promise<Response>((resolve) => {
          finishCreate = resolve;
        });
      if (path === "/api/boards") return response([existing]);
      if (path === "/api/boards/existing") return response(existing);
      throw new Error(`Unexpected request: ${path}`);
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
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function emit(value = created) {
    await act(async () => {
      project.emit({
        id: value.revision,
        type: "board.updated",
        entityId: value.id,
        data: value,
      });
    });
  }

  it.each(["before", "after"])(
    "shows one title when the creation event arrives %s the HTTP response",
    async (ordering) => {
      let creating!: Promise<Board>;
      await act(async () => {
        creating = store.create(created.name);
      });
      if (ordering === "before") await emit();
      await act(async () => {
        finishCreate(response(created));
        await creating;
      });
      if (ordering === "after") await emit();
      await emit();

      expect(host.querySelector('[role="combobox"]')?.textContent).toBe(
        "Доска",
      );
      // Equal labels belong to distinct boards and must remain separate.
      expect(store.list.map(({ id }) => id)).toEqual(["created", "existing"]);
      expect(store.board?.id).toBe("created");
    },
  );

  it("keeps a newer board received before the creation response", async () => {
    let creating!: Promise<Board>;
    await act(async () => {
      creating = store.create(created.name);
    });
    const newer: Board = {
      ...created,
      name: "Обновлённая доска",
      revision: 2,
      document: {
        ...created.document,
        nodes: [
          {
            id: "remote-note",
            type: "artifact",
            position: { x: 0, y: 0 },
            data: {
              kind: "note",
              title: "Remote note",
              text: "Latest content",
            },
          },
        ],
      },
    };
    await emit(newer);
    await act(async () => {
      finishCreate(response(created));
      await creating;
    });

    expect(store.list).toEqual([newer, existing]);
    expect(store.board).toEqual(newer);
    expect(store.current.current).toEqual(newer);
    expect(host.querySelector('[role="combobox"]')?.textContent).toBe(
      "Обновлённая доска",
    );
  });
});
