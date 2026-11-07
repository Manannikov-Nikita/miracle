import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  startAgentTurn,
  type AdapterEvent,
} from "../src/server/agents/adapter";
const dirs: string[] = [];
const processes: ReturnType<typeof startAgentTurn>[] = [];
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function launch(provider: "codex" | "claude", scenario: string) {
  const cwd = realpathSync(
    mkdtempSync(join(tmpdir(), "miracle-native-interactions-")),
  );
  dirs.push(cwd);
  const trace = join(cwd, "trace.jsonl");
  const events: AdapterEvent[] = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const p = startAgentTurn({
    provider,
    cwd,
    command: `FIXTURE_PROVIDER=${provider} FIXTURE_SCENARIO=${scenario} FIXTURE_TRACE=${quote(trace)} ${quote(process.execPath)} ${quote(resolve("tests/fixtures/agents/provider.mjs"))}`,
    prompt: "Work",
    mcp: { url: "http://127.0.0.1/mcp", token: "secret" },
    onEvent: (event) => {
      events.push(event);
      if (
        event.type === "question" ||
        (event.type === "action" && event.text === "parent-ready")
      )
        ready();
    },
  });
  processes.push(p);
  void p.completion.catch(() => {});
  return {
    p,
    events,
    started,
    wires: () =>
      readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.wire)
        .map((entry) => entry.wire),
  };
}
afterEach(async () => {
  for (const p of processes.splice(0)) await p.cancel();
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true });
});
it("answers a native Codex question using its original JSON-RPC request id", async () => {
  const f = launch("codex", "question");
  await f.started;
  expect(f.events.find((event) => event.type === "question")).toMatchObject({
    type: "question",
    id: "native-question",
    questions: [{ id: "output", question: "Choose output", allowOther: true }],
  });
  f.p.answerQuestion!("native-question", { output: ["Table"] });
  await f.p.completion;
  expect(f.wires().find((wire) => wire.id === "native-question")).toMatchObject(
    { result: { answers: { output: { answers: ["Table"] } } } },
  );
});
it.each(["steer", "steer-completion-first"])(
  "Codex sends native Steer without interrupt and retains the receipt in %s",
  async (scenario) => {
    const f = launch("codex", scenario);
    await f.started;
    const id = randomUUID();
    await f.p.steer!({ prompt: "Use a table", clientRequestId: id });
    await f.p.completion;
    expect(
      f.wires().find((wire) => wire.method === "turn/steer").params,
    ).toMatchObject({
      threadId: "codex-session",
      expectedTurnId: "turn-1",
      clientUserMessageId: id,
      input: [{ type: "text", text: "Use a table" }],
    });
    expect(f.wires().some((wire) => wire.method === "turn/interrupt")).toBe(
      false,
    );
  },
);
it("Claude delivers no-stop input after a queued root result and excludes child replies", async () => {
  const f = launch("claude", "steer");
  await f.started;
  const id = randomUUID();
  await f.p.steer!({ prompt: "Use a table", clientRequestId: id });
  await expect(f.p.completion).resolves.toEqual({
    sessionId: "claude-session",
  });
  const wires = f.wires();
  expect(wires.filter((wire) => wire.type === "user")).toHaveLength(2);
  expect(wires[1]).toMatchObject({
    uuid: id,
    priority: "next",
    origin: { kind: "human" },
    message: { content: "Use a table" },
  });
  expect(f.events.filter((event) => event.type === "message")).toEqual([
    { type: "message", text: "Steer received" },
  ]);
});
it.each(["codex", "claude"] as const)(
  "%s exposes child task status without completing the root",
  async (provider) => {
    const f = launch(provider, "subagent");
    await f.p.completion;
    expect(f.events.filter((event) => event.type === "subagent")).toMatchObject(
      [
        { subagent: { id: "child", status: "running" } },
        { subagent: { id: "child", status: "completed" } },
      ],
    );
    expect(f.events.filter((event) => event.type === "message")).toEqual([
      { type: "message", text: "Parent complete" },
    ]);
  },
);
it.each(["codex", "claude"] as const)(
  "%s cancellation rejects every pending steering receipt",
  async (provider) => {
    const f = launch(provider, "steer-cancel");
    await f.started;
    const pending = f.p.steer!({
      prompt: "Keep going",
      clientRequestId: randomUUID(),
    }).catch((error) => error);
    await vi.waitFor(() =>
      expect(
        f
          .wires()
          .some(
            (wire) => wire.method === "turn/steer" || wire.priority === "next",
          ),
      ).toBe(true),
    );
    await f.p.cancel();
    expect((await pending).code).toBe("AGENT_CANCELLED");
  },
);
it("rejects Claude Steer before writing when the initial reply supplies no correlated receipt", async () => {
  const f = launch("claude", "steer-old");
  await f.started;
  await expect(
    f.p.steer!({ prompt: "Keep going", clientRequestId: randomUUID() }),
  ).rejects.toMatchObject({ code: "AGENT_STEER_UNSUPPORTED" });
  expect(f.wires().filter((wire) => wire.type === "user")).toHaveLength(1);
});
it("tracks foreground Claude child completion from its actual tool result", async () => {
  const f = launch("claude", "subagent-foreground");
  await f.p.completion;
  expect(
    f.events.filter((event) => event.type === "subagent").at(-1),
  ).toMatchObject({ subagent: { id: "child", status: "completed" } });
});
it("rejects a Codex question answer once the native turn ended even while process shutdown is pending", async () => {
  const f = launch("codex", "question-ended");
  await f.started;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(() =>
    f.p.answerQuestion!("native-question", { output: ["Table"] }),
  ).toThrow();
  await f.p.completion;
  expect(
    f.wires().some((wire) => wire.id === "native-question" && wire.result),
  ).toBe(false);
});

it("normalizes Codex subAgentActivity lifecycle by kind rather than item phase", async () => {
  const f = launch("codex", "subagent-activity");
  await f.p.completion;
  const children = f.events.filter((event) => event.type === "subagent");
  expect(children).toMatchObject([
    { subagent: { id: "child", status: "running" } },
    { subagent: { id: "child", status: "running" } },
    { subagent: { id: "child", status: "running" } },
    { subagent: { id: "cancelled-child", status: "cancelled" } },
    { subagent: { id: "child", status: "completed" } },
    { subagent: { id: "child", status: "completed" } },
  ]);
  expect(
    children.every((event) => event.subagent.parentId === "codex-session"),
  ).toBe(true);
  expect(children[0].subagent.name).toContain("child");
  expect(f.events.filter((event) => event.type === "message")).toEqual([
    { type: "message", text: "Parent complete" },
  ]);
});
