// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Position } from "@xyflow/react";
import BoardEdgeView, {
  type BoardEdgeViewData,
} from "../src/client/board/BoardEdgeView";
import type { BoardEdge } from "../src/shared/types";

vi.mock("@xyflow/react", async (original) => {
  const actual = await original<typeof import("@xyflow/react")>();
  return {
    ...actual,
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) =>
      createPortal(children, document.body),
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    useReactFlow: () => ({
      screenToFlowPosition: (point: { x: number; y: number }) => point,
      getNodes: () => [],
      getInternalNode: () => undefined,
    }),
    useStore: (select: (state: unknown) => unknown) =>
      select({ width: 800, height: 600 }),
  };
});

describe("inline board edge editing", () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: unknown[];
  let externalLabel: ((label: string) => void) | undefined;
  const initial: BoardEdge = {
    id: "edge",
    source: "a",
    target: "b",
    label: "Связь",
  };
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    changes = [];
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(editable = true) {
    function Harness() {
      const [edge, setEdge] = useState(initial);
      const [editing, setEditing] = useState(false);
      const [selected, setSelected] = useState(true);
      externalLabel = (label) => setEdge((old) => ({ ...old, label }));
      const data: BoardEdgeViewData = {
        edge,
        editable,
        editing,
        onGeometryChange: () => {},
        onEdit: () => setEditing(true),
        onFinishEdit: () => setEditing(false),
        onClose: () => setSelected(false),
        onDelete: () => {
          changes.push("delete");
          setSelected(false);
        },
        onChange: (patch) => {
          changes.push(patch);
          setEdge((old) => ({
            ...old,
            ...patch,
            appearance: { ...old.appearance, ...patch.appearance },
          }));
        },
      };
      return createElement(
        "svg",
        null,
        createElement(BoardEdgeView, {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceX: 100,
          sourceY: 200,
          targetX: 600,
          targetY: 200,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          selected,
          data,
        }),
      );
    }
    await act(async () => root.render(createElement(Harness)));
  }
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(button).not.toBeNull();
    await act(async () => button!.click());
  }
  async function fill(value: string) {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Подпись стрелки"]',
    )!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }
  async function choose(menu: string, value: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${menu}"]`,
    )!;
    await act(async () => trigger.focus());
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ].find(
      (option) =>
        (option.getAttribute("aria-label") ?? option.textContent?.trim()) ===
        value,
    );
    expect(
      item,
      `${menu}: ${value}; found ${[...document.querySelectorAll('[role="menuitemradio"]')].map((option) => option.textContent).join(", ")}`,
    ).toBeDefined();
    await act(async () => item!.click());
    // Radix restores trigger focus after its content has unmounted.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  it("opens the inline editor without changing the document and commits Enter once", async () => {
    await render();
    expect(document.querySelector("input")).toBeNull();
    await click("Изменить подпись стрелки");
    expect(changes).toEqual([]);
    const input = await fill("Причина → результат");
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(changes).toEqual([{ label: "Причина → результат" }]);
    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).toContain("Причина → результат");
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Изменить подпись стрелки",
    );
  });
  it("cancels Escape without saving and leaves the canonical label intact", async () => {
    await render();
    await click("Изменить подпись стрелки");
    const input = await fill("Черновик");
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(changes).toEqual([]);
    expect(document.body.textContent).toContain("Связь");
    expect(document.querySelector("input")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Изменить подпись стрелки",
    );
  });
  it("does not save unchanged text on blur", async () => {
    await render();
    await click("Изменить подпись стрелки");
    await act(async () =>
      document.querySelector<HTMLInputElement>("input")!.blur(),
    );
    expect(changes).toEqual([]);
  });
  it("commits changed text on blur without stealing focus from the next control", async () => {
    await render();
    await click("Изменить подпись стрелки");
    await fill("Новая подпись");
    const nextControl = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Форма линии"]',
    )!;
    await act(async () => nextControl.focus());
    expect(changes).toEqual([{ label: "Новая подпись" }]);
    expect(document.activeElement).toBe(nextControl);
  });
  it("does not overwrite a remote label with a stale draft", async () => {
    await render();
    await click("Изменить подпись стрелки");
    await fill("Старый черновик");
    await act(async () => externalLabel!("Новая удалённая подпись"));
    const input = document.querySelector<HTMLInputElement>("input");
    if (input) await act(async () => input.blur());
    expect(changes).toEqual([]);
    expect(document.body.textContent).toContain("Новая удалённая подпись");
  });
  it("keeps read-only edges free of mutation controls", async () => {
    await render(false);
    expect(
      document.querySelector('button[aria-label="Изменить подпись стрелки"]'),
    ).toBeNull();
    expect(
      document.querySelector('button[aria-label="Удалить стрелку"]'),
    ).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(document.body.textContent).toContain("Связь");
  });
  it("changes visible line styling and arrowheads from the floating menus", async () => {
    await render();
    const path = () =>
      host.querySelector<SVGPathElement>(".react-flow__edge-path")!;
    expect(path().style.strokeWidth).toBe("1.5");
    expect(path().hasAttribute("marker-start")).toBe(false);
    expect(path().getAttribute("marker-end")).toMatch(
      /^url\(#board-edge-arrow-/,
    );
    await choose("Форма линии", "Угловая");
    expect(changes).toEqual([]);
    await choose("Тип линии", "Пунктирная");
    expect(path().style.strokeDasharray).toBe("6 4.5");
    await choose("Толщина линии", "3 px");
    expect(path().style.strokeWidth).toBe("3");
    expect(path().style.strokeDasharray).toBe("12 9");
    await choose("Цвет линии", "Синий");
    expect(path().style.stroke).toBe("rgb(145, 181, 255)");
    expect(host.querySelector("marker path")?.getAttribute("fill")).toBe(
      "#91b5ff",
    );
    await choose("Наконечники", "С двух сторон");
    expect(path().getAttribute("marker-start")).toBe(
      path().getAttribute("marker-end"),
    );
    await choose("Форма линии", "Прямая");
    expect(path().getAttribute("d")).toBe("M 100,200L 600,200");
    expect(changes).toHaveLength(5);
    await click("Закрыть свойства стрелки");
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    expect(changes).toHaveLength(5);
  });
});
