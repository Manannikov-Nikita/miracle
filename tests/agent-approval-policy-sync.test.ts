// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useAgentChat } from "../src/client/agents/useAgentChat";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("stale PATCH must not replace a newer SSE refresh", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let server = {
    id: "chat",
    title: "chat",
    profileId: "profile",
    provider: "codex",
    autoApprove: true,
  };
  let release: (v: unknown) => void = () => {};
  let state: ReturnType<typeof useAgentChat>;
  const project = new ProjectSync();
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/chats") return [{ ...server }] as never;
    if (path === "/api/agent-profiles") return [] as never;
    if (path === "/api/agent-state") return { activeTurn: null } as never;
    if (path === "/api/project") return { projectRoot: "/work" } as never;
    if (path === "/api/chats/chat" && options?.method === "PATCH") {
      server = { ...server, autoApprove: false };
      return new Promise((resolve) => (release = resolve)) as never;
    }
    return { chat: { ...server }, messages: [], turns: [] } as never;
  });
  function Probe() {
    state = useAgentChat();
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        ProjectSyncContext.Provider,
        { value: project },
        createElement(Probe),
      ),
    ),
  );
  expect(state!.autoApprove).toBe(true);
  let patch: Promise<void>;
  await act(async () => {
    patch = state!.setAutoApprove(false);
  });
  // Another tab enables the policy after our request was accepted but before its response arrives.
  server = { ...server, autoApprove: true };
  await act(async () => {
    project.emit({
      id: 2,
      type: "chat.updated",
      entityId: "chat",
      data: { ...server },
    });
  });
  expect(state!.autoApprove).toBe(true);
  await act(async () => {
    release({ ...server, autoApprove: false });
    await patch;
  });
  expect(state!.autoApprove).toBe(server.autoApprove);
  await act(async () => root.unmount());
});
