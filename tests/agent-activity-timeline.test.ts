// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentActivity from "../src/client/agents/AgentActivity";
import type { AgentMessage, AgentTurn } from "../src/shared/agents";
import { activityItems } from "../src/client/agents/agent-transcript";

vi.mock("../src/client/agents/agent-transcript", async (original) => ({
  ...(await original<typeof import("../src/client/agents/agent-transcript")>()),
  activityItems: vi.fn(),
}));

const event: AgentMessage = {
  id: "event",
  chatId: "chat",
  turnId: "turn",
  role: "action",
  content: "raw_tool_name",
  details: { result: "technical payload" },
  createdAt: "2026-11-11T12:00:00Z",
};
const step = (id = "one", state = "running") => ({
  id,
  label: "Чтение файла",
  events: [event],
  state,
  kind: "read",
  description: "Прочитан документ проекта",
  resources: [{ id: "file", label: "report.sql" }],
});
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(activityItems).mockReturnValue([step()] as ReturnType<
    typeof activityItems
  >);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const render = async (status: AgentTurn["status"] = "running", id = "turn") => {
  const turn: AgentTurn = {
    id,
    chatId: "chat",
    status,
    context: {},
    createdAt: event.createdAt,
  };
  await act(async () =>
    root.render(createElement(AgentActivity, { messages: [event], turn })),
  );
};
const trigger = () =>
  host.querySelector<HTMLButtonElement>(".agent-activity-trigger")!;

it("opens live steps inline and collapses when the turn finishes, allowing history to reopen", async () => {
  await render();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("ol")).not.toBeNull();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain("Чтение файла");
  expect(host.textContent).toContain("Прочитан документ проекта");
  await render("completed");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("ol")).toBeNull();
  await act(async () => trigger().click());
  expect(host.querySelector("ol")).not.toBeNull();
  await render("completed");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
});

it("preserves a manual collapse while work or waiting updates arrive and resets for another turn", async () => {
  await render();
  await act(async () => trigger().click());
  await render("waiting");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await render("running");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await render("running", "another");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
});

it("starts waiting turns expanded and saved completed turns collapsed", async () => {
  await render("waiting");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  await render("completed", "saved");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});

it("mounts raw event content only after opening one step's details", async () => {
  vi.mocked(activityItems).mockReturnValue(
    Array.from({ length: 200 }, (_, i) => step(`${i}`)) as ReturnType<
      typeof activityItems
    >,
  );
  await render();
  expect(host.querySelectorAll(".agent-activity-step")).toHaveLength(200);
  expect(host.querySelectorAll(".agent-activity-raw")).toHaveLength(0);
  expect(host.textContent).not.toContain("technical payload");
  const details = host.querySelector<HTMLButtonElement>(
    ".agent-activity-details-trigger",
  )!;
  expect(details.type).toBe("button");
  await act(async () => details.click());
  expect(details.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelectorAll(".agent-activity-raw")).toHaveLength(1);
  expect(host.querySelector(".agent-activity-raw")!.textContent).toContain(
    "technical payload",
  );
  await act(async () => details.click());
  expect(host.querySelectorAll(".agent-activity-raw")).toHaveLength(0);
});

it("only links explicit HTTP sources and preserves text-only source chips", async () => {
  vi.mocked(activityItems).mockReturnValue([
    {
      ...step(),
      resources: [
        { id: "web", label: "Документация", href: "https://example.com/docs" },
        { id: "file", label: "report.sql" },
        {
          id: "bad",
          label: "Небезопасный протокол",
          href: "javascript:alert(1)",
        },
        { id: "relative", label: "Локальный путь", href: "/report.sql" },
      ],
    },
  ] as ReturnType<typeof activityItems>);
  await render();
  const links = host.querySelectorAll("a");
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("href")).toBe("https://example.com/docs");
  expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
  expect(host.textContent).toContain("report.sql");
  expect(host.textContent).toContain("Небезопасный протокол");
});

it("explicitly labels failed, cancelled and unknown outcomes without claiming success", async () => {
  vi.mocked(activityItems).mockReturnValue([
    step("failed", "failed"),
    step("cancelled", "cancelled"),
    step("unknown", "unknown"),
  ] as ReturnType<typeof activityItems>);
  await render();
  expect(
    host.querySelector('[data-state="failed"] .agent-activity-step-state')!
      .textContent,
  ).toBe("Ошибка");
  expect(
    host.querySelector('[data-state="cancelled"] .agent-activity-step-state')!
      .textContent,
  ).toBe("Остановлено");
  expect(
    host.querySelector('[data-state="unknown"] .agent-activity-step-state')!
      .textContent,
  ).toBe("Результат неизвестен");
});

it("shows a non-counted ongoing status when completed actions are followed by more agent work", async () => {
  vi.mocked(activityItems).mockReturnValue([
    step("done", "completed"),
  ] as ReturnType<typeof activityItems>);
  await render();
  expect(trigger().textContent).toContain("1 действие");
  expect(host.querySelectorAll(".agent-activity-step")).toHaveLength(1);
  expect(host.querySelector(".agent-activity-current")!.textContent).toContain(
    "Агент работает",
  );
  await render("completed");
  await act(async () => trigger().click());
  expect(host.querySelector(".agent-activity-current")).toBeNull();
});
