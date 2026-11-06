import { describe, expect, it } from "vitest";
import {
  CanvasWorkspace,
  type CanvasHandle,
} from "../src/client/canvas-workspace";
import type { ResultSet } from "../src/shared/types";
import type { BoardFragment } from "../src/client/board/clipboard";

const result = { id: "result" } as ResultSet;
const fragment = {
  version: 1,
  copyId: "copy",
  workspaceId: "workspace",
  boardId: "source",
  document: { schemaVersion: 1, nodes: [], edges: [] },
} as BoardFragment;

function setup() {
  const writes: string[] = [];
  let selected = {
    kind: "presentation" as const,
    boardId: "deck-a",
    slideId: "slide-a",
  };
  const handle: CanvasHandle = {
    destination: () => selected,
    insertResult: async (_result, target) => {
      await Promise.resolve();
      writes.push(`${target?.boardId}/${target?.slideId}`);
    },
    insertFragment: async (_fragment, target, point) => {
      writes.push(
        `${target?.boardId}/${target?.slideId}@${point?.x},${point?.y}`,
      );
    },
    containsPoint: (point) => point.x >= 500,
    screenToCanvas: (point) => ({ x: point.x - 500, y: point.y * 2 }),
  };
  const registry = new CanvasWorkspace({
    onOpen: () => {
      selected = {
        kind: "presentation",
        boardId: "deck-b",
        slideId: "slide-b",
      };
    },
    onTransfer: () => {},
  });
  registry.register("presentation", handle);
  return { registry, handle, writes };
}

describe("canvas destination routing", () => {
  it("does not mistake a loading destination for an empty workspace", async () => {
    const { registry, handle, writes } = setup();
    registry.register("presentation", { ...handle, ready: () => false });
    await expect(registry.addResult("presentation", result)).rejects.toThrow(
      "загружается",
    );
    expect(writes).toEqual([]);
  });

  it("reuses the insertion identity after a lost acknowledgment and coalesces an in-flight action", async () => {
    const { registry, handle } = setup();
    const ids: string[] = [];
    let first = true;
    let finish!: () => void;
    registry.register("presentation", {
      ...handle,
      destination: () => ({
        kind: "presentation",
        boardId: "deck",
        slideId: "slide",
      }),
      insertResult: async (_result, _target, actionId) => {
        ids.push(actionId!);
        if (first) {
          first = false;
          throw new Error("lost acknowledgment");
        }
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    await expect(registry.addResult("presentation", result)).rejects.toThrow(
      "lost acknowledgment",
    );
    const retry = registry.addResult("presentation", result);
    const doubleClick = registry.addResult("presentation", result);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    finish();
    await Promise.all([retry, doubleClick]);
  });

  it("captures result destination before opening or changing focus", async () => {
    const { registry, writes } = setup();
    await registry.addResult("presentation", result);
    expect(writes).toEqual(["deck-a/slide-a"]);
  });

  it("copies a drop only to the canvas under the pointer in its own coordinates", async () => {
    const { registry, writes } = setup();
    expect(await registry.drop(fragment, { x: 20, y: 40 })).toBe(false);
    expect(writes).toEqual([]);
    expect(await registry.drop(fragment, { x: 620, y: 40 })).toBe(true);
    expect(writes).toEqual(["deck-a/slide-a@120,80"]);
  });

  it("stale cleanup cannot unregister a newer canvas instance", () => {
    const { registry, handle } = setup();
    const release = registry.register("presentation", handle);
    const next = { ...handle };
    registry.register("presentation", next);
    release();
    expect(registry.getCanvas("presentation")).toBe(next);
  });

  it("reports insertion failure without changing the transfer source", async () => {
    const { registry, handle } = setup();
    const before = structuredClone(fragment);
    registry.register("presentation", {
      ...handle,
      insertFragment: async () => {
        throw new Error("save failed");
      },
    });
    await expect(registry.drop(fragment, { x: 620, y: 40 })).rejects.toThrow(
      "save failed",
    );
    expect(fragment).toEqual(before);
  });
});
