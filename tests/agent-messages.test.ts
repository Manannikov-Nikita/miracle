// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentMessage, AgentTurn } from "../src/shared/agents";
import AgentMessages from "../src/client/agents/AgentMessages";
import type { AgentChatState } from "../src/client/agents/useAgentChat";

const message = (
  id: string,
  role: AgentMessage["role"],
  content: string,
  details?: Record<string, unknown>,
): AgentMessage => ({
  id,
  role,
  content,
  details,
  chatId: "chat",
  turnId: "turn",
  createdAt: "2026-10-31T12:00:00Z",
});
const turn = (status: AgentTurn["status"]): AgentTurn => ({
  id: "turn",
  chatId: "chat",
  status,
  context: {},
  createdAt: "2026-10-31T12:00:00Z",
});

describe("agent transcript", () => {
  let host: HTMLDivElement, root: Root;
  const approve = vi.fn(async () => {});
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    host.id = "agent-panel";
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  const render = async (
    messages: AgentMessage[],
    status: AgentTurn["status"] = "running",
  ) => {
    const state = {
      conversation: {
        chat: {
          id: "chat",
          title: "Analysis",
          provider: "codex",
          profileId: "profile",
        },
        messages,
        turns: [turn(status)],
      },
      active: ["running", "waiting"].includes(status) ? turn(status) : null,
      resolvedApprovals: new Map(),
      busy: false,
      approve,
    } as unknown as AgentChatState;
    await act(async () => root.render(createElement(AgentMessages, { state })));
  };

  it("keeps file and chart references visible in saved user messages without removal controls", async () => {
    await render(
      [
        message("user", "user", "Объясни этот график", {
          context: {
            filePaths: ["sql/поездки по месяцам.sql"],
            boardId: "board",
            boardNodes: [{ id: "chart", title: "Поездки по дням" }],
          },
        }),
      ],
      "completed",
    );
    const user = host.querySelector("article.user")!;
    expect(user.textContent).toContain("sql/поездки по месяцам.sql");
    expect(user.textContent).toContain("Поездки по дням");
    expect(user.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps one reserved activity row and the same answer element when hundreds of tool events arrive", async () => {
    const conversation = [
      message("user", "user", "Count trips"),
      message("answer", "assistant", "Checking the data"),
    ];
    await render(conversation);
    const answer = host.querySelector("article.assistant")!;
    const activity = host.querySelector(".agent-activity-summary")!;
    expect(activity).not.toBeNull();
    const position = Array.from(answer.parentElement!.children).indexOf(answer);
    const actions = Array.from({ length: 200 }, (_, i) =>
      message(`event-${i}`, "action", "read_result", {
        id: `call-${i}`,
        phase: "started",
      }),
    );
    await render([...conversation, ...actions]);
    expect(host.querySelectorAll(".agent-activity-summary")).toHaveLength(1);
    expect(host.querySelector(".agent-activity-summary")).toBe(activity);
    expect(host.querySelector("article.assistant")).toBe(answer);
    expect(Array.from(answer.parentElement!.children).indexOf(answer)).toBe(
      position,
    );
    expect(host.querySelectorAll("article.action")).toHaveLength(0);
    expect(host.textContent).not.toContain("read_result");
  });

  it("opens details outside the transcript and combines phases only for the same native call", async () => {
    await render([
      message("a-start", "action", "read_result", {
        id: "call-a",
        phase: "started",
        status: "inProgress",
      }),
      message("b-start", "action", "read_result", {
        id: "call-b",
        phase: "started",
        status: "inProgress",
      }),
      message("a-end", "action", "read_result", {
        id: "call-a",
        phase: "completed",
        status: "completed",
        result: "first result",
      }),
    ]);
    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="dialog"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.closest(".agent-turn")).toBeNull();
    expect(dialog.querySelectorAll(".agent-activity-item")).toHaveLength(2);
    expect(dialog.textContent).toContain("first result");
    const close = dialog.querySelector<HTMLButtonElement>(
      'button[aria-label="Закрыть действия"]',
    )!;
    await act(async () => close.click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps permission requests visible and actionable without opening the activity journal", async () => {
    const permission = message("approval", "approval", "Run a local command?", {
      approvalId: "approve-1",
    });
    await render(
      [message("tool", "action", "exec", { id: "exec-1" }), permission],
      "waiting",
    );
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    const allow = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Разрешить",
    )!;
    expect(allow).toBeDefined();
    expect(allow.closest(".agent-message.approval")).not.toBeNull();
    await act(async () => allow.click());
    expect(approve).toHaveBeenCalledWith("approve-1", "allow");
    await render(
      [
        {
          ...permission,
          details: {
            approvalId: "approve-1",
            resolved: true,
            decision: "allow",
          },
        },
      ],
      "running",
    );
    expect(host.textContent).toContain("Разрешено");
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === "Разрешить",
      ),
    ).toBe(false);
  });

  it("preserves independent server audit receipts and reports them as completed during a running turn", async () => {
    await render([
      message("audit-1", "action", "read_board", { tool: "read_board" }),
      message("audit-2", "action", "read_board", { tool: "read_board" }),
    ]);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
        .click(),
    );
    const items = host.querySelectorAll(".agent-activity-item");
    expect(items).toHaveLength(2);
    expect(
      [...items].map((item) => item.querySelector("small")?.textContent),
    ).toEqual(["Завершено", "Завершено"]);
  });

  it.each([
    ["completed", "Готово с замечаниями"],
    ["running", "Работает"],
  ] as const)(
    "keeps the %s turn status authoritative after a recovered tool failure",
    async (status, label) => {
      await render(
        [
          message("failed-tool", "action", "read_result", {
            id: "failed-call",
            status: "failed",
            error: "Result was not ready",
          }),
          message("recovered-tool", "action", "read_result", {
            id: "retry-call",
            status: "completed",
            result: "Ready",
          }),
        ],
        status,
      );
      expect(host.querySelector(".agent-activity-label")?.textContent).toBe(
        label,
      );
      expect(
        host.querySelector(".agent-activity-icon")?.getAttribute("data-state"),
      ).toBe(status);
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!
          .click(),
      );
      const failedItem = host.querySelector(
        '.agent-activity-item small[data-state="failed"]',
      );
      expect(failedItem?.textContent).toBe("Ошибка");
      expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
        "Result was not ready",
      );
    },
  );

  it("shows cancelled or failed turns as terminal even when the last tool event was in progress", async () => {
    const events = [
      message("tool", "action", "exec", {
        id: "exec-1",
        status: "inProgress",
        phase: "started",
      }),
      message("notice", "system", "Provider reported a failure"),
    ];
    await render(events, "cancelled");
    expect(
      host.querySelector(".agent-activity-summary")?.textContent,
    ).toContain("Остановлено");
    expect(host.querySelector('[data-state="running"]')).toBeNull();
    expect(host.querySelector("article.system")?.textContent).toContain(
      "Provider reported a failure",
    );
    await render(events, "failed");
    expect(
      host.querySelector(".agent-activity-summary")?.textContent,
    ).toContain("Ошибка");
    expect(host.querySelector('[data-state="running"]')).toBeNull();
  });
});
