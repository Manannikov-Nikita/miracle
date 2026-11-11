import { describe, expect, it } from "vitest";
import type { AgentMessage, AgentTurn } from "../src/shared/agents";
import { activityItems } from "../src/client/agents/agent-transcript";

const event = (
  id: string,
  content: string,
  details: Record<string, unknown>,
): AgentMessage => ({
  id,
  chatId: "chat",
  turnId: "turn",
  role: "action",
  content,
  details,
  createdAt: "now",
});
const turn = (status: AgentTurn["status"]): AgentTurn => ({
  id: "turn",
  chatId: "chat",
  status,
  context: {},
  createdAt: "now",
});

describe("activity timeline model", () => {
  it("groups native lifecycle by launch and call, classifies structured reads and preserves filenames", () => {
    const details = {
      id: "call",
      activityScope: 1,
      type: "commandExecution",
      command: "cat data.sql",
      commandActions: [{ type: "read", path: "data.sql" }],
    };
    const items = activityItems(
      [
        event("1", "cat data.sql", { ...details, phase: "started" }),
        event("2", "cat data.sql", {
          ...details,
          phase: "completed",
          status: "completed",
          exitCode: 0,
        }),
        event("3", "cat data.sql", {
          ...details,
          activityScope: 2,
          phase: "started",
        }),
      ],
      turn("running"),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "read",
      state: "completed",
      resources: [{ label: "data.sql" }],
    });
    expect(items[1].state).toBe("running");
  });
  it("retains errors and does not infer success merely because the agent finished", () => {
    const items = activityItems(
      [
        event("1", "Bash", {
          id: "failed",
          input: { command: "npm test" },
          phase: "completed",
          status: "failed",
        }),
        event("2", "Read", {
          id: "unknown",
          input: { file_path: "README.md" },
          phase: "started",
        }),
        event("3", "run_query", { tool: "run_query" }),
      ],
      turn("completed"),
    );
    expect(items.map((i) => i.state)).toEqual([
      "failed",
      "unknown",
      "completed",
    ]);
    expect(items[2].label).toBe("Запуск запроса");
  });
  it("keeps repeated identical invocations separate and uses actual Miracle summaries", () => {
    const details = {
      source: "miracle",
      tool: "read_result",
      phase: "completed",
      status: "completed",
      summary: "Получено строк: 12",
      resources: [{ id: "result", label: "Результат запроса" }],
    };
    const items = activityItems([
      event("1", "read_result", { ...details, id: "a" }),
      event("2", "read_result", { ...details, id: "b" }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].description).toBe("Получено строк: 12");
  });
  it("uses authoritative Miracle execution instead of successful native transport duplicates while retaining transport failures", () => {
    const items = activityItems([
      event("1", "read_board", {
        id: "native",
        type: "mcpToolCall",
        server: "miracle",
        tool: "read_board",
        phase: "completed",
      }),
      event("2", "read_board", {
        id: "canonical",
        source: "miracle",
        tool: "read_board",
        phase: "completed",
        status: "completed",
      }),
      event("3", "read_board", {
        id: "network",
        type: "mcpToolCall",
        server: "miracle",
        tool: "read_board",
        status: "failed",
        error: { message: "Unavailable" },
      }),
    ]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.state)).toEqual(["completed", "failed"]);
  });
  it("groups subagent snapshots and public plan updates", () => {
    const items = activityItems(
      [
        event("1", "helper", {
          subagent: {
            id: "child",
            name: "Analyst",
            task: "Inspect data",
            status: "running",
          },
        }),
        event("2", "helper", {
          subagent: { id: "child", status: "completed" },
        }),
        event("3", "План работы", {
          id: "plan",
          type: "plan",
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Build", status: "in_progress" },
          ],
        }),
      ],
      turn("running"),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "subagent",
      state: "completed",
      description: "Inspect data",
    });
    expect(items[1]).toMatchObject({ kind: "plan", state: "running" });
    expect(items[1].description).toContain("Build");
  });
  it("retains a different pending native call even when an earlier Miracle call of the same name finished", () => {
    const items = activityItems(
      [
        event("a", "read_board", {
          id: "a",
          source: "miracle",
          tool: "read_board",
          phase: "completed",
          status: "completed",
        }),
        event("b", "read_board", {
          id: "b",
          type: "mcpToolCall",
          server: "miracle",
          tool: "read_board",
          phase: "started",
          status: "inProgress",
        }),
      ],
      turn("cancelled"),
    );
    expect(items.map((item) => item.state)).toEqual(["completed", "cancelled"]);
  });
  it("shows structured Codex web search sources", () => {
    const [item] = activityItems([
      event("web", "search", {
        id: "web",
        type: "webSearch",
        phase: "completed",
        results: [
          { url: "https://example.com/docs" },
          { url: "javascript:alert(1)" },
        ],
      }),
    ]);
    expect(item.resources).toEqual([
      {
        id: "https://example.com/docs",
        label: "example.com",
        href: "https://example.com/docs",
      },
    ]);
  });
  it("exposes only real safe web URLs and never makes paths into web links", () => {
    const items = activityItems([
      event("1", "WebFetch", {
        id: "a",
        input: { url: "https://example.com/docs" },
        phase: "completed",
      }),
      event("2", "WebFetch", {
        id: "b",
        input: { url: "javascript:alert(1)" },
        phase: "completed",
      }),
      event("3", "WebFetch", {
        id: "c",
        input: { url: "https://user:secret@example.com/" },
        phase: "completed",
      }),
      event("4", "Read", {
        id: "d",
        input: { file_path: "docs/readme.md" },
        phase: "completed",
      }),
    ]);
    expect(items[0].resources[0].href).toBe("https://example.com/docs");
    expect(items[1].resources).toEqual([]);
    expect(items[2].resources).toEqual([]);
    expect(items[3].resources[0]).toMatchObject({ label: "docs/readme.md" });
    expect(items[3].resources[0].href).toBeUndefined();
  });
});
