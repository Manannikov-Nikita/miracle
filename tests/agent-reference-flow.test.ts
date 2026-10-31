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
    if (path === "/api/chats") return [chat] as never;
    if (path === "/api/agent-state") return { activeTurn: null } as never;
    if (path.startsWith("/api/project/files?"))
      return { files: ["sql/monthly trips.sql"], truncated: false } as never;
    if (path === "/api/chats/chat/messages") {
      const body = JSON.parse(String(options?.body));
      sent.push(body);
      return {
        id: `turn-${sent.length}`,
        chatId: "chat",
        status: "running",
        context: body.context,
      } as never;
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
async function attachFile() {
  await type("Объясни @monthly");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  const option = host.querySelector<HTMLButtonElement>('[role="option"]');
  expect(option?.textContent).toContain("sql/monthly trips.sql");
  await act(async () => option!.click());
}

it("sends the displayed file and original chart even when selection changes during flush", async () => {
  await attachFile();
  expect(host.querySelector("textarea")!.value).toBe("Объясни ");
  hold = true;
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
  await act(async () => {
    context = {
      boardId: "board-b",
      boardNodes: [{ id: "chart-b", title: "Trips" }],
    };
    project.contextChanged();
    finish!();
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].context).toEqual({
    boardId: "board-a",
    boardNodes: [{ id: "chart-a", title: "Revenue" }],
    filePaths: ["sql/monthly trips.sql"],
  });
  expect(host.querySelector("article.user")?.textContent).toContain(
    "sql/monthly trips.sql",
  );
  expect(host.querySelector("article.user")?.textContent).toContain("Revenue");
  expect(host.querySelector("form")?.textContent).toContain("Trips");
  expect(host.querySelector("form")?.textContent).not.toContain(
    "sql/monthly trips.sql",
  );
});

it("honors removed context chips while preserving board selection", async () => {
  await attachFile();
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Убрать файл sql/monthly trips.sql"]',
      )!
      .click();
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Убрать из контекста Revenue"]',
      )!
      .click();
  });
  expect(context.boardNodes).toHaveLength(1);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
  expect(sent[0].context).toEqual({
    boardId: "board-a",
    boardNodes: [],
    filePaths: [],
  });
});

it("keeps referenced files with their draft when starting a different conversation", async () => {
  await attachFile();
  await act(async () =>
    host
      .querySelector('[aria-label="Действия чата"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
  );
  const newChat = [
    ...host.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ].find((item) => item.textContent === "Новый разговор");
  expect(newChat).toBeDefined();
  await act(async () => newChat!.click());
  expect(host.querySelector("textarea")!.value).toBe("");
  expect(host.querySelector("form")?.textContent).not.toContain(
    "sql/monthly trips.sql",
  );
});
