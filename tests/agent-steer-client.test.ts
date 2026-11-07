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
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";
let root: Root,
  host: HTMLDivElement,
  state: AgentChatState,
  project: ProjectSync;
const turn = {
  id: "turn",
  chatId: "chat",
  status: "running",
  context: {},
  createdAt: "now",
};
function Harness() {
  state = useAgentChat();
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  project = new ProjectSync();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/project") return { projectRoot: "/work" } as never;
    if (path === "/api/agent-profiles") return [] as never;
    if (path === "/api/chats")
      return [{ id: "chat", profileId: "profile", provider: "codex" }] as never;
    if (path === "/api/agent-state") return { activeTurn: turn } as never;
    if (path === "/api/chats/chat")
      return {
        chat: { id: "chat", provider: "codex" },
        messages: [],
        turns: [],
      } as never;
    if (path === "/api/agent-turns/turn/steer") return turn as never;
    throw new Error("Unexpected request " + path);
  });
  await act(async () =>
    root.render(
      createElement(
        ProjectSyncContext.Provider,
        { value: project },
        createElement(Harness),
      ),
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("sends to the running turn without creating or cancelling a turn", async () => {
  await act(async () => state.send("Учти 2025", "profile", "request"));
  expect(api).toHaveBeenCalledWith(
    "/api/agent-turns/turn/steer",
    expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"content":"Учти 2025"'),
    }),
  );
  expect(
    vi
      .mocked(api)
      .mock.calls.some(
        ([path]) => path.endsWith("/messages") || path.endsWith("/cancel"),
      ),
  ).toBe(false);
});
it("retries the same steer after a lost response even after completion", async () => {
  const original = vi.mocked(api).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(api).mockImplementation((path, options) => {
    if (path === "/api/agent-turns/turn/steer")
      return (
        ++attempts === 1
          ? Promise.reject(new Error("connection lost"))
          : Promise.resolve({ ...turn, status: "completed" })
      ) as never;
    return original(path, options);
  });
  await act(async () => {
    await expect(state.send("Учти 2025", "profile", "request")).rejects.toThrow(
      "connection lost",
    );
  });
  await act(async () =>
    project.emit({
      id: 1,
      type: "turn.updated",
      data: { ...turn, status: "completed" },
    }),
  );
  await act(async () => state.send("Учти 2025", "profile", "request"));
  expect(attempts).toBe(2);
  expect(state.active).toBeNull();
  expect(
    vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/messages")),
  ).toBe(false);
});
it("does not turn a steer into a new task if the original finishes during context saving", async () => {
  let release!: () => void;
  project.register("editor", {
    context: () => ({ selection: "original SQL" }),
    flush: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  let sending!: Promise<void>;
  await act(async () => {
    sending = state.send("Уточнение", "profile", "request");
  });
  await act(async () =>
    project.emit({
      id: 1,
      type: "turn.updated",
      data: { ...turn, status: "completed" },
    }),
  );
  await act(async () => {
    release();
    await sending;
  });
  expect(api).toHaveBeenCalledWith(
    "/api/agent-turns/turn/steer",
    expect.objectContaining({ body: expect.stringContaining("original SQL") }),
  );
  expect(
    vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/messages")),
  ).toBe(false);
});
it("does not release the composer send lock when an independent permission answer finishes",async()=>{
 const original=vi.mocked(api).getMockImplementation()!;let accept!:(value:unknown)=>void;
 vi.mocked(api).mockImplementation((path,options)=>{
  if(path==="/api/agent-turns/turn/steer")return new Promise(resolve=>{accept=resolve;}) as never;
  if(path==="/api/agent-approvals/approval")return Promise.resolve({ok:true}) as never;
  return original(path,options);
 });
 let sending!:Promise<void>;
 await act(async()=>{sending=state.send("Уточнение","profile","request");});
 expect(state.busy).toBe(true);
 await act(async()=>state.approve("approval","allow"));
 expect(state.busy).toBe(true);
 await act(async()=>{accept(turn);await sending;});expect(state.busy).toBe(false);
});
