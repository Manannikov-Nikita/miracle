// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/client/App";

vi.mock("../src/client/api", () => ({
  api: vi.fn(async () => []),
  openLocalSession: vi.fn(async () => ({ workspaceId: "pane-workspace" })),
}));
vi.mock("../src/client/agents/ProjectSync", () => ({
  ProjectSyncProvider: ({ children }: { children: ReactNode }) => children,
  useProjectSync: () => null,
}));
vi.mock("../src/client/agents/AgentAssistant", () => ({ default: () => null }));
vi.mock("../src/client/components/Connections", () => ({
  default: () => null,
}));
vi.mock("../src/client/components/Explorer", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ kind }: { kind: string }) =>
      createElement("aside", { "aria-label": "Test explorer" }, kind),
  };
});
vi.mock("../src/client/components/SqlWorkspace", async () => {
  const { createElement, useState } = await import("react");
  return {
    default: ({ onCollapse }: { onCollapse: () => void }) => {
      const [sql, setSql] = useState("select 1");
      return createElement(
        "section",
        { "data-testid": "sql-content" },
        createElement("input", {
          "aria-label": "Test SQL draft",
          value: sql,
          onChange: (event: { target: { value: string } }) =>
            setSql(event.target.value),
        }),
        createElement("button", { onClick: onCollapse }, "Collapse SQL"),
      );
    },
  };
});
vi.mock("../src/client/board/BoardWorkspace", async () => {
  const { createElement } = await import("react");
  return {
    default: () =>
      createElement("section", { "data-testid": "board-content" }, "Board"),
  };
});

describe("independent workspace panes on desktop", () => {
  let host: HTMLDivElement;
  let root: Root;
  const viewKey = "miracle:view:pane-workspace";

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("innerWidth", 980);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width:1023px)",
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    // Keep the actual resizable components and their imperative API. jsdom has
    // no element geometry, so physical sizing is covered by the browser check.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function button(label: string) {
    const found = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(found, label).not.toBeNull();
    return found!;
  }
  function pane(name: "sql" | "board") {
    return host.querySelector<HTMLElement>(`[data-testid="${name}-content"]`)!;
  }
  function expectPanes(sql: boolean, board: boolean) {
    expect(button("Редактор SQL").getAttribute("aria-pressed")).toBe(
      String(sql),
    );
    expect(button("Доска").getAttribute("aria-pressed")).toBe(String(board));
    expect(pane("sql").closest(".pane-host")?.hasAttribute("inert")).toBe(!sql);
    expect(pane("board").closest(".pane-host")?.hasAttribute("inert")).toBe(
      !board,
    );
    expect(Boolean(pane("sql").closest("[hidden]"))).toBe(!sql && !board);
    expect(Boolean(pane("board").closest("[hidden]"))).toBe(!sql && !board);
  }
  async function settle() {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  async function render(mode: "sql" | "board" | "split") {
    localStorage.setItem(
      viewKey,
      JSON.stringify({
        paneMode: mode,
        mobileTab: mode === "board" ? "board" : "sql",
        explorer: "sources",
      }),
    );
    await act(async () => root.render(createElement(App)));
    await settle();
  }
  async function click(label: string) {
    await act(async () => button(label).click());
    await settle();
  }

  it("toggles only the requested pane and retains mounted editor state", async () => {
    await render("board");
    expectPanes(false, true);
    const sqlContent = pane("sql");
    const boardContent = pane("board");
    await click("Редактор SQL");
    expectPanes(true, true);

    const input = host.querySelector<HTMLInputElement>(
      '[aria-label="Test SQL draft"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "select 42");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Редактор SQL");
    expectPanes(false, true);
    await click("Доска");
    expectPanes(false, false);
    await click("Редактор SQL");
    expectPanes(true, false);
    await click("Доска");
    expectPanes(true, true);
    expect(pane("sql")).toBe(sqlContent);
    expect(pane("board")).toBe(boardContent);
    expect(input.value).toBe("select 42");
  });

  it("persists both panes hidden and restores that state on reload", async () => {
    await render("board");
    await click("Доска");
    expectPanes(false, false);
    expect(JSON.parse(localStorage.getItem(viewKey)!).paneMode).toBe("none");
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(App)));
    await settle();
    expectPanes(false, false);
    await click("Доска");
    expectPanes(false, true);
  });

  it("preserves the explorer when toggling panes and collapses only SQL from its header", async () => {
    await render("sql");
    await click("Источники данных");
    const explorer = host.querySelector('[aria-label="Test explorer"]');
    expect(explorer).not.toBeNull();
    await click("Доска");
    expectPanes(true, true);
    expect(host.querySelector('[aria-label="Test explorer"]')).toBe(explorer);
    await click("Доска");
    expectPanes(true, false);
    const collapse = [...host.querySelectorAll("button")].find(
      (item) => item.textContent === "Collapse SQL",
    )!;
    await act(async () => collapse.click());
    await settle();
    expectPanes(false, false);
    expect(host.querySelector('[aria-label="Test explorer"]')).toBe(explorer);
    await click("Редактор SQL");
    await click("Доска");
    await act(async () => collapse.click());
    await settle();
    expectPanes(false, true);
  });
});
