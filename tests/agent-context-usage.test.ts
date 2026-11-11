// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContextSnapshot } from "../src/shared/agent-context";
import AgentContextUsage from "../src/client/agents/AgentContextUsage";
import { contextBreakdown } from "../src/client/agents/agent-context-breakdown";

const snapshot: AgentContextSnapshot = {
  provider: "codex",
  usedTokens: 1000,
  contextWindow: 4000,
  model: "reported-model",
  measuredAt: "2026-11-11T12:30:00Z",
  estimates: { conversation: 300, project: 200, tools: 100, instructions: 50 },
};

describe("context breakdown totals", () => {
  it("keeps provider totals and assigns unobserved usage to other context", () => {
    const result = contextBreakdown(snapshot);
    expect(result.usedTokens).toBe(1000);
    expect(result.contextWindow).toBe(4000);
    expect(result.percentage).toBe(25);
    expect(result.availableTokens).toBe(3000);
    expect(result.rows.map((row) => row.tokens)).toEqual([
      300, 200, 100, 50, 350,
    ]);
    expect(result.rows.map((row) => row.width)).toEqual([
      7.5, 5, 2.5, 1.25, 8.75,
    ]);
  });

  it("scales estimates down with integer remainders without changing actual usage", () => {
    const result = contextBreakdown({
      ...snapshot,
      usedTokens: 7,
      estimates: { conversation: 4, project: 4, tools: 4, instructions: 4 },
    });
    expect(result.usedTokens).toBe(7);
    expect(result.rows.map((row) => row.tokens)).toEqual([2, 2, 2, 1, 0]);
    expect(result.rows.reduce((sum, row) => sum + row.tokens!, 0)).toBe(7);
  });

  it("reports over-limit usage truthfully while clamping segment geometry", () => {
    const result = contextBreakdown({ ...snapshot, contextWindow: 500 });
    expect(result.percentage).toBe(200);
    expect(result.availableTokens).toBe(0);
    expect(result.rows.reduce((sum, row) => sum + row.width, 0)).toBe(100);
    expect(result.rows.map((row) => row.tokens)).toEqual([
      300, 200, 100, 50, 350,
    ]);
  });

  it("distinguishes zero usage from unknown usage and does not guess missing capacity", () => {
    expect(contextBreakdown({ ...snapshot, usedTokens: 0 })).toMatchObject({
      usedTokens: 0,
      percentage: 0,
      availableTokens: 4000,
    });
    expect(contextBreakdown(null)).toMatchObject({
      usedTokens: null,
      contextWindow: null,
      percentage: null,
      availableTokens: null,
    });
    const unknownWindow = contextBreakdown({
      ...snapshot,
      contextWindow: undefined,
    });
    expect(unknownWindow).toMatchObject({
      usedTokens: 1000,
      contextWindow: null,
      percentage: null,
      availableTokens: null,
    });
    expect(unknownWindow.rows.every((row) => row.width === 0)).toBe(true);
    expect(
      contextBreakdown({ ...snapshot, usedTokens: Number.NaN }).usedTokens,
    ).toBeNull();
  });
});

describe("agent context disclosure", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const render = async (
    usage: AgentContextSnapshot | null = snapshot,
    chatKey = "chat",
    updating = false,
  ) =>
    act(async () =>
      root.render(
        createElement(AgentContextUsage, { usage, chatKey, updating }),
      ),
    );
  const trigger = () =>
    host.querySelector<HTMLButtonElement>(".agent-context-trigger")!;
  const panel = () => host.querySelector<HTMLElement>(".agent-context-panel");

  it("uses a native keyboard button and consumes Escape before the parent chat closes", async () => {
    let parentEscapes = 0;
    await act(async () =>
      root.render(
        createElement(
          "aside",
          {
            onKeyDown: (event) => {
              if (event.key === "Escape") parentEscapes++;
            },
          },
          createElement(AgentContextUsage, {
            usage: snapshot,
            chatKey: "chat",
          }),
          createElement("textarea"),
        ),
      ),
    );
    expect(trigger().tagName).toBe("BUTTON");
    expect(trigger().type).toBe("button");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    trigger().focus();
    // Browsers synthesize a detail=0 click for Enter/Space on a native button.
    await act(async () =>
      trigger().dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 0 }),
      ),
    );
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(panel()!.id);
    const textarea = host.querySelector("textarea")!;
    textarea.focus();
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => textarea.dispatchEvent(escape));
    expect(panel()).toBeNull();
    expect(escape.defaultPrevented).toBe(true);
    expect(parentEscapes).toBe(0);
    expect(document.activeElement).toBe(trigger());
  });

  it("retains the disclosure for inside clicks and closes on outside pointer or chat switch", async () => {
    await render();
    await act(async () => trigger().click());
    await act(async () =>
      panel()!.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(panel()).not.toBeNull();
    await act(async () =>
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    expect(panel()).toBeNull();
    await act(async () => trigger().click());
    await render(snapshot, "another-chat");
    expect(panel()).toBeNull();
    await render(snapshot, "chat");
    expect(panel()).toBeNull();
  });

  it("keeps the disclosure inside its agent pane when attachments or window size reduce available height", async () => {
    const resizeTargets = new Map<Element, () => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe(target: Element) {
          resizeTargets.set(target, this.callback);
        }
        disconnect() {
          resizeTargets.clear();
        }
      },
    );
    host.className = "agent-panel";
    await act(async () =>
      root.render(
        createElement(
          "div",
          { className: "agent-main-pane" },
          createElement(
            "div",
            { className: "agent-composer-zone" },
            createElement(AgentContextUsage, {
              usage: snapshot,
              chatKey: "chat",
            }),
            createElement("textarea"),
          ),
        ),
      ),
    );
    let anchorTop = 300;
    let paneTop = 40;
    const pane = host.querySelector<HTMLElement>(".agent-main-pane")!;
    const composer = host.querySelector<HTMLElement>(".agent-composer-zone")!;
    const anchor = host.querySelector<HTMLElement>(".agent-context-usage")!;
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, anchorTop, 448, 36),
    );
    vi.spyOn(pane, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, paneTop, 480, 600),
    );
    await act(async () => trigger().click());
    // Both the trigger gap and the safe inset at the pane's top remain 8px.
    expect(panel()!.style.maxHeight).toBe("244px");
    anchorTop = 220;
    await act(async () => resizeTargets.get(composer)?.());
    expect(panel()!.style.maxHeight).toBe("164px");
    paneTop = 80;
    await act(async () => resizeTargets.get(host)?.());
    expect(panel()!.style.maxHeight).toBe("124px");
    anchorTop = 800;
    await act(async () => window.dispatchEvent(new Event("resize")));
    expect(panel()!.style.maxHeight).toBe("440px");
  });

  it("shows bounded approximate categories with explicit provider and capacity", async () => {
    await render();
    await act(async () => trigger().click());
    const rows = [
      ...panel()!.querySelectorAll(
        '[data-context-category]:not([data-context-category="available"])',
      ),
    ];
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.textContent?.includes("≈"))).toBe(true);
    expect(rows[4].textContent).toContain("350");
    expect(panel()!.textContent).toContain("Codex");
    expect(panel()!.textContent).toContain("reported-model");
    expect(panel()!.textContent).toContain("25%");
    expect(panel()!.textContent).toContain("CLI");
    expect(panel()!.textContent).toContain("Miracle");
    expect(panel()!.querySelector("time")?.dateTime).toBe(snapshot.measuredAt);
  });

  it("shows unavailable states without an invented percentage, capacity or default model", async () => {
    await render(null);
    await act(async () => trigger().click());
    expect(panel()!.textContent).toContain("Использование недоступно");
    expect(host.textContent).not.toContain("%");
    expect(host.textContent).not.toContain("0 /");
    await render({ ...snapshot, contextWindow: undefined, model: undefined });
    expect(panel()!.textContent).toContain("Размер окна неизвестен");
    expect(host.textContent).not.toContain("%");
    expect(panel()!.textContent).not.toContain("reported-model");
    expect(
      panel()!.querySelector('[data-context-category="conversation"]')
        ?.textContent,
    ).toContain("≈300");
  });

  it("keeps measured totals while updating and renders over-limit and zero usage", async () => {
    await render({ ...snapshot, contextWindow: 500 }, "chat", true);
    await act(async () => trigger().click());
    expect(panel()!.textContent).toContain("200%");
    expect(panel()!.textContent).toContain("Последний замер");
    expect(panel()!.textContent).toContain("новый замер");
    expect(
      panel()!.querySelector('[data-context-category="available"]')
        ?.textContent,
    ).toContain("0");
    await render({ ...snapshot, usedTokens: 0 });
    expect(panel()!.textContent).toContain("0%");
    expect(
      panel()!.querySelector('[data-context-category="conversation"]')
        ?.textContent,
    ).toContain("≈0");
  });
});
