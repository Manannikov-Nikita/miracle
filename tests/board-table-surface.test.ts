// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BoardTableSurface from "../src/client/board/BoardTableSurface";

let host: HTMLDivElement, root: Root;
const outside = vi.fn(),
  boardKey = vi.fn(),
  boardPointer = vi.fn();
function Harness({ nestedDialog = false }: { nestedDialog?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { onClick: outside, "aria-label": "Агент" },
      "Агент",
    ),
    createElement(
      "section",
      {
        className: "board-workspace",
        onKeyDown: boardKey,
        onPointerDown: boardPointer,
      },
      createElement(
        "div",
        { className: "react-flow__viewport" },
        createElement(
          BoardTableSurface,
          { expanded, onClose: () => setExpanded(false) },
          createElement(
            "div",
            {
              className: "table-content",
              onKeyDown: (event) => event.stopPropagation(),
            },
            createElement(
              "button",
              {
                "aria-label": "Развернуть таблицу",
                onClick: () => setExpanded(true),
              },
              "Развернуть",
            ),
            createElement("input", { "aria-label": "Значение ячейки" }),
            nestedDialog && expanded
              ? createPortal(
                  createElement(
                    "div",
                    { role: "dialog" },
                    createElement(
                      "button",
                      { "aria-label": "Вложенный редактор" },
                      "Редактор",
                    ),
                  ),
                  document.body,
                )
              : null,
          ),
        ),
      ),
    ),
    createElement("section", {
      className: "board-workspace",
      "data-other-board": true,
    }),
  );
}
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
async function expand() {
  await act(async () => {
    button("Развернуть таблицу").focus();
    button("Развернуть таблицу").click();
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("expands one table inside its owning board, without a dialog or global interaction lock", async () => {
  await act(async () => root.render(createElement(Harness)));
  await expand();
  const region = host.querySelector(
    '[role="region"][aria-label="Таблица на всю доску"]',
  )!;
  expect(region).not.toBeNull();
  expect(region.parentElement).toBe(host.querySelector(".board-workspace"));
  expect(region.closest(".react-flow__viewport")).toBeNull();
  expect(host.querySelector("[data-other-board]")!.children).toHaveLength(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelectorAll(".table-content")).toHaveLength(1);
  expect(document.activeElement).toBe(button("Вернуться на доску"));
  await act(async () => button("Агент").click());
  expect(outside).toHaveBeenCalledOnce();
  expect(document.body.style.overflow).toBe("");
  expect(document.querySelector("[inert]")).toBeNull();
});
it("returns one table and focus to the remounted expansion trigger", async () => {
  await act(async () => root.render(createElement(Harness)));
  await expand();
  await act(async () => button("Вернуться на доску").click());
  expect(host.querySelector('[aria-label="Таблица на всю доску"]')).toBeNull();
  expect(
    host.querySelector(".react-flow__viewport .table-content"),
  ).not.toBeNull();
  expect(document.querySelectorAll(".table-content")).toHaveLength(1);
  expect(document.activeElement).toBe(button("Развернуть таблицу"));
  expect(host.querySelector(".board-table-surface-host")).toBeNull();
});
it("handles Escape despite table event isolation but leaves active inputs and nested dialogs alone", async () => {
  await act(async () =>
    root.render(createElement(Harness, { nestedDialog: true })),
  );
  await expand();
  const escape = (element: Element) =>
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  await act(async () => {
    escape(button("Вложенный редактор"));
  });
  expect(button("Вернуться на доску")).not.toBeNull();
  await act(async () => {
    escape(host.querySelector("input")!);
  });
  expect(button("Вернуться на доску")).not.toBeNull();
  await act(async () => {
    escape(host.querySelector(".table-content")!);
  });
  expect(button("Вернуться на доску")).toBeNull();
  expect(boardKey).not.toHaveBeenCalled();
});
it("isolates expanded pointer events from board selection", async () => {
  await act(async () => root.render(createElement(Harness)));
  await expand();
  await act(async () => {
    host
      .querySelector(".table-content")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
  expect(boardPointer).not.toHaveBeenCalled();
});
it("does not close when the grid consumes Escape and cleans its host on unmount", async () => {
  await act(async () => root.render(createElement(Harness)));
  await expand();
  const content = host.querySelector(".table-content")!;
  content.addEventListener("keydown", (event) => event.preventDefault());
  await act(async () => {
    content.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(button("Вернуться на доску")).not.toBeNull();
  const board = host.querySelector(".board-workspace")!;
  await act(async () => root.render(null));
  expect(board.classList.contains("board-table-surface-host")).toBe(false);
  expect(document.querySelector(".board-table-surface-expanded")).toBeNull();
});
it("keeps a standalone surface local when there is no owning board", async () => {
  await act(async () =>
    root.render(
      createElement(BoardTableSurface, {
        expanded: true,
        onClose: vi.fn(),
        children: createElement(
          "div",
          { className: "table-content" },
          "Значения",
        ),
      }),
    ),
  );
  const region = document.querySelector(".board-table-surface-expanded")!;
  expect(region.parentElement).toBe(
    host.querySelector(".board-table-surface-anchor"),
  );
  expect(document.querySelectorAll(".table-content")).toHaveLength(1);
});
