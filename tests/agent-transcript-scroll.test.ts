// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentChatView from "../src/client/agents/AgentChatView";
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

it("follows growing activity only while the reader is at the bottom", async () => {
  const state = {
    selected: "chat",
    profiles: [],
    chats: [],
    conversation: {
      chat: { id: "chat", provider: "codex", profileId: "profile" },
      messages: [],
      turns: [],
    },
    active: {
      id: "turn",
      chatId: "chat",
      status: "running",
      context: {},
      createdAt: "now",
    },
    busy: false,
    resolvedApprovals: new Map(),
    setSelected: vi.fn(),
    stop: vi.fn(),
    approve: vi.fn(),
  } as unknown as AgentChatState;
  const render = async () => {
    await act(async () =>
      root.render(
        createElement(AgentChatView, {
          state,
          selectedProfile: "profile",
          onProfileChange: vi.fn(),
          draft: "",
          onDraftChange: vi.fn(),
          onSend: vi.fn(),
          onSettings: vi.fn(),
        }),
      ),
    );
  };
  await render();
  const log = host.querySelector<HTMLElement>('[role="log"]')!;
  Object.defineProperties(log, {
    scrollHeight: { value: 900 },
    clientHeight: { value: 400 },
  });
  state.conversation!.messages.push({
    id: "a",
    chatId: "chat",
    turnId: "turn",
    role: "action",
    content: "Read",
    createdAt: "now",
    details: { id: "call", phase: "started" },
  });
  await render();
  expect(log.scrollTop).toBe(900);
  log.scrollTop = 200;
  await act(async () => log.dispatchEvent(new Event("scroll")));
  state.conversation!.messages.push({
    id: "b",
    chatId: "chat",
    turnId: "turn",
    role: "action",
    content: "Read",
    createdAt: "now",
    details: { id: "call", phase: "completed" },
  });
  await render();
  expect(log.scrollTop).toBe(200);
  expect(host.querySelector(".agent-jump")).toBeNull();
});

it("does not move the reader or show a new-message prompt when an approval arrives, resolves, or expands", async () => {
  const value = {
    selected: "chat",
    profiles: [],
    chats: [],
    conversation: {
      chat: { id: "chat", provider: "codex", profileId: "profile" },
      messages: [],
      turns: [],
    },
    active: null,
    busy: false,
    resolvedApprovals: new Map(),
    setSelected: vi.fn(),
    stop: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
  } as unknown as AgentChatState;
  const render = async (state: AgentChatState) => {
    await act(async () =>
      root.render(
        createElement(AgentChatView, {
          state,
          selectedProfile: "profile",
          onProfileChange: vi.fn(),
          draft: "",
          onDraftChange: vi.fn(),
          onSend: vi.fn(async () => {}),
          onSettings: vi.fn(),
        }),
      ),
    );
  };
  await render(value);
  const log = host.querySelector<HTMLElement>('[role="log"]')!;
  Object.defineProperties(log, {
    scrollHeight: { value: 900 },
    clientHeight: { value: 400 },
  });
  log.scrollTop = 480;
  const waiting = {
    ...value,
    active: {
      id: "turn",
      chatId: "chat",
      status: "waiting" as const,
      context: {},
      createdAt: "now",
    },
    conversation: {
      ...value.conversation!,
      messages: [
        {
          id: "approval",
          chatId: "chat",
          turnId: "turn",
          role: "approval" as const,
          content: "Run the command?",
          details: { approvalId: "permission", command: "npm run build" },
          createdAt: "now",
        },
      ],
    },
  };
  await render(waiting);
  expect(log.scrollTop).toBe(480);
  expect(host.querySelector(".agent-jump")).toBeNull();

  log.scrollTop = 200;
  await act(async () => log.dispatchEvent(new Event("scroll")));
  await render({
    ...waiting,
    resolvedApprovals: new Map([["permission", "allow"]]),
    conversation: {
      ...waiting.conversation,
      messages: waiting.conversation.messages.map((message) => ({
        ...message,
        details: { ...message.details, resolved: true, decision: "allow" },
      })),
    },
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".agent-approvals-summary")!.click(),
  );
  expect(log.scrollTop).toBe(200);
  expect(host.querySelector(".agent-jump")).toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".agent-approval-trigger")!.click(),
  );
  expect(log.scrollTop).toBe(200);
  expect(host.querySelector(".agent-jump")).toBeNull();
});
