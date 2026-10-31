// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import AgentAssistant from "../src/client/agents/AgentAssistant";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import type { AgentTargetContext } from "../src/shared/agents";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";

let root: Root, host: HTMLDivElement, project: ProjectSync;
let context: AgentTargetContext, finish: (() => void) | undefined;
let hold: boolean;
let sent: {
  content: string;
  context: AgentTargetContext;
  clientRequestId: string;
}[];
const chat = {
  id: "chat",
  title: "Analysis",
  profileId: "profile",
  provider: "codex",
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  project = new ProjectSync();
  context = {
    boardId: "board-a",
    boardNodes: [{ id: "chart-a", title: "Revenue" }],
  };
  hold = false;
  finish = undefined;
  sent = [];
  project.register("board", {
    context: () => context,
    flush: () =>
      hold
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(),
  });
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/project")
      return { projectRoot: "/work/project" } as never;
    if (path === "/api/agent-profiles")
      return [
        {
          id: "profile",
          provider: "codex",
          name: "Local Codex",
          trusted: true,
        },
      ] as never;
    if (path === "/api/chats")
      return (options?.method === "POST" ? chat : []) as never;
    if (path === "/api/agent-state") return { activeTurn: null } as never;
    if (path.startsWith("/api/project/files?"))
      return { files: ["sql/monthly trips.sql"], truncated: false } as never;
    if (path === "/api/chats/chat/messages") {
      const body = JSON.parse(String(options?.body));
      sent.push(body);
      throw new Error("lost response");
    }
    if (path === "/api/chats/chat")
      return {
        chat,
        turns: [],
        messages: sent.map((value, i) => ({
          id: `message-${i}`,
          role: "user",
          content: value.content,
          chatId: "chat",
          details: { context: value.context },
        })),
      } as never;
    return {} as never;
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        ProjectSyncContext.Provider,
        { value: project },
        createElement(AgentAssistant),
      ),
    ),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-controls="agent-panel"]')!
      .click(),
  );
});
afterEach(async () => {
  finish?.();
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function type(value: string) {
  const field = host.querySelector("textarea")!;
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return field;
}

it("keeps dismissed target and idempotency token when a new-chat message is retried", async () => {
  await type("Explain");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Убрать из контекста Revenue"]',
      )!
      .click(),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
  expect(sent[0].context.boardNodes).toEqual([]);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
  expect(sent).toHaveLength(2);
  expect(sent[1].context.boardNodes).toEqual([]);
  expect(sent[1].clientRequestId).toBe(sent[0].clientRequestId);
});
