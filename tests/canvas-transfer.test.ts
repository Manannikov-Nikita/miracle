// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  CanvasWorkspaceProvider,
  useCanvasWorkspace,
} from "../src/client/canvas-workspace";
import type { BoardFragment } from "../src/client/board/clipboard";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";

let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("refreshes removed slide choices and returns keyboard focus to the transfer trigger", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let slide = "first";
  vi.mocked(api).mockImplementation(
    async (path) =>
      (path.includes("?kind=")
        ? [{ id: "deck", name: "Deck", kind: "presentation" }]
        : {
            id: "deck",
            document: {
              slides: [{ id: slide, title: slide, background: "#ffffff" }],
            },
          }) as never,
  );
  function Content() {
    const registry = useCanvasWorkspace()!;
    return createElement(
      "button",
      {
        onClick: () =>
          registry.transfer({
            version: 1,
            copyId: "copy",
            workspaceId: "w",
            boardId: "board",
            document: { schemaVersion: 1, nodes: [], edges: [] },
          } as BoardFragment),
      },
      "Перенести",
    );
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanup = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
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
  const trigger = host.querySelector("button")!;
  await act(async () => {
    trigger.focus();
    trigger.click();
  });
  const slideSelect = () =>
    document.querySelectorAll<HTMLSelectElement>('[role="dialog"] select')[1];
  expect(slideSelect().value).toBe("first");
  slide = "replacement";
  const refresh = document.querySelector<HTMLButtonElement>(
    '[aria-label="Обновить презентации и слайды"]',
  );
  expect(refresh).not.toBeNull();
  await act(async () => refresh!.click());
  expect(slideSelect().value).toBe("replacement");
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent === "Отмена")!
      .click(),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(document.activeElement).toBe(trigger);
});
