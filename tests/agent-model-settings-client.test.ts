// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChat } from "../src/client/agents/useAgentChat";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import type {
  AgentChat,
  AgentModelSettings,
  AgentTurn,
} from "../src/shared/agents";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";

describe("per-chat agent model preferences", () => {
  let host: HTMLDivElement, root: Root, project: ProjectSync;
  let state: ReturnType<typeof useAgentChat>;
  let chats: AgentChat[];
  let active: AgentTurn | null;
  let patchRelease: ((chat: AgentChat) => void) | undefined;
  let delayPatch: boolean;
  const makeChat = (
    id = "chat",
    modelSettings?: AgentModelSettings,
  ): AgentChat => ({
    id,
    title: id,
    profileId: "profile",
    provider: "codex",
    autoApprove: false,
    createdAt: "now",
    updatedAt: "now",
    ...(modelSettings ? { modelSettings } : {}),
  });
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(api).mockReset();
    chats = [];
    active = null;
    delayPatch = false;
    patchRelease = undefined;
    project = new ProjectSync();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(api).mockImplementation(async (path, options = {}) => {
      if (path === "/api/agent-profiles")
        return [{ id: "profile", trusted: true }] as never;
      if (path === "/api/agent-state") return { activeTurn: active } as never;
      if (path === "/api/project") return { projectRoot: "/work" } as never;
      if (path === "/api/chats" && options.method === "POST") {
        const input = JSON.parse(options.body as string);
        const chat = {
          ...makeChat("created", input.modelSettings),
          profileId: input.profileId,
        };
        chats = [chat, ...chats];
        return structuredClone(chat) as never;
      }
      if (path === "/api/chats") return structuredClone(chats) as never;
      const id = path.match(/^\/api\/chats\/([^/]+)$/)?.[1];
      if (id && options.method === "PATCH") {
        const settings = JSON.parse(options.body as string).modelSettings;
        chats = chats.map((chat) =>
          chat.id === id ? { ...chat, modelSettings: settings } : chat,
        );
        const chat = structuredClone(chats.find((chat) => chat.id === id)!);
        return (
          delayPatch
            ? new Promise((resolve) => {
                patchRelease = resolve;
              })
            : chat
        ) as never;
      }
      if (id)
        return {
          chat: structuredClone(chats.find((chat) => chat.id === id)),
          messages: [],
          turns: [],
        } as never;
      if (path.endsWith("/messages"))
        return { id: "turn", chatId: "chat", status: "completed" } as never;
      throw new Error(`Unexpected request ${path}`);
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function open() {
    function Probe() {
      state = useAgentChat();
      return null;
    }
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
  const requests = (method: string, suffix: string) =>
    vi
      .mocked(api)
      .mock.calls.filter(
        ([path, options]) =>
          path.endsWith(suffix) && options?.method === method,
      );

  it("includes a new chat's draft settings, then resets them for a new conversation", async () => {
    await open();
    await act(async () => {
      state.setModelProfile("profile");
      await state.setModelSettings(
        { model: "model-a", reasoningEffort: "high" },
        "profile",
      );
    });
    expect(state.modelSettings).toEqual({
      model: "model-a",
      reasoningEffort: "high",
    });
    await act(async () => {
      await state.create("profile");
    });
    expect(
      JSON.parse(requests("POST", "/chats")[0][1]!.body as string),
    ).toMatchObject({
      modelSettings: { model: "model-a", reasoningEffort: "high" },
    });
    await act(async () => state.setSelected(""));
    expect(state.modelSettings).toBeUndefined();
    await act(async () => {
      await state.setModelSettings({ model: "model-a" }, "profile");
    });
    await act(async () => state.setModelProfile("other"));
    expect(state.modelSettings).toBeUndefined();
    await act(async () => {
      await state.create("other");
    });
    expect(
      JSON.parse(requests("POST", "/chats")[1][1]!.body as string),
    ).not.toHaveProperty("modelSettings");
  });

  it("sends an explicit empty reset and restores independent preferences on chat switches", async () => {
    chats = [
      makeChat("chat", { model: "model-a" }),
      makeChat("other", { model: "model-b" }),
    ];
    await open();
    expect(state.modelSettings).toEqual({ model: "model-a" });
    await act(async () => {
      await state.setModelSettings({}, "profile");
    });
    expect(
      JSON.parse(requests("PATCH", "/chat")[0][1]!.body as string),
    ).toEqual({ modelSettings: {} });
    expect(state.modelSettings).toEqual({});
    await act(async () => state.setSelected("other"));
    expect(state.modelSettings).toEqual({ model: "model-b" });
    await act(async () => state.setSelected("chat"));
    expect(state.modelSettings).toEqual({});
  });

  it("waits for the selected chat's settings write before sending a turn", async () => {
    chats = [makeChat("chat", { model: "old" })];
    delayPatch = true;
    await open();
    let patch!: Promise<void>, sending!: Promise<void>;
    await act(async () => {
      patch = state.setModelSettings({ model: "new" }, "profile");
    });
    expect(state.modelSettingsBusy).toBe(true);
    await act(async () => {
      sending = state.send("hello", "profile", "request");
    });
    expect(requests("POST", "/messages")).toHaveLength(0);
    await act(async () => {
      patchRelease!(structuredClone(chats[0]));
      await patch;
      await sending;
    });
    expect(requests("POST", "/messages")).toHaveLength(1);
    expect(state.modelSettings).toEqual({ model: "new" });
  });

  it("does not let a delayed PATCH response overwrite newer SSE preferences", async () => {
    chats = [makeChat("chat", { model: "old" })];
    delayPatch = true;
    await open();
    let patch!: Promise<void>;
    await act(async () => {
      patch = state.setModelSettings({ model: "requested" }, "profile");
    });
    const stale = structuredClone(chats[0]);
    chats[0] = {
      ...chats[0],
      modelSettings: { model: "newer", reasoningEffort: "low" },
    };
    await act(async () =>
      project.emit({
        id: 2,
        type: "chat.updated",
        entityId: "chat",
        data: chats[0],
      }),
    );
    expect(state.modelSettings).toEqual({
      model: "newer",
      reasoningEffort: "low",
    });
    await act(async () => {
      patchRelease!(stale);
      await patch;
    });
    expect(state.modelSettings).toEqual({
      model: "newer",
      reasoningEffort: "low",
    });
    expect(state.conversation!.chat.modelSettings).toEqual(state.modelSettings);
  });

  it("rejects changing settings for the currently running conversation", async () => {
    chats = [makeChat("chat", { model: "old" })];
    active = { id: "turn", chatId: "chat", status: "running" } as AgentTurn;
    await open();
    await act(async () => {
      await expect(
        state.setModelSettings({ model: "new" }, "profile"),
      ).rejects.toThrow("завершения");
    });
    expect(requests("PATCH", "/chat")).toHaveLength(0);
    expect(state.modelSettings).toEqual({ model: "old" });
  });

  it("keeps newer SSE preferences when an earlier conversation fetch finishes late", async () => {
    chats = [makeChat("chat", { model: "old" })];
    const stale = structuredClone(chats[0]);
    const implementation = vi.mocked(api).getMockImplementation()!;
    let release!: (value: unknown) => void;
    let delayed = false;
    vi.mocked(api).mockImplementation((path, options) => {
      if (path === "/api/chats/chat" && !options?.method && !delayed) {
        delayed = true;
        return new Promise((resolve) => {
          release = resolve;
        }) as never;
      }
      return implementation(path, options);
    });
    await open();
    expect(state.conversation).toBeNull();
    chats[0] = { ...chats[0], modelSettings: { model: "newer" } };
    await act(async () =>
      project.emit({
        id: 3,
        type: "chat.updated",
        entityId: "chat",
        data: chats[0],
      }),
    );
    await act(async () => release({ chat: stale, messages: [], turns: [] }));
    expect(state.modelSettings).toEqual({ model: "newer" });
    expect(state.conversation!.chat.modelSettings).toEqual({ model: "newer" });
  });
});
