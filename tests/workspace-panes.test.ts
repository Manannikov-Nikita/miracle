// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import App from "../src/client/App";
import { api } from "../src/client/api";
import type { SqlSourceRequest } from "../src/client/components/SqlWorkspace";
import type { QueryRun } from "../src/shared/types";

const captured = vi.hoisted(() => ({
  onOpenRun: undefined as ((id: string) => Promise<void>) | undefined,
  sourceToOpen: null as SqlSourceRequest | null,
  workspaceId: "",
}));

vi.mock("../src/client/api", () => ({
  api: vi.fn(async () => []),
  openLocalSession: vi.fn(async () => ({ workspaceId: "pane-workspace" })),
}));
vi.mock("../src/client/agents/ProjectSync", () => ({
  ProjectSyncProvider: ({ children }: { children: ReactNode }) => children,
  useProjectSync: () => null,
}));
vi.mock("../src/client/agents/AgentAssistant", () => ({
  default: ({ onOpenRun }: { onOpenRun: (id: string) => Promise<void> }) => {
    captured.onOpenRun = onOpenRun;
    return null;
  },
}));
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
    default: ({
      onCollapse,
      sourceToOpen,
      workspaceId,
    }: {
      onCollapse: () => void;
      sourceToOpen: SqlSourceRequest | null;
      workspaceId: string;
    }) => {
      captured.sourceToOpen = sourceToOpen;
      captured.workspaceId = workspaceId;
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
    default: ({
      kind = "board",
      active,
    }: {
      kind?: string;
      active?: boolean;
    }) =>
      createElement("section", {
        "data-testid": `${kind}-content`,
        "data-active": active,
      }),
  };
});

describe("independent workspace panes on desktop", () => {
  let host: HTMLDivElement;
  let root: Root;
  const viewKey = "miracle:view:pane-workspace";

  beforeEach(() => {
    captured.onOpenRun = undefined;
    captured.sourceToOpen = null;
    captured.workspaceId = "";
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function button(label: string) {
    const found = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(found, label).not.toBeNull();
    return found!;
  }
  function pane(name: "sql" | "board" | "presentation") {
    return host.querySelector<HTMLElement>(`[data-testid="${name}-content"]`)!;
  }
  function expectPanes(sql: boolean, board: boolean) {
    expect(button("Редактор").getAttribute("aria-pressed")).toBe(String(sql));
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

  it("opens saved color settings from the bottom navigation group without resetting panes", async () => {
    await render("split");
    const settings = button("Настройки");
    expect(
      settings.closest('[aria-label="Управление рабочей областью"]'),
    ).not.toBeNull();
    await act(async () => {
      settings.focus();
      settings.click();
    });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Сохранённые цвета");
    expectPanes(true, true);
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          '[role="dialog"] [aria-label="Закрыть"]',
        )!
        .click(),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await settle();
    expect(document.activeElement).toBe(settings);
  });
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

  it("opens an agent run in the mounted editor and leaves panes untouched when loading fails", async () => {
    await render("board");
    expectPanes(false, true);
    const sql = pane("sql");
    const board = pane("board");
    const run: QueryRun = {
      id: "agent/run",
      status: "completed",
      startedAt: "2026-11-07T10:00:00.000Z",
      finishedAt: "2026-11-07T10:01:00.000Z",
      resultSetId: "agent-result",
      rowCount: 2,
      source: {
        connectionId: "agent-connection",
        database: "warehouse",
        catalog: "analytics",
        schema: "reports",
        sql: "select count(*) from trips where day = :date",
        dateRange: {
          startDate: "2026-11-01",
          endDate: "2026-11-02",
          granularity: "day",
          retries: 2,
        },
      },
    };
    vi.mocked(api).mockClear().mockResolvedValueOnce(run);
    expect(captured.onOpenRun).toBeTypeOf("function");
    await act(async () => captured.onOpenRun!(run.id));
    await settle();

    expectPanes(true, true);
    expect(pane("sql")).toBe(sql);
    expect(pane("board")).toBe(board);
    expect(captured.workspaceId).toBe("pane-workspace");
    expect(captured.sourceToOpen).toEqual({ source: run.source, run });
    // Opening existing results is a read; the App must not execute SQL again.
    expect(vi.mocked(api).mock.calls).toEqual([
      ["/api/query-runs/agent%2Frun"],
    ]);

    await click("Редактор");
    const previousSource = captured.sourceToOpen;
    const failure = new Error("Запрос больше не доступен");
    vi.mocked(api).mockClear().mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(captured.onOpenRun!("missing-run")).rejects.toBe(failure);
    });
    await settle();

    expectPanes(false, true);
    expect(pane("sql")).toBe(sql);
    expect(pane("board")).toBe(board);
    expect(captured.sourceToOpen).toBe(previousSource);
    expect(vi.mocked(api).mock.calls).toEqual([
      ["/api/query-runs/missing-run"],
    ]);
  });

  it("replaces the unfocused pane when opening a third and preserves all mounted workspaces", async () => {
    await render("split");
    expect(button("Презентация").getAttribute("aria-pressed")).toBe("false");
    const sql = pane("sql");
    const board = pane("board");
    const presentation = pane("presentation");

    await act(async () => {
      board.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    await click("Презентация");
    expectPanes(false, true);
    expect(button("Презентация").getAttribute("aria-pressed")).toBe("true");
    expect(board.dataset.active).toBe("true");
    expect(presentation.dataset.active).toBe("false");

    await act(async () => {
      presentation.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    await click("Редактор");
    expectPanes(true, false);
    expect(presentation.dataset.active).toBe("true");
    expect(board.dataset.active).toBe("false");
    expect(presentation.closest(".pane-host")?.hasAttribute("inert")).toBe(
      false,
    );
    expect(
      sql.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      board.compareDocumentPosition(presentation) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await click("Редактор");
    expect(button("Доска").getAttribute("aria-pressed")).toBe("false");
    expect(button("Презентация").getAttribute("aria-pressed")).toBe("true");
    expect(presentation.closest("[hidden]")).toBeNull();
    await click("Презентация");
    expect(presentation.closest(".pane-host")?.hasAttribute("inert")).toBe(
      true,
    );
    expect(presentation.closest("[hidden]")).not.toBeNull();
    await click("Доска");
    expect(pane("sql")).toBe(sql);
    expect(pane("board")).toBe(board);
    expect(pane("presentation")).toBe(presentation);
  });

  it("restores distinct split sizes for each pair and reads the legacy editor and board size", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-panel") &&
          !this.hasAttribute("data-disabled")
          ? 500
          : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(
      function (this: HTMLElement) {
        return (
          Array.from(this.parentElement?.children ?? []).indexOf(this) * 100
        );
      },
    );
    const layoutKey = "miracle:workspace-layout:pane-workspace";
    localStorage.setItem(layoutKey, JSON.stringify({ sql: 42, board: 58 }));
    const separator = () =>
      host.querySelector<HTMLElement>(".main-split [role=separator]")!;
    const size = () => Number(separator().getAttribute("aria-valuenow"));
    const resize = () =>
      act(async () => {
        separator().dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });

    await render("split");
    expect(size()).toBe(42);
    await act(async () => {
      pane("sql").dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    await click("Презентация");
    expect(size()).toBe(45);
    await resize();
    expect(size()).toBe(50);
    await act(async () => {
      pane("presentation").dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    await click("Доска");
    expect(size()).toBe(50);
    await resize();
    expect(size()).toBe(55);

    await click("Редактор");
    expect(size()).toBe(50);
    await act(async () => {
      pane("sql").dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    await click("Доска");
    expect(size()).toBe(42);
    expect(JSON.parse(localStorage.getItem(layoutKey)!)).toEqual({
      sql: 42,
      board: 58,
    });

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(App)));
    await settle();
    await act(async () => {
      pane("board").dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true }),
      );
    });
    await click("Презентация");
    expect(size()).toBe(55);
  });

  it("toggles only the requested pane and retains mounted editor state", async () => {
    await render("board");
    expectPanes(false, true);
    const sqlContent = pane("sql");
    const boardContent = pane("board");
    await click("Редактор");
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
    await click("Редактор");
    expectPanes(false, true);
    await click("Доска");
    expectPanes(false, false);
    await click("Редактор");
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
    await click("Редактор");
    await click("Доска");
    await act(async () => collapse.click());
    await settle();
    expectPanes(false, true);
  });

  it("keeps the resized explorer width across tabs, hiding and reload without remounting the editor", async () => {
    vi.stubGlobal("innerWidth", 1440);
    await render("sql");
    const editor = pane("sql");
    const separator = () =>
      host.querySelector<HTMLElement>('[aria-label="Ширина обозревателя"]');
    expect(separator()).not.toBeNull();
    const initialWidth = Number(separator()!.getAttribute("aria-valuenow"));
    await act(async () => {
      separator()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    const resizedWidth = Number(separator()!.getAttribute("aria-valuenow"));
    expect(resizedWidth).toBeGreaterThan(initialWidth);
    await act(async () => {
      separator()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    const expandedWidth = Number(separator()!.getAttribute("aria-valuenow"));
    await click("Доска");
    expect(
      Number(separator()!.getAttribute("aria-valuenow")),
    ).toBeLessThanOrEqual(1440 - 340 - 400 - 5);
    await click("Доска");
    expect(Number(separator()!.getAttribute("aria-valuenow"))).toBe(
      expandedWidth,
    );
    await act(async () => {
      window.dispatchEvent(new Event("miracle:reset-layout"));
    });
    await act(async () => {
      separator()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    for (const tab of [
      "Проводник проекта",
      "История запросов",
      "Источники данных",
    ]) {
      await click(tab);
      expect(Number(separator()!.getAttribute("aria-valuenow"))).toBe(
        resizedWidth,
      );
      expect(pane("sql")).toBe(editor);
    }
    await click("Источники данных");
    expect(separator()).toBeNull();
    await click("Источники данных");
    expect(Number(separator()!.getAttribute("aria-valuenow"))).toBe(
      resizedWidth,
    );
    expect(pane("sql")).toBe(editor);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(App)));
    await settle();
    expect(Number(separator()!.getAttribute("aria-valuenow"))).toBe(
      resizedWidth,
    );
    await act(async () =>
      window.dispatchEvent(new Event("miracle:reset-layout")),
    );
    expect(Number(separator()!.getAttribute("aria-valuenow"))).toBe(
      initialWidth,
    );
  });

  it("bounds pointer resizing to the available space and retains the preference when the window shrinks", async () => {
    vi.stubGlobal("innerWidth", 1440);
    await render("sql");
    const separator = host.querySelector<HTMLElement>(
      '[aria-label="Ширина обозревателя"]',
    );
    expect(separator).not.toBeNull();
    const handle = separator!;
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    const pointer = async (type: string, clientX: number) => {
      await act(async () => {
        const event = new MouseEvent(type, {
          clientX,
          button: 0,
          bubbles: true,
        });
        Object.defineProperty(event, "pointerId", { value: 1 });
        handle.dispatchEvent(event);
      });
    };
    await pointer("pointerdown", 228);
    await pointer("pointermove", 528);
    await pointer("pointerup", 528);
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(528);
    vi.stubGlobal("innerWidth", 800);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeLessThan(528);
    vi.stubGlobal("innerWidth", 1440);
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(528);
    await pointer("pointerdown", 528);
    await pointer("pointermove", -500);
    await pointer("pointerup", -500);
    expect(handle.getAttribute("aria-valuenow")).toBe(
      handle.getAttribute("aria-valuemin"),
    );
  });
});
