import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  startAgentTurn,
  validateAgentCommand,
  type AdapterEvent,
} from "../src/server/agents/adapter.js";
const dirs: string[] = [];
const fixture = resolve("tests/fixtures/agents/provider.mjs");
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function setup(provider: "codex" | "claude", scenario = "normal") {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "miracle-adapter-")));
  dirs.push(cwd);
  const trace = join(cwd, "trace.jsonl");
  const command = `FIXTURE_PROVIDER=${provider} FIXTURE_SCENARIO=${scenario} FIXTURE_TRACE=${quote(trace)} ${quote(process.execPath)} ${quote(fixture)}`;
  return { cwd, trace, command };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("native agent adapters", () => {
  it.each(["child-completed", "child-error"])(
    "Codex isolates parent messages and completion from %s during native resume",
    async (scenario) => {
      const f = setup("codex", scenario);
      const events: AdapterEvent[] = [];
      const p = startAgentTurn({
        provider: "codex",
        command: f.command,
        cwd: f.cwd,
        prompt: "continue",
        resumeSessionId: "codex-session",
        mcp: { url: "http://127.0.0.1/mcp", token: "secret" },
        onEvent: (event) => {
          events.push(event);
          if (event.type === "approval") p.respond(event.id, "deny");
        },
      });
      await expect(p.completion).resolves.toEqual({
        sessionId: "codex-session",
      });
      expect(events.filter((event) => event.type === "message")).toEqual([
        { type: "message", text: "Parent before response. " },
        { type: "message", text: "Parent finished" },
      ]);
      expect(events.filter((event) => event.type === "approval")).toMatchObject(
        [{ id: "child-approval", details: { threadId: "child-session" } }],
      );
      const trace = readFileSync(f.trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        trace.find((entry) => entry.wire?.id === "child-approval")?.wire.result,
      ).toEqual({ decision: "decline" });
      expect(
        trace.some((entry) => entry.wire?.method === "thread/resume"),
      ).toBe(true);
    },
  );
  it("Codex interrupts the root turn after a child turn starts", async () => {
    const f = setup("codex", "child-cancel");
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const p = startAgentTurn({
      provider: "codex",
      command: f.command,
      cwd: f.cwd,
      prompt: "wait",
      mcp: { url: "http://127.0.0.1/mcp", token: "secret" },
      onEvent: (event) => {
        if (event.type === "approval") p.respond(event.id, "deny");
        if (event.type === "action" && event.text === "parent-ready") ready();
      },
    });
    const done = p.completion.catch((error) => error);
    await Promise.race([started, done]);
    await p.cancel();
    expect((await done).code).toBe("AGENT_CANCELLED");
    const trace = readFileSync(f.trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      trace.find((entry) => entry.wire?.method === "turn/interrupt")?.wire
        .params,
    ).toEqual({ threadId: "codex-session", turnId: "turn-1" });
  });
  it("Codex streams Unicode across chunks, translates approvals and sends native cwd/input/config", async () => {
    const f = setup("codex");
    const events: AdapterEvent[] = [];
    const p = startAgentTurn({
      provider: "codex",
      command: f.command + " --model chosen -a on-request",
      cwd: f.cwd,
      prompt: "hello",
      mcp: { url: "http://127.0.0.1:1234/mcp", token: "scoped-secret" },
      onEvent: (e) => {
        events.push(e);
        if (e.type === "approval")
          setTimeout(
            () => p.respond(e.id, e.id === "101" ? "allow" : "deny"),
            0,
          );
      },
    });
    expect(await p.completion).toEqual({ sessionId: "codex-session" });
    expect(events.filter((e) => e.type === "message")).toEqual([
      { type: "message", text: "Hello 🌍" },
    ]);
    expect(events.filter((e) => e.type === "approval")).toHaveLength(2);
    const lines = readFileSync(f.trace, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    expect(lines[0]).toMatchObject({ cwd: f.cwd, token: true });
    expect(JSON.stringify(lines)).not.toContain("scoped-secret");
    expect(
      lines.find((x) => x.wire?.method === "thread/start").wire.params,
    ).toMatchObject({ cwd: f.cwd });
    expect(
      lines.find((x) => x.wire?.method === "turn/start").wire.params,
    ).toMatchObject({
      threadId: "codex-session",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
    expect(
      lines.find((x) => x.wire?.id === 101 && x.wire?.result).wire.result,
    ).toEqual({ decision: "accept" });
  });
  it.each(["codex", "claude"] as const)(
    "%s explicitly resumes its saved session and marks only missing session errors retryable",
    async (provider) => {
      const f = setup(provider, "missing");
      const p = startAgentTurn({
        provider,
        command: f.command,
        cwd: f.cwd,
        prompt: "next",
        resumeSessionId: "missing",
        mcp: { url: "http://127.0.0.1:1234/mcp", token: "secret" },
        onEvent: () => {},
      });
      await expect(p.completion).rejects.toMatchObject({
        code: "AGENT_SESSION_UNAVAILABLE",
      });
      const trace = readFileSync(f.trace, "utf8");
      expect(trace).toContain(
        provider === "codex" ? "thread/resume" : "--resume",
      );
    },
  );
  it("Claude emits partial tokens once and preserves model/permissions and transient MCP configuration", async () => {
    const f = setup("claude");
    const events: AdapterEvent[] = [];
    const p = startAgentTurn({
      provider: "claude",
      command: f.command + " --model sonnet --permission-mode default",
      cwd: f.cwd,
      prompt: "hello",
      mcp: { url: "http://127.0.0.1:1234/mcp", token: "secret" },
      onEvent: (e) => events.push(e),
    });
    expect(await p.completion).toEqual({ sessionId: "claude-session" });
    expect(events.filter((e) => e.type === "message")).toEqual([
      { type: "message", text: "Hello 🌍" },
    ]);
    expect(
      events.some((e) => e.type === "action" && e.text.includes("Read")),
    ).toBe(true);
    const trace = readFileSync(f.trace, "utf8");
    expect(trace).toContain("mcp__miracle__permission_prompt");
    expect(trace).not.toContain("Bearer secret");
    expect(trace).not.toContain("inputEnded");
  });
  it.each(["codex", "claude"] as const)(
    "%s cancels only its owned process and settles completion",
    async (provider) => {
      const f = setup(provider, "hang");
      let ready!: () => void;
      const started = new Promise<void>((r) => (ready = r));
      const p = startAgentTurn({
        provider,
        command: f.command,
        cwd: f.cwd,
        prompt: "wait",
        mcp: { url: "http://127.0.0.1:1234/mcp", token: "secret" },
        onEvent: (e) => {
          if (e.type === "session") ready();
        },
      });
      const done = p.completion.catch((e) => e);
      await started;
      await p.cancel();
      expect((await done).code).toBe("AGENT_CANCELLED");
    },
  );
  it.each(["bad-json", "exit"])(
    "rejects %s transport failures without a retryable session code",
    async (scenario) => {
      const f = setup("codex", scenario);
      const p = startAgentTurn({
        provider: "codex",
        command: f.command,
        cwd: f.cwd,
        prompt: "x",
        mcp: { url: "http://127.0.0.1:1234/mcp", token: "secret" },
        onEvent: () => {},
      });
      await expect(p.completion).rejects.toThrow(
        scenario === "bad-json"
          ? /invalid structured JSON/
          : /authentication failed/,
      );
    },
  );
  it("settles invalid command startup and reports missing executable validation", async () => {
    const f = setup("codex");
    const p = startAgentTurn({
      provider: "codex",
      command: "codex | cat",
      cwd: f.cwd,
      prompt: "x",
      mcp: { url: "http://127.0.0.1/mcp", token: "x" },
      onEvent: () => {},
    });
    await expect(p.completion).rejects.toThrow(/wrapper/);
    await expect(
      validateAgentCommand("codex", "/missing/miracle-codex", f.cwd),
    ).rejects.toThrow(/executable|ENOENT/i);
  });
  it("rejects missing protocol capabilities before starting a turn", async () => {
    const f = setup("claude", "old-cli");
    await expect(
      validateAgentCommand("claude", f.command, f.cwd),
    ).rejects.toThrow(/does not support/);
  });
  it("rejects incompatible Codex handshake before starting a thread", async () => {
    const f = setup("codex", "bad-handshake");
    const p = startAgentTurn({
      provider: "codex",
      command: f.command,
      cwd: f.cwd,
      prompt: "x",
      mcp: { url: "http://127.0.0.1/mcp", token: "x" },
      onEvent: () => {},
    });
    await expect(p.completion).rejects.toThrow(/compatible protocol/);
    expect(readFileSync(f.trace, "utf8")).not.toContain("thread/start");
  });
  it("does not classify a resumed provider storage error as a missing session", async () => {
    const f = setup("codex", "storage-error");
    const p = startAgentTurn({
      provider: "codex",
      command: f.command,
      cwd: f.cwd,
      prompt: "x",
      resumeSessionId: "existing",
      mcp: { url: "http://127.0.0.1/mcp", token: "x" },
      onEvent: () => {},
    });
    const error = await p.completion.catch((e) => e);
    expect(error.message).toContain("session database unavailable");
    expect(error.code).not.toBe("AGENT_SESSION_UNAVAILABLE");
  });
  it("uses Claude result text when the provider omitted assistant messages", async () => {
    const f = setup("claude", "result-only");
    const events: AdapterEvent[] = [];
    const p = startAgentTurn({
      provider: "claude",
      command: f.command,
      cwd: f.cwd,
      prompt: "x",
      mcp: { url: "http://127.0.0.1/mcp", token: "x" },
      onEvent: (e) => events.push(e),
    });
    await p.completion;
    expect(events.filter((e) => e.type === "message")).toEqual([
      { type: "message", text: "Hello 🌍" },
    ]);
  });

  it("escalates cancellation for its stubborn process group while leaving unrelated processes alive", async () => {
    const f = setup("codex", "stubborn");
    const unrelated = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    const p = startAgentTurn({
      provider: "codex",
      command: f.command,
      cwd: f.cwd,
      prompt: "wait",
      mcp: { url: "http://127.0.0.1/mcp", token: "token" },
      onEvent: () => {},
    });
    const done = p.completion.catch((e) => e);
    try {
      let childPid: number | undefined;
      await vi.waitFor(() => {
        const entries = readFileSync(f.trace, "utf8")
          .trim()
          .split("\n")
          .map((x) => JSON.parse(x));
        childPid = entries.find((x) => x.childPid)?.childPid;
        expect(childPid).toBeTypeOf("number");
      });
      await p.cancel();
      expect((await done).code).toBe("AGENT_CANCELLED");
      expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
      await vi.waitFor(
        () => expect(() => process.kill(childPid!, 0)).toThrow(),
        { timeout: 2000 },
      );
    } finally {
      await p.cancel();
      unrelated.kill("SIGKILL");
    }
  });
  it("requires the Miracle bridge before starting a Codex turn", async () => {
    const f = setup("codex", "required");
    let p: ReturnType<typeof startAgentTurn>;
    p = startAgentTurn({
      provider: "codex",
      command: f.command,
      cwd: f.cwd,
      prompt: "x",
      mcp: { url: "http://127.0.0.1/mcp", token: "token" },
      onEvent: (e) => {
        if (e.type === "approval")
          setTimeout(() => p.respond(e.id, "allow"), 0);
      },
    });
    await expect(p.completion).resolves.toEqual({ sessionId: "codex-session" });
  });
  it("translates modern permission grants without null optional permission fields", async () => {
    const f = setup("codex", "permissions");
    let p: ReturnType<typeof startAgentTurn>;
    p = startAgentTurn({
      provider: "codex",
      command: f.command,
      cwd: f.cwd,
      prompt: "x",
      mcp: { url: "http://127.0.0.1/mcp", token: "token" },
      onEvent: (e) => {
        if (e.type === "approval")
          setTimeout(() => p.respond(e.id, "allow"), 0);
      },
    });
    await expect(p.completion).resolves.toEqual({ sessionId: "codex-session" });
    const entries = readFileSync(f.trace, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    expect(
      entries.find((x) => x.wire?.id === "permissions" && x.wire?.result)?.wire
        .result,
    ).toEqual({
      permissions: { fileSystem: { read: null, write: [f.cwd] } },
      scope: "turn",
    });
  });
});
