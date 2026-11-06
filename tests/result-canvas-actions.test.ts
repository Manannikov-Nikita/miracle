// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ResultCanvasActions from "../src/client/components/ResultCanvasActions";
import {
  CanvasWorkspaceProvider,
  useCanvasWorkspace,
  type CanvasDestination,
} from "../src/client/canvas-workspace";
import type { ResultSet } from "../src/shared/types";

describe("SQL result destinations", () => {
  let cleanup = async () => {};
  afterEach(async () => {
    await cleanup();
    vi.unstubAllGlobals();
  });
  it("offers both canvases and inserts only into the chosen destination", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    cleanup = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    const inserted: CanvasDestination[] = [];
    function Content() {
      const registry = useCanvasWorkspace()!;
      for (const kind of ["board", "presentation"] as const)
        registry.register(kind, {
          destination: () => ({
            kind,
            boardId: `${kind}-doc`,
            ...(kind === "presentation" ? { slideId: "slide" } : {}),
          }),
          insertResult: async (_result, target) => {
            inserted.push(target!);
          },
          insertFragment: async () => {},
          containsPoint: () => false,
          screenToCanvas: (p) => p,
        });
      return createElement(ResultCanvasActions, {
        result: { id: "r" } as ResultSet,
        disabled: false,
        onBoardFallback: () => {},
        onNotify: () => {},
      });
    }
    await act(async () =>
      root.render(
        createElement(CanvasWorkspaceProvider, {
          workspaceId: "w",
          onOpen: () => {},
          onTransferOpen: () => {},
          onNotify: () => {},
          children: createElement(Content),
        }),
      ),
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Добавить результат в презентацию"]',
        )!
        .click(),
    );
    expect(inserted).toEqual([
      { kind: "presentation", boardId: "presentation-doc", slideId: "slide" },
    ]);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[aria-label="Добавить результат на доску"]',
        )!
        .click(),
    );
    expect(inserted[1]).toEqual({ kind: "board", boardId: "board-doc" });
  });
});
