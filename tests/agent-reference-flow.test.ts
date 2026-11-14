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
    if (path.endsWith("/sql-activity"))
      return { runs: [], activeCount: 0 } as never;
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

it.each([false, true])(
  "does not attach an active editor after opening chat (switch tabs: %s)",
  async (switchTabs) => {
    const toggle = () =>
      host.querySelector<HTMLButtonElement>('[aria-controls="agent-panel"]')!;
    let activeEditor = "editor-first";
    await act(async () => toggle().click());
    await act(async () => {
      project.register("editor", {
        context: () => ({
          editorDocumentId: activeEditor,
          selection: "SELECT private_selection",
        }),
        editorTabs: () => [
          { id: "editor-first", name: "First.sql" },
          { id: "editor-second", name: "Second.sql" },
        ],
        flush: async () => {},
      });
    });
    await act(async () => toggle().click());
    if (switchTabs)
      await act(async () => {
        activeEditor = "editor-second";
        project.contextChanged();
      });
    expect(host.querySelector("form")?.textContent).not.toContain("First.sql");
    expect(host.querySelector("form")?.textContent).not.toContain("Second.sql");
    await type("Test");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
        .click(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].context).toEqual({
      boardId: "board-a",
      boardNodes: [{ id: "chart-a", title: "Revenue" }],
      filePaths: [],
    });
  },
);

it.each([undefined, "sql/attached.sql"])(
  "does not fall back to the active editor after removing an explicit editor (%s)",
  async (path) => {
    await act(async () => {
      project.register("editor", {
        context: () => ({
          editorDocumentId: "editor-active",
          selection: "SELECT unrelated_selection",
        }),
        editorTabs: () => [
          { id: "editor-attached", name: "Attached.sql", path },
        ],
        flush: async () => {},
      });
    });
    await type("Explain @Attached");
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[role="option"]')!.click(),
    );
    const label = path ? `Убрать файл ${path}` : "Убрать запрос Attached.sql";
    const remove = host.querySelector<HTMLButtonElement>(
      `[aria-label="${label}"]`,
    );
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    await act(async () => project.contextChanged());
    expect(host.querySelector("form")?.textContent).not.toContain(
      "Attached.sql",
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
        .click(),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].context).toEqual({
      boardId: "board-a",
      boardNodes: [{ id: "chart-a", title: "Revenue" }],
      filePaths: [],
    });
  },
);

it("uses a new request identity when the same instruction targets another slide", async () => {
  const original = vi.mocked(api).getMockImplementation()!;
  const attempts: { clientRequestId: string; context: AgentTargetContext }[] =
    [];
  vi.mocked(api).mockImplementation(async (path, options) => {
    if (path === "/api/chats/chat/messages") {
      attempts.push(JSON.parse(String(options?.body)));
      throw new Error("temporary failure");
    }
    return original(path, options);
  });
  await act(async () => {
    context = { boardId: "deck", slideId: "first", boardNodes: [] };
    project.contextChanged();
  });
  await type("Добавь заголовок");
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
  await act(async () => {
    context = { boardId: "deck", slideId: "second", boardNodes: [] };
    project.contextChanged();
  });
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
  expect(attempts).toHaveLength(2);
  expect(attempts.map((attempt) => attempt.context.slideId)).toEqual([
    "first",
    "second",
  ]);
  expect(attempts[1].clientRequestId).not.toBe(attempts[0].clientRequestId);
});

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

it("captures the shown connector before flush and renders its chip in message history", async () => {
  await act(async () => {
    Object.assign(context, {
      boardEdges: [{ id: "edge-a", label: "Причина → следствие" }],
    });
    project.contextChanged();
  });
  expect(host.querySelector("form")?.textContent).toContain(
    "Причина → следствие",
  );
  await type("Explain the connector");
  hold = true;
  const submit = host.querySelector<HTMLButtonElement>(
    '[aria-label="Отправить сообщение"]',
  )!;
  await act(async () => submit.click());
  await act(async () => {
    Object.assign(context, {
      boardEdges: [{ id: "edge-b", label: "Другая стрелка" }],
    });
    project.contextChanged();
    finish!();
  });
  expect(sent[0]?.context.boardEdges).toEqual([
    { id: "edge-a", label: "Причина → следствие" },
  ]);
  expect(host.querySelector("article.user")?.textContent).toContain(
    "Причина → следствие",
  );
  expect(host.querySelector("form")?.textContent).toContain("Другая стрелка");
});

it("pins the mentioned editor instead of the active tab and omits another tab's selection", async () => {
  let activeEditor = "editor-other";
  await act(async () => {
    project.register("editor", {
      context: () => ({
        editorDocumentId: activeEditor,
        selection: "unrelated selected SQL",
      }),
      editorTabs: () => [
        { id: "editor-target", name: "Выручка.sql" },
        { id: "editor-other", name: "Другой.sql" },
      ],
      flush: async () => {},
    });
  });
  await type("Поправь @Выручка");
  const target = host.querySelector<HTMLButtonElement>('[role="option"]')!;
  expect(target.textContent).toContain("Выручка.sql");
  await act(async () => target.click());
  hold = true;
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
  await act(async () => {
    activeEditor = "editor-third";
    project.contextChanged();
    finish!();
  });
  expect(sent[0].context.editorDocumentId).toBe("editor-target");
  expect(sent[0].context.selection).toBeUndefined();
  expect(
    host.querySelector('[aria-label="Убрать запрос Выручка.sql"]'),
  ).toBeNull();
});

it("pins a mentioned native SQL tab by path without leaking another editor target", async () => {
  await act(async () => {
    project.register("editor", {
      context: () => ({
        editorDocumentId: "editor-other",
        selection: "other SQL",
      }),
      editorTabs: () => [
        { id: "native-tab", name: "Native.sql", path: "sql/native.sql" },
      ],
      flush: async () => {},
    });
  });
  await type("Поправь @Native");
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[role="option"]')!.click(),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('[aria-label="Отправить сообщение"]')!
      .click(),
  );
  expect(sent[0].context.filePaths).toEqual(["sql/native.sql"]);
  expect(sent[0].context.editorDocumentId).toBeUndefined();
  expect(sent[0].context.selection).toBeUndefined();
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
