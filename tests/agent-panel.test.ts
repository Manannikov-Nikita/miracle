// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import AgentAssistant from "../src/client/agents/AgentAssistant";
vi.mock("../src/client/api", () => ({ api: vi.fn(), json: JSON.stringify }));
import { api } from "../src/client/api";
describe("local agent panel", () => {
  let host: HTMLDivElement, root: Root;
  let project: ProjectSync;
  beforeEach(() => {
    project = new ProjectSync();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/project")
        return { projectRoot: "/work/project" } as never;
      if (path === "/api/agent-profiles")
        return [
          {
            id: "profile",
            name: "Local Codex",
            provider: "codex",
            command: "codex --model test",
            trusted: true,
          },
        ] as never;
      if (path === "/api/chats")
        return [
          {
            id: "chat",
            title: "Analysis",
            profileId: "profile",
            provider: "codex",
          },
        ] as never;
      if (path === "/api/agent-state")
        return {
          activeTurn: { id: "turn", chatId: "chat", status: "waiting" },
        } as never;
      if (path === "/api/chats/chat")
        return {
          chat: {
            id: "chat",
            title: "Analysis",
            profileId: "profile",
            provider: "codex",
          },
          messages: [
            {
              id: "approval",
              turnId: "turn",
              role: "approval",
              content: "Run command?",
              details: { approvalId: "approve" },
            },
          ],
          turns: [],
        } as never;
      return {} as never;
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it("shows waiting state, native approvals and closes without cancelling the running agent", async () => {
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(AgentAssistant),
        ),
      ),
    );
    const toggle = host.querySelector<HTMLButtonElement>(
      'button[aria-controls="agent-panel"]',
    )!;
    expect(toggle.getAttribute("aria-label")).toContain("Ожидает разрешения");
    await act(async () => toggle.click());
    expect(host.querySelector('[role="complementary"]')).not.toBeNull();
    const allow = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Разрешить",
    )!;
    await act(async () => allow.click());
    expect(api).toHaveBeenCalledWith(
      "/api/agent-approvals/approve",
      expect.objectContaining({ method: "POST", body: '{"decision":"allow"}' }),
    );
    const close = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Закрыть чат агента"]',
    )!;
    await act(async () => close.click());
    expect(host.querySelector('[role="complementary"]')).toBeNull();
    expect(
      vi.mocked(api).mock.calls.some(([path]) => path.includes("/cancel")),
    ).toBe(false);
  });
  it("upserts streamed assistant text by message id and exposes unread completion while closed", async () => {
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(AgentAssistant),
        ),
      ),
    );
    const toggle = host.querySelector<HTMLButtonElement>(
      'button[aria-controls="agent-panel"]',
    )!;
    await act(async () => toggle.click());
    const message = {
      id: "stream",
      chatId: "chat",
      turnId: "turn",
      role: "assistant",
      content: "First",
      createdAt: "now",
    };
    await act(async () => {
      project.emit({ id: 1, type: "agent.event", data: message });
      project.emit({
        id: 2,
        type: "agent.event",
        data: { ...message, content: "First and second" },
      });
    });
    expect(host.querySelectorAll("article.assistant")).toHaveLength(1);
    expect(host.querySelector("article.assistant")?.textContent).toContain(
      "First and second",
    );
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Закрыть чат агента"]',
        )!
        .click(),
    );
    await act(async () =>
      project.emit({
        id: 3,
        type: "agent.event",
        data: { ...message, content: "Done" },
      }),
    );
    expect(host.querySelector('[aria-label="Новое сообщение"]')).not.toBeNull();
  });
  it("retains focus context even when focus changes while pending editor and board writes finish", async () => {
    let target = "original",
      finish!: () => void;
    const flush = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    project.register("editor", {
      context: () => ({ editorDocumentId: target, selection: "selected SQL" }),
      flush,
    });
    project.register("board", {
      context: () => ({ boardId: "board" }),
      flush: async () => {},
    });
    const pending = project.prepare();
    target = "another";
    finish();
    await expect(pending).resolves.toEqual({
      editorDocumentId: "original",
      selection: "selected SQL",
      boardId: "board",
    });
  });
  it("shows connection failure with a concrete retry control", async () => {
    vi.mocked(api).mockRejectedValue(new Error("CLI service unavailable"));
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
        .querySelector<HTMLButtonElement>(
          'button[aria-controls="agent-panel"]',
        )!
        .click(),
    );
    expect(host.textContent).toContain("CLI service unavailable");
    expect(
      [...host.querySelectorAll("button")].some(
        (b) => b.textContent === "Повторить подключение",
      ),
    ).toBe(true);
  });
  it("does not resurrect a completed turn from a delayed active-state refresh", async () => {
    await act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(AgentAssistant),
        ),
      ),
    );
    const original = vi.mocked(api).getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementation((path, options) =>
      path === "/api/agent-state"
        ? (new Promise((r) => {
            resolve = r;
          }) as never)
        : original(path, options),
    );
    await act(async () =>
      project.emit({ id: 1, type: "chat.updated", data: { id: "chat" } }),
    );
    await act(async () =>
      project.emit({
        id: 2,
        type: "turn.updated",
        data: { id: "turn", chatId: "chat", status: "completed" },
      }),
    );
    await act(async () =>
      resolve({
        activeTurn: { id: "turn", chatId: "chat", status: "running" },
      }),
    );
    expect(
      host
        .querySelector('button[aria-controls="agent-panel"]')
        ?.getAttribute("aria-label"),
    ).not.toContain("Работает");
  });
  it("keeps only unresolved native prompts actionable when one turn requests another approval", async () => {
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
        .querySelector<HTMLButtonElement>(
          'button[aria-controls="agent-panel"]',
        )!
        .click(),
    );
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Разрешить")!
        .click(),
    );
    await act(async () =>
      project.emit({
        id: 1,
        type: "agent.event",
        data: {
          id: "second-approval",
          chatId: "chat",
          turnId: "turn",
          role: "approval",
          content: "Next permission",
          details: { approvalId: "second" },
        },
      }),
    );
    expect(
      [...host.querySelectorAll("button")].filter(
        (b) => b.textContent === "Разрешить",
      ),
    ).toHaveLength(1);
  });
  it.each(["close", "escape", "outside", "chat"])(
    "keeps a pending profile save mounted when dismissed through %s",
    async (dismissal) => {
      const original = vi.mocked(api).getMockImplementation()!;
      let rejectSave!: (error: Error) => void;
      vi.mocked(api).mockImplementation((path, options) =>
        path === "/api/agent-profiles/profile" && options?.method === "PATCH"
          ? (new Promise((_resolve, reject) => {
              rejectSave = reject;
            }) as never)
          : original(path, options),
      );
      await act(async () => root.render(createElement(AgentAssistant)));
      const toggle = host.querySelector<HTMLButtonElement>(
        'button[aria-controls="agent-panel"]',
      )!;
      await act(async () => toggle.click());
      const openSettings = async () => {
        await act(async () =>
          host
            .querySelector('button[aria-label="Выбрать профиль агента"]')!
            .dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
            ),
        );
        await act(async () =>
          [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
            .find((item) => item.textContent?.includes("Настроить агента"))!
            .click(),
        );
      };
      await openSettings();
      const dialog = host.querySelector<HTMLElement>(".agent-settings-dialog")!;
      expect(dialog).not.toBeNull();
      await act(async () =>
        [...dialog.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent === "Сохранить и проверить")!
          .click(),
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
      await act(async () => {
        if (dismissal === "close")
          dialog
            .querySelector<HTMLButtonElement>(
              'button[aria-label="Закрыть настройки"]',
            )!
            .click();
        else if (dismissal === "escape")
          dialog.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              bubbles: true,
              cancelable: true,
            }),
          );
        else if (dismissal === "outside")
          document.body.dispatchEvent(
            new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
          );
        else toggle.click();
      });
      expect(host.querySelector(".agent-settings-dialog")).toBe(dialog);
      expect(dialog.querySelector("input")!.matches(":disabled")).toBe(true);
      expect(
        vi
          .mocked(api)
          .mock.calls.filter(
            ([path, options]) =>
              path === "/api/agent-profiles/profile" &&
              options?.method === "PATCH",
          ),
      ).toHaveLength(1);
      await act(async () => rejectSave(new Error("Profile save failed")));
      expect(dialog.textContent).toContain("Profile save failed");
      expect(dialog.querySelector("input")!.matches(":disabled")).toBe(false);
      await act(async () =>
        dialog
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Закрыть настройки"]',
          )!
          .click(),
      );
      expect(host.querySelector(".agent-settings-dialog")).toBeNull();
      await openSettings();
      expect(
        host.querySelector<HTMLInputElement>(".agent-settings-dialog input")!
          .value,
      ).toBe("Local Codex");
      expect(
        vi
          .mocked(api)
          .mock.calls.filter(
            ([path, options]) =>
              path === "/api/agent-profiles/profile" &&
              options?.method === "PATCH",
          ),
      ).toHaveLength(1);
    },
  );
});
