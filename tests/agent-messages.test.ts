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
    turns: AgentTurn[] = [turn(status)],
    resolvedApprovals = new Map<string, "allow" | "deny">(),
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
        turns,
      },
      active: ["running", "waiting"].includes(status) ? turn(status) : null,
      resolvedApprovals,
      busy: false,
      approve,
    } as unknown as AgentChatState;
    await act(async () => root.render(createElement(AgentMessages, { state })));
  };

  it("renders safe inline and display math while preserving Markdown code examples", async () => {
    await render(
      [
        message(
          "answer",
          "assistant",
          "Inline $x^2$\n\n$$y^2$$\n\n$$\n\\frac{1}{2}\n$$\n\n`$code$`\n\n```math\n$example$\n```\n\n$\\frac{$\n\n$\\href{javascript:alert(1)}{bad}$",
        ),
      ],
      "completed",
    );
    expect(host.querySelectorAll(".katex-display")).toHaveLength(2);
    expect(host.querySelectorAll(".katex")).toHaveLength(4);
    expect(host.querySelector(".katex-error")).not.toBeNull();
    expect(host.querySelector("a")).toBeNull();
    expect(
      [...host.querySelectorAll("code")].map((code) => code.textContent),
    ).toEqual(["$code$", "$example$\n"]);
  });

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

  it("renders saved images from chat attachment URLs without remote images or raw data URLs", async () => {
    const image = {
      id: "image-1",
      name: "График.png",
      mimeType: "image/png",
      size: 128,
      url: "/api/chats/chat/images/image-1",
    };
    await render(
      [
        message("user", "user", "Объясни этот график", {
          images: [
            image,
            { ...image, id: "remote", url: "https://example.com/image.png" },
            {
              ...image,
              id: "raw",
              url: "data:image/png;base64,secret-image-bytes",
            },
            {
              ...image,
              id: "traversal",
              url: "/api/chats/chat/images/..\\..\\index.html",
            },
            { ...image, id: "bad-size", size: -1 },
            null,
          ],
        }),
      ],
      "completed",
    );
    const user = host.querySelector("article.user")!;
    const images = user.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]!.getAttribute("src")).toBe(
      "/api/chats/chat/images/image-1",
    );
    expect(images[0]!.getAttribute("alt")).toBe("График.png");
    expect(images[0]!.getAttribute("loading")).toBe("lazy");
    const link = images[0]!.closest("a")!;
    expect(link.getAttribute("href")).toBe("/api/chats/chat/images/image-1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(user.innerHTML).not.toContain("secret-image-bytes");
  });

  it("keeps activity visible before an answer and below the same answer element as it streams and tool events arrive", async () => {
    const conversation = [
      message("user", "user", "Count trips"),
      message("answer", "assistant", "Checking the data"),
    ];
    await render(conversation.slice(0, 1));
    const activity = host.querySelector(".agent-activity-summary")!;
    expect(activity).not.toBeNull();
    expect(activity.textContent).toContain("Думает");
    expect(host.querySelector("article.assistant")).toBeNull();
    await render(conversation);
    const answer = host.querySelector("article.assistant")!;
    expect(host.querySelector(".agent-activity-summary")).toBe(activity);
    expect(answer.nextElementSibling).toBe(activity);
    const position = Array.from(answer.parentElement!.children).indexOf(answer);
    const actions = Array.from({ length: 200 }, (_, i) =>
      message(`event-${i}`, "action", "read_result", {
        id: `call-${i}`,
        phase: "started",
      }),
    );
    await render([
      conversation[0]!,
      { ...conversation[1]!, content: "Checking the data: 200 results" },
      ...actions,
    ]);
    expect(host.querySelectorAll(".agent-activity-summary")).toHaveLength(1);
    expect(host.querySelector(".agent-activity-summary")).toBe(activity);
    expect(host.querySelector("article.assistant")).toBe(answer);
    expect(answer.textContent).toContain("Checking the data: 200 results");
    expect(answer.nextElementSibling).toBe(activity);
    expect(activity.textContent).toContain("Работает");
    expect(Array.from(answer.parentElement!.children).indexOf(answer)).toBe(
      position,
    );
    expect(host.querySelectorAll("article.action")).toHaveLength(0);
    expect(host.textContent).not.toContain("read_result");
  });

  it("places each completed turn's activity below its own replies", async () => {
    const previousTurn = { ...turn("completed"), id: "previous" };
    const previousMessages = [
      message("previous-user", "user", "Read the board"),
      message("previous-tool", "action", "read_board", {
        id: "previous-call",
        result: "earlier receipt",
      }),
      message("previous-answer", "assistant", "The board is ready"),
      message("previous-summary", "assistant", "There are three charts"),
    ].map((item) => ({ ...item, turnId: previousTurn.id }));
    await render(
      [
        ...previousMessages,
        message("user", "user", "Read the schema"),
        message("tool", "action", "read_schema", {
          id: "current-call",
          result: "latest receipt",
        }),
        message("answer", "assistant", "The schema is ready"),
      ],
      "completed",
      [previousTurn, turn("completed")],
    );
    const sections = host.querySelectorAll(".agent-turn");
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      const replies = section.querySelectorAll("article.assistant");
      expect(replies[replies.length - 1]!.nextElementSibling).toBe(
        section.querySelector(".agent-activity-summary"),
      );
    }
    const previous = host.querySelector('[data-turn-id="previous"]')!;
    await act(async () =>
      previous.querySelector<HTMLButtonElement>("button")!.click(),
    );
    const timeline = previous.querySelector(".agent-activity-timeline")!;
    expect(timeline).not.toBeNull();
    await act(async () =>
      timeline
        .querySelector<HTMLButtonElement>(".agent-activity-details-trigger")!
        .click(),
    );
    expect(timeline.textContent).toContain("earlier receipt");
    expect(timeline.textContent).not.toContain("latest receipt");
  });

  it("shows inline activity and combines phases only for the same native call", async () => {
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
      ".agent-activity-trigger",
    )!;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const timeline = host.querySelector(".agent-activity-timeline")!;
    expect(timeline.closest(".agent-turn")).not.toBeNull();
    expect(timeline.querySelectorAll(".agent-activity-step")).toHaveLength(2);
    expect(timeline.querySelector(".agent-activity-raw")).toBeNull();
    await act(async () =>
      timeline
        .querySelector<HTMLButtonElement>(".agent-activity-details-trigger")!
        .click(),
    );
    expect(
      timeline.querySelector(".agent-activity-raw")?.textContent,
    ).toContain("first result");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".agent-activity-timeline")).toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
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
    expect(allow.closest(".agent-message.approval")!.nextElementSibling).toBe(
      host.querySelector(".agent-activity-summary"),
    );
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
    expect(host.textContent).toContain("Разрешения · 1");
    expect(host.querySelector("article.approval")).toBeNull();
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === "Разрешить",
      ),
    ).toBe(false);
  });

  it("keeps a new permission request collapsed below the answer while its decisions remain available", async () => {
    const permission = message("approval", "approval", "Run a local command?", {
      approvalId: "approve-1",
      command: "npm run build",
    });
    await render(
      [permission, message("answer", "assistant", "I can check the build.")],
      "waiting",
    );
    const answer = host.querySelector("article.assistant")!;
    const approval = host.querySelector("article.approval")!;
    expect(answer.nextElementSibling).toBe(approval);
    const disclosure = approval.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    )!;
    expect(disclosure).not.toBeNull();
    expect(approval.querySelector(".agent-markdown")).toBeNull();
    const allow = [...approval.querySelectorAll("button")].find(
      (button) => button.textContent === "Разрешить",
    )!;
    const deny = [...approval.querySelectorAll("button")].find(
      (button) => button.textContent === "Отклонить",
    )!;
    expect(allow).toBeDefined();
    expect(deny).toBeDefined();
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const details = document.getElementById(
      disclosure.getAttribute("aria-controls")!,
    )!;
    expect(details.textContent).toContain("Run a local command?");
    expect(details.textContent).toContain("npm run build");
    await act(async () => disclosure.click());
    expect(approval.querySelector(".agent-markdown")).toBeNull();
    await act(async () => deny.click());
    expect(approve).toHaveBeenCalledWith("approve-1", "deny");
  });

  it("identifies automatic approvals and keeps historical requests collapsed and non-actionable", async () => {
    await render(
      [
        message("automatic", "approval", "Write the query", {
          approvalId: "auto-1",
          decision: "allow",
          resolved: true,
          automatic: true,
        }),
        message("denied", "approval", "Delete the file", {
          approvalId: "deny-1",
          decision: "deny",
          resolved: true,
        }),
        message("closed", "approval", "Old request", {
          approvalId: "old-1",
        }),
        message("answer", "assistant", "The query is ready."),
      ],
      "completed",
    );
    const summary = host.querySelector<HTMLButtonElement>(
      ".agent-approvals-summary",
    )!;
    expect(summary.textContent).toContain("Разрешения · 3");
    expect(summary.textContent).toContain("Отклонено: 1");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelectorAll("article.approval")).toHaveLength(0);
    await act(async () => summary.click());
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    const approvals = host.querySelectorAll("article.approval");
    expect(approvals[0]!.textContent).toContain("Разрешено автоматически");
    expect(approvals[1]!.textContent).toContain("Отклонено");
    expect(approvals[2]!.textContent).toContain("Запрос закрыт");
    for (const approval of approvals) {
      expect(approval.querySelectorAll("button")).toHaveLength(1);
      expect(
        approval.querySelector("button")!.getAttribute("aria-expanded"),
      ).toBe("false");
      expect(approval.querySelector(".agent-markdown")).toBeNull();
    }
  });

  it("compresses resolved permissions per turn while keeping a new request immediately actionable", async () => {
    const previous = { ...turn("completed"), id: "previous" };
    const receipts = Array.from({ length: 100 }, (_, index) =>
      message(`resolved-${index}`, "approval", `Run command ${index}`, {
        approvalId: `approval-${index}`,
        decision: "allow",
        resolved: true,
        automatic: true,
      }),
    );
    await render(
      [
        { ...receipts[0]!, id: "previous-approval", turnId: "previous" },
        ...receipts,
        message("pending", "approval", "Run the final command", {
          approvalId: "pending-approval",
        }),
      ],
      "waiting",
      [previous, turn("waiting")],
    );
    const summaries = host.querySelectorAll(".agent-approvals-summary");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]!.textContent).toContain("Разрешения · 1");
    expect(summaries[1]!.textContent).toContain("Разрешения · 100");
    expect(host.querySelectorAll("article.approval")).toHaveLength(1);
    expect(host.textContent).not.toContain("Run command");
    const allow = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Разрешить",
    )!;
    expect(allow).toBeDefined();
    expect(allow.closest("[hidden]")).toBeNull();
    await act(async () => allow.click());
    expect(approve).toHaveBeenCalledWith("pending-approval", "allow");
    await act(async () => (summaries[1] as HTMLButtonElement).click());
    expect(host.querySelectorAll("article.approval")).toHaveLength(101);
    expect(
      host.querySelector('[data-turn-id="previous"] article.approval'),
    ).toBeNull();
    await act(async () => (summaries[1] as HTMLButtonElement).click());
    expect(host.querySelectorAll("article.approval")).toHaveLength(1);
  });

  it("compacts a permission as soon as its live decision arrives", async () => {
    const messages = [
      message("pending", "approval", "Run the command", {
        approvalId: "permission",
      }),
    ];
    await render(messages, "waiting");
    expect(host.querySelector("article.pending")).not.toBeNull();
    await render(
      messages,
      "waiting",
      [turn("waiting")],
      new Map([["permission", "deny"]]),
    );
    expect(host.querySelector("article.pending")).toBeNull();
    expect(
      host.querySelector(".agent-approvals-summary")!.textContent,
    ).toContain("Отклонено: 1");
  });

  it("preserves independent server audit receipts and reports them as completed during a running turn", async () => {
    await render([
      message("audit-1", "action", "read_board", { tool: "read_board" }),
      message("audit-2", "action", "read_board", { tool: "read_board" }),
    ]);
    const items = host.querySelectorAll(".agent-activity-step");
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
      const trigger = host.querySelector<HTMLButtonElement>(
        ".agent-activity-trigger",
      )!;
      if (trigger.getAttribute("aria-expanded") === "false")
        await act(async () => trigger.click());
      const failedItem = host.querySelector(
        '.agent-activity-step[data-state="failed"]',
      );
      expect(
        failedItem?.querySelector(".agent-activity-step-state")?.textContent,
      ).toBe("Ошибка");
      await act(async () =>
        failedItem!
          .querySelector<HTMLButtonElement>(".agent-activity-details-trigger")!
          .click(),
      );
      expect(
        failedItem?.querySelector(".agent-activity-raw")?.textContent,
      ).toContain("Result was not ready");
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
