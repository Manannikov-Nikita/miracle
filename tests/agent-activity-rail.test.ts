// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import AgentActivityRail from "../src/client/agents/AgentActivityRail";
import { useAgentSqlActivity } from "../src/client/agents/useAgentSqlActivity";
import { agentSubagents } from "../src/client/agents/agent-subagents";
import {
  ProjectSync,
  ProjectSyncContext,
} from "../src/client/agents/ProjectSync";
import type { AgentChatState } from "../src/client/agents/useAgentChat";
import type { AgentMessage } from "../src/shared/agents";

let root: Root;
let host: HTMLDivElement;
const run = (id: string, status = "running", extra = {}) => ({
  id,
  chatId: "chat-a",
  turnId: "turn-a",
  status,
  sql: `SELECT '${id}'`,
  startedAt: "2026-11-07T00:00:00Z",
  ...extra,
});
const response = (runs: ReturnType<typeof run>[]) =>
  new Response(
    JSON.stringify({
      runs,
      activeCount: runs.filter((r) =>
        ["running", "cancelling"].includes(r.status),
      ).length,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
const state = (extra: Partial<AgentChatState> = {}) =>
  ({
    selected: "chat-a",
    open: true,
    active: null,
    conversation: null,
    ...extra,
  }) as AgentChatState;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows real date completion, keeps paused work separate, and opens details with keyboard dismissal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response([
        run("ordinary"),
        run("batch", "running", {
          dateBatch: {
            total: 10,
            completed: 3,
            succeeded: 2,
            failed: 1,
            currentDate: "2026-11-04",
            attempt: 2,
            maxAttempts: 3,
            currentStatus: "running",
          },
        }),
        run("paused", "paused", {
          dateBatch: {
            total: 4,
            completed: 1,
            succeeded: 1,
            failed: 0,
            attempt: 1,
            maxAttempts: 3,
          },
        }),
      ]),
    ),
  );
  await act(async () =>
    root.render(createElement(AgentActivityRail, { state: state() })),
  );
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="SQL: 2 активных, 1 на паузе"]',
  )!;
  expect(trigger).not.toBeNull();
  const progress = host.querySelector(
    '[role="progressbar"][aria-valuemax="10"]',
  );
  expect(progress?.getAttribute("aria-valuenow")).toBe("3");
  expect(
    host.querySelectorAll(".agent-run-ring.is-indeterminate"),
  ).toHaveLength(1);
  expect(
    host.querySelectorAll(".agent-rail-rings .agent-rail-run"),
  ).toHaveLength(2);
  expect(host.querySelector(".agent-rail-rings .is-paused")).toBeNull();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => trigger.click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
    "SELECT 'batch'",
  );
  expect(
    host
      .querySelector('[role="dialog"] .is-paused')
      ?.getAttribute("aria-valuenow"),
  ).toBe("1");
  expect(host.textContent).toContain("2026-11-04");
  expect(host.textContent).toContain("Попытка 2 из 3");
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Закрыть подробности активности",
  );
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("opens the chosen SQL run and closes details only after the editor accepts it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response([run("first"), run("chosen")])),
  );
  let finish!: () => void;
  const onOpenRun = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(
      createElement(AgentActivityRail, { state: state(), onOpenRun }),
    ),
  );
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        'button[aria-label="SQL: 2 активных, 0 на паузе"]',
      )!
      .click(),
  );
  const articles = host.querySelectorAll(".agent-rail-item");
  expect(articles[1].querySelector("code")?.textContent).toBe(
    "SELECT 'chosen'",
  );
  await act(async () =>
    articles[1]
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Открыть в редакторе"]',
      )!
      .click(),
  );
  expect(onOpenRun).toHaveBeenCalledExactlyOnceWith("chosen");
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => finish());
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it("preserves active SQL after a poll fails and reports stale data instead of zero", async () => {
  vi.useFakeTimers();
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (fail) throw new Error("offline");
      return response([run("running")]);
    }),
  );
  await act(async () =>
    root.render(createElement(AgentActivityRail, { state: state() })),
  );
  fail = true;
  await act(async () => vi.advanceTimersByTimeAsync(1600));
  expect(
    host.querySelector('button[aria-label="SQL: 1 активных, 0 на паузе"]'),
  ).not.toBeNull();
  expect(
    host.querySelector('[role="status"][aria-label="Нет связи"]'),
  ).not.toBeNull();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>('button[aria-label^="SQL:"]')!
      .click(),
  );
  expect(host.textContent).toContain("Последние известные данные");
  expect(host.textContent).toContain("SELECT 'running'");
});

it("does not claim zero activity when the server response is unavailable or malformed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "bad payload" }), { status: 200 }),
    ),
  );
  await act(async () =>
    root.render(createElement(AgentActivityRail, { state: state() })),
  );
  expect(
    host.querySelector('button[aria-label="SQL: данные недоступны"]'),
  ).not.toBeNull();
  expect(
    host.querySelector('[role="status"][aria-label="Нет связи"]'),
  ).not.toBeNull();
  expect(host.textContent).not.toContain("Нет активных");
});

it("shows an empty state and only latest-turn child statuses without completing running children with their parent", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response([])),
  );
  const turn = {
    id: "last",
    chatId: "chat-a",
    status: "completed" as const,
    context: {},
    createdAt: "2026-11-07T00:00:00Z",
  };
  const message = (
    turnId: string,
    id: string,
    status: string,
  ): AgentMessage => ({
    id: crypto.randomUUID(),
    chatId: "chat-a",
    turnId,
    role: "action",
    content: "",
    createdAt: "2026-11-07T00:00:00Z",
    details: { subagent: { id, name: id, status } } as AgentMessage["details"],
  });
  await act(async () =>
    root.render(
      createElement(AgentActivityRail, {
        state: state({
          conversation: {
            chat: {
              id: "chat-a",
              title: "Chat",
              profileId: "profile",
              provider: "codex",
              createdAt: "",
              updatedAt: "",
            },
            turns: [{ ...turn, id: "old" }, turn],
            messages: [
              message("old", "hidden-old-child", "running"),
              message("last", "running-child", "running"),
              message("last", "done-child", "completed"),
            ],
          },
        }),
      }),
    ),
  );
  expect(
    host.querySelector('button[aria-label="SQL: 0 активных, 0 на паузе"]'),
  ).not.toBeNull();
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Саб-агенты: текущий статус неизвестен, 2 в последней задаче"]',
  )!;
  expect(trigger).not.toBeNull();
  expect(trigger.textContent).toContain("—");
  expect(host.textContent).not.toContain("Нет активных");
  await act(async () => trigger.click());
  expect(host.textContent).toContain("running-child");
  expect(host.textContent).toContain("Работает");
  expect(host.textContent).toContain("Завершён");
  expect(host.textContent).not.toContain("hidden-old-child");
  const runningChild = [...host.querySelectorAll(".agent-rail-item")].find(
    (item) => item.textContent?.includes("running-child"),
  )!;
  expect(runningChild.textContent).not.toContain("Завершён");
  expect(runningChild.textContent).not.toContain("Отменён");
});

it("shows the board owner color beside managed workers in activity", async () => {
  vi.stubGlobal("fetch", async () => response([]));
  const turn = {
    id: "turn-a",
    chatId: "chat-a",
    status: "running" as const,
    context: {},
    createdAt: "now",
  };
  const workers = [
    { id: "worker-a", name: "Раскладка", color: 0 },
    { id: "worker-b", name: "Проверка", color: 1 },
  ];
  const messages: AgentMessage[] = workers.map((worker) => ({
    id: worker.id,
    chatId: turn.chatId,
    turnId: turn.id,
    role: "action",
    content: worker.name,
    createdAt: "now",
    details: {
      subagent: { id: worker.id, name: worker.name, status: "running" },
      worker,
    },
  }));
  await act(async () =>
    root.render(
      createElement(AgentActivityRail, {
        state: state({
          active: turn,
          conversation: {
            chat: {
              id: turn.chatId,
              title: "Chat",
              provider: "codex",
              profileId: "profile",
              createdAt: "",
              updatedAt: "",
            },
            turns: [turn],
            messages,
          },
        }),
      }),
    ),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".agent-rail-agents")!.click(),
  );
  const names = [
    ...host.querySelectorAll<HTMLElement>(".agent-rail-child-name"),
  ];
  expect(names.map((item) => item.textContent)).toEqual([
    "Раскладка",
    "Проверка",
  ]);
  const fills = names.map((item) =>
    item.querySelector("svg")?.getAttribute("fill"),
  );
  expect(fills.every(Boolean)).toBe(true);
  expect(new Set(fills).size).toBe(2);
});

it("does not report no subagents before the selected conversation has loaded", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response([])),
  );
  await act(async () =>
    root.render(createElement(AgentActivityRail, { state: state() })),
  );
  const trigger = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Саб-агенты: данные загружаются"]',
  )!;
  expect(trigger).not.toBeNull();
  expect(trigger.textContent).toContain("—");
  expect(host.textContent).not.toContain("Нет активных");
  await act(async () => trigger.click());
  expect(host.textContent).not.toContain("В этой задаче нет сведений");
});

it("ignores a delayed response from the previous chat and hydrates after reconnect", async () => {
  let finishA!: (response: Response) => void;
  let runsB = [run("b", "paused", { chatId: "chat-b" })];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("chat-a")
        ? new Promise<Response>((resolve) => {
            finishA = resolve;
          })
        : response(runsB),
    ),
  );
  const project = new ProjectSync(async () => ({ revision: 0, locks: [] }));
  const render = async (selected: string) =>
    act(async () =>
      root.render(
        createElement(
          ProjectSyncContext.Provider,
          { value: project },
          createElement(AgentActivityRail, { state: state({ selected }) }),
        ),
      ),
    );
  await render("chat-a");
  await render("chat-b");
  await act(async () => finishA(response([run("a")])));
  expect(
    host.querySelector('button[aria-label="SQL: 0 активных, 1 на паузе"]'),
  ).not.toBeNull();
  runsB = [];
  await act(async () => project.rehydrate());
  expect(
    host.querySelector('button[aria-label="SQL: 0 активных, 0 на паузе"]'),
  ).not.toBeNull();
});

it("polls owned work after the turn ends, stops once terminal, and never polls while closed", async () => {
  vi.useFakeTimers();
  let serverRuns = [run("owned")];
  const fetch = vi.fn(async () => response(serverRuns));
  vi.stubGlobal("fetch", fetch);
  let snapshot: ReturnType<typeof useAgentSqlActivity>;
  function Probe({ open }: { open: boolean }) {
    snapshot = useAgentSqlActivity({
      chatId: "chat-a",
      open,
      turnId: null,
      turnActive: false,
    });
    return null;
  }
  await act(async () => root.render(createElement(Probe, { open: true })));
  serverRuns = [run("owned", "completed")];
  await act(async () => vi.advanceTimersByTimeAsync(1600));
  expect(snapshot!.data?.runs[0].status).toBe("completed");
  const calls = fetch.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(fetch).toHaveBeenCalledTimes(calls);
  await act(async () => root.render(createElement(Probe, { open: false })));
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(fetch).toHaveBeenCalledTimes(calls);
});

it("keeps paused batches in details while showing rings only during execution, including an external resume", async () => {
  vi.useFakeTimers();
  let serverRuns = [run("paused", "paused")];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response(serverRuns)),
  );
  await act(async () =>
    root.render(createElement(AgentActivityRail, { state: state() })),
  );
  expect(
    host.querySelector('button[aria-label="SQL: 0 активных, 1 на паузе"]'),
  ).not.toBeNull();
  expect(
    host.querySelectorAll(".agent-rail-rings .agent-rail-run"),
  ).toHaveLength(0);
  serverRuns = [run("paused", "running")];
  await act(async () => vi.advanceTimersByTimeAsync(1600));
  expect(
    host.querySelector('button[aria-label="SQL: 1 активных, 0 на паузе"]'),
  ).not.toBeNull();
  expect(
    host.querySelectorAll(".agent-rail-rings .agent-rail-run"),
  ).toHaveLength(1);
  serverRuns = [run("paused", "completed")];
  await act(async () => vi.advanceTimersByTimeAsync(1600));
  expect(
    host.querySelectorAll(".agent-rail-rings .agent-rail-run"),
  ).toHaveLength(0);
});

it("does not poll an idle selected chat just because another chat has an active turn", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => response([]));
  vi.stubGlobal("fetch", fetch);
  await act(async () =>
    root.render(
      createElement(AgentActivityRail, {
        state: state({
          active: {
            id: "other-turn",
            chatId: "other-chat",
            status: "running",
            context: {},
            createdAt: "2026-11-07T00:00:00Z",
          },
        }),
      }),
    ),
  );
  const calls = fetch.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(fetch).toHaveBeenCalledTimes(calls);
  expect(
    host.querySelector('button[aria-label="SQL: 0 активных, 0 на паузе"]'),
  ).not.toBeNull();
});

it("uses only the latest subagent snapshot for the selected turn and preserves actual child status", () => {
  const message = (turnId: string, subagent: unknown): AgentMessage => ({
    id: crypto.randomUUID(),
    chatId: "chat-a",
    turnId,
    role: "action",
    content: "",
    createdAt: "2026-11-07T00:00:00Z",
    details: { subagent },
  });
  const messages = [
    message("old", { id: "old", status: "running" }),
    message("current", {
      id: "first",
      name: "Research",
      task: "Inspect schema",
      status: "running",
    }),
    message("current", { id: "second", status: "waiting" }),
    message("current", { id: "first", status: "completed" }),
    message("current", { status: "running" }),
  ];
  expect(agentSubagents(messages, "current")).toEqual([
    {
      id: "first",
      name: "Research",
      task: "Inspect schema",
      status: "completed",
    },
    { id: "second", status: "waiting" },
  ]);
});

it("tracks current Codex subAgentActivity lifecycle independently of item completion", () => {
  const message = (
    id: string,
    kind: string,
    phase = "completed",
  ): AgentMessage => ({
    id: crypto.randomUUID(),
    chatId: "chat-a",
    turnId: "current",
    role: "action",
    content: "subAgentActivity",
    createdAt: "2026-11-07T00:00:00Z",
    details: {
      type: "subAgentActivity",
      id: crypto.randomUUID(),
      kind,
      phase,
      agentThreadId: id,
      agentPath: `/root/${id}`,
      completedAtMs: 1794037448105,
    },
  });
  const messages = [
    message("september", "started"),
    message("october", "started"),
  ];
  expect(
    agentSubagents(messages, "current").map((c) => [c.id, c.name, c.status]),
  ).toEqual([
    ["september", "september", "running"],
    ["october", "october", "running"],
  ]);
  messages.push(message("september", "interacted"));
  expect(agentSubagents(messages, "current")[0].status).toBe("running");
  messages.push(
    message("september", "completed", "started"),
    message("october", "interrupted", "started"),
  );
  expect(agentSubagents(messages, "current").map((c) => c.status)).toEqual([
    "completed",
    "cancelled",
  ]);
  messages.push(message("september", "interacted"));
  expect(agentSubagents(messages, "current")[0].status).toBe("completed");
  expect(
    agentSubagents([message("new-child", "interacted")], "current")[0].status,
  ).toBe("unknown");
});

it("preserves a known child failure when a later lifecycle completion has no outcome", () => {
  for (const status of ["failed", "cancelled", "closed"] as const) {
    const known: AgentMessage = {
      id: "known",
      chatId: "chat-a",
      turnId: "current",
      role: "action",
      content: "",
      createdAt: "",
      details: { subagent: { id: "child", status } },
    };
    const completion: AgentMessage = {
      ...known,
      id: "completion",
      details: {
        type: "subAgentActivity",
        agentThreadId: "child",
        kind: "completed",
      },
    };
    expect(agentSubagents([known, completion], "current")[0].status).toBe(
      status,
    );
    const restart: AgentMessage = {
      ...completion,
      id: "restart",
      details: { ...completion.details, kind: "started" },
    };
    expect(
      agentSubagents([known, restart, completion], "current")[0].status,
    ).toBe("completed");
  }
});
