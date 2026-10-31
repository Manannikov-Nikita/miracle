// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentChatView from "../src/client/agents/AgentChatView";
import AgentHistory from "../src/client/agents/AgentHistory";
import type { AgentChatState } from "../src/client/agents/useAgentChat";

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
  vi.unstubAllGlobals();
});
const state = () =>
  ({
    selected: "chat",
    profiles: [
      { id: "profile", name: "Codex local", provider: "codex", trusted: true },
    ],
    chats: [],
    conversation: {
      chat: { id: "chat", profileId: "profile", provider: "codex" },
      messages: [],
      turns: [],
    },
    active: null,
    busy: false,
    resolvedApprovals: new Map(),
    setSelected: vi.fn(),
    stop: vi.fn(async () => {}),
  }) as unknown as AgentChatState;
async function render(value: AgentChatState, onSend = vi.fn(async () => {})) {
  await act(async () =>
    root.render(
      createElement(AgentChatView, {
        state: value,
        selectedProfile: "profile",
        onProfileChange: vi.fn(),
        draft: "Next question",
        onDraftChange: vi.fn(),
        onSend,
        onSettings: vi.fn(),
      }),
    ),
  );
  return onSend;
}
it("cannot send with the keyboard while a turn is active, but can stop it from the composer", async () => {
  const value = state();
  value.active = {
    id: "turn",
    chatId: "chat",
    status: "running",
    context: {},
    createdAt: "now",
  };
  const send = await render(value);
  await act(async () =>
    host.querySelector("textarea")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
      }),
    ),
  );
  expect(send).not.toHaveBeenCalled();
  const stop = host.querySelector<HTMLButtonElement>(
    'form button[aria-label="Остановить"]',
  );
  expect(stop).not.toBeNull();
  await act(async () => stop!.click());
  expect(value.stop).toHaveBeenCalledOnce();
});
it("does not scroll the transcript when only tool events arrive", async () => {
  const value = state();
  await render(value);
  const log = host.querySelector<HTMLElement>('[role="log"]')!;
  Object.defineProperties(log, {
    scrollHeight: { value: 900, configurable: true },
    clientHeight: { value: 400 },
  });
  log.scrollTop = 480;
  const updated = {
    ...value,
    conversation: {
      ...value.conversation!,
      messages: [
        {
          id: "tool",
          chatId: "chat",
          turnId: "turn",
          role: "action" as const,
          content: "read_schema",
          createdAt: "now",
        },
      ],
    },
  };
  await render(updated);
  expect(log.scrollTop).toBe(480);
});
it("does not submit composing text or a draft with an untrusted profile", async () => {
  const value = state();
  value.selected = "";
  value.profiles[0].trusted = false;
  const send = await render(value);
  await act(async () =>
    host.querySelector("textarea")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        isComposing: true,
      }),
    ),
  );
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(send).not.toHaveBeenCalled();
});

it("keeps the latest reply visible on viewport resize, without moving a reader who scrolled up", async () => {
  let resize: () => void = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  await render(state());
  const log = host.querySelector<HTMLElement>('[role="log"]')!;
  Object.defineProperties(log, {
    scrollHeight: { value: 900 },
    clientHeight: { value: 400, configurable: true },
  });
  log.scrollTop = 500;
  await act(async () => log.dispatchEvent(new Event("scroll")));
  Object.defineProperty(log, "clientHeight", { value: 300 });
  await act(async () => resize());
  expect(log.scrollTop).toBeGreaterThanOrEqual(600);
  log.scrollTop = 200;
  await act(async () => log.dispatchEvent(new Event("scroll")));
  await act(async () => resize());
  expect(log.scrollTop).toBe(200);
});

it("returns focus to the composer when history closes", async () => {
  const composer = document.createElement("textarea");
  composer.id = "agent-message";
  document.body.append(composer);
  const props = {
    onOpenChange: vi.fn(),
    chats: [],
    selected: "",
    onSelect: vi.fn(),
  };
  try {
    await act(async () =>
      root.render(createElement(AgentHistory, { ...props, open: true })),
    );
    await act(async () =>
      root.render(createElement(AgentHistory, { ...props, open: false })),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(composer);
  } finally {
    composer.remove();
  }
});
