// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useAgentChat,
  type AgentChatState,
} from "../src/client/agents/useAgentChat";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import type { AgentContextSnapshot } from "../src/shared/agent-context";
import type { AgentConversation } from "../src/shared/agents";

vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";

const usage = (usedTokens: number): AgentContextSnapshot => ({
  provider: "codex",
  usedTokens,
  contextWindow: 128000,
  measuredAt: "2026-11-11T20:00:00Z",
  estimates: { conversation: 500, project: 200, tools: 100, instructions: 100 },
});
const saved = (): AgentConversation => ({
  chat: {
    id: "chat",
    profileId: "profile",
    provider: "codex",
    title: "Context",
    createdAt: "now",
    updatedAt: "now",
  },
  messages: [
    {
      id: "user",
      chatId: "chat",
      turnId: "turn",
      role: "user",
      content: "Read my project",
      createdAt: "now",
      details: {
        context: { filePaths: ["report.sql"] },
        contextUsage: usage(1000),
      },
    },
  ],
  turns: [],
});
let host: HTMLDivElement,
  root: Root,
  state: AgentChatState,
  project: ProjectSync;
let delayed: ((value: AgentConversation) => void) | undefined;
let delayReads = false;
function Probe() {
  state = useAgentChat();
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  project = new ProjectSync();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  delayReads = false;
  delayed = undefined;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/project") return { projectRoot: "/fixture" } as never;
    if (path === "/api/agent-profiles") return [] as never;
    if (path === "/api/chats") return [saved().chat] as never;
    if (path === "/api/agent-state") return { activeTurn: null } as never;
    if (path === "/api/chats/chat")
      return (
        delayReads
          ? new Promise((resolve) => {
              delayed = resolve;
            })
          : saved()
      ) as never;
    throw new Error(path);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function mount() {
  await act(async () =>
    root.render(
      createElement(
        ProjectSyncContext.Provider,
        { value: project },
        createElement(Probe),
      ),
    ),
  );
}
async function update(
  contextUsage: AgentContextSnapshot | null,
  chatId = "chat",
) {
  await act(async () =>
    project.emit({
      id: 2,
      type: "agent.context.updated",
      data: { chatId, messageId: "user", contextUsage },
    }),
  );
}

it("updates context in place without unread notifications or changing user content", async () => {
  await mount();
  await update(usage(2400));
  expect(state.unread).toBe(false);
  expect(state.conversation?.messages).toHaveLength(1);
  expect(state.conversation?.messages[0]).toMatchObject({
    content: "Read my project",
    details: {
      context: { filePaths: ["report.sql"] },
      contextUsage: { usedTokens: 2400 },
    },
  });
});

it("retains a measurement received before the first conversation response", async () => {
  delayReads = true;
  await mount();
  expect(state.conversation).toBeNull();
  await update(usage(3000));
  await act(async () => delayed!(saved()));
  expect(
    state.conversation?.messages[0].details?.contextUsage?.usedTokens,
  ).toBe(3000);
});

it("keeps invalidation ahead of a stale fetch after reconnect", async () => {
  await mount();
  delayReads = true;
  await act(async () => project.rehydrate());
  await update(null);
  await act(async () => delayed!(saved()));
  expect(state.conversation?.messages[0].details?.contextUsage).toBeNull();
  expect(state.unread).toBe(false);
});

it("does not overwrite selected chat metadata with another chat's measurement", async () => {
  await mount();
  await update(usage(9000), "another");
  expect(
    state.conversation?.messages[0].details?.contextUsage?.usedTokens,
  ).toBe(1000);
  expect(state.unread).toBe(false);
});

it("preserves live context metadata when a full message update follows", async () => {
  await mount();
  await update(usage(4000));
  await act(async () =>
    project.emit({
      id: 3,
      type: "agent.event",
      data: {
        ...saved().messages[0],
        details: { context: { filePaths: ["report.sql"] }, additional: true },
      },
    }),
  );
  expect(state.conversation?.messages[0].details).toMatchObject({
    additional: true,
    contextUsage: { usedTokens: 4000 },
  });
});

it("accepts a newer fetched measurement after reconnect instead of pinning cached usage", async () => {
  await mount();
  await update(usage(4000));
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/chats/chat") {
      const value = saved();
      value.messages[0].details!.contextUsage = usage(700);
      return value as never;
    }
    return original(path, options);
  });
  await act(async () => project.rehydrate());
  expect(
    state.conversation?.messages[0].details?.contextUsage?.usedTokens,
  ).toBe(700);
});
