import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverClaudeModels,
  resolveClaudeModelSettings,
} from "../src/server/agents/claude-models";
import { buildAgentCommand } from "../src/server/agents/command";
import { startClaudeTurn } from "../src/server/agents/claude";
import { startAgentTurn } from "../src/server/agents/adapter";

const directories: string[] = [];
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
function fixture(scenario = "normal", flags = "") {
  const cwd = mkdtempSync(join(tmpdir(), "miracle-claude-models-"));
  directories.push(cwd);
  const trace = join(cwd, "trace.jsonl");
  const executable = join(cwd, "cli.mjs");
  writeFileSync(
    executable,
    `
    import { appendFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const trace = ${JSON.stringify(trace)};
    const log = value => appendFileSync(trace, JSON.stringify(value) + '\\n');
    log({args:process.argv.slice(2)});
    if (process.argv.includes('--version')) { console.log('Claude fixture 1.0'); process.exit(0); }
    if (process.argv.includes('--help')) {
      console.log('--input-format --output-format --include-partial-messages --permission-prompt-tool --mcp-config --resume');
      process.exit(0);
    }
    createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line); log({request});
      if (${JSON.stringify(scenario)} === 'turn' && request.type === 'user') {
        console.log(JSON.stringify({type:'system',subtype:'init',session_id:'resumed-session'}));
        console.log(JSON.stringify({type:'result',subtype:'success',session_id:'resumed-session',result:'fixture done'}));
        return;
      }
      if (${JSON.stringify(scenario)} === 'hang') return;
      if (request.type !== 'control_request' || request.request.subtype !== 'initialize') process.exit(4);
      const models = ${JSON.stringify(scenario)} === 'unsupported' ? undefined : [
        {value:'sonnet',resolvedModel:'claude-sonnet-current',displayName:'Sonnet',description:'Balanced',supportsEffort:true,supportedEffortLevels:['low','high','high']},
        {value:'haiku',displayName:'Haiku',supportsEffort:false,supportedEffortLevels:['high']},
        {value:'future',displayName:'Future',supportedEffortLevels:['xhigh']},
        {value:'legacy',displayName:'Legacy'},
        {value:'--invalid',displayName:'Invalid'}, null
      ];
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:{models,account:{email:'private@example.test',apiKey:'do-not-return'}}}}));
    });
  `,
  );
  return {
    cwd,
    trace,
    command: `${quote(process.execPath)} ${quote(executable)} ${flags}`.trim(),
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Claude model catalog", () => {
  it("requests metadata without a user turn and returns only advertised model capabilities", async () => {
    const f = fixture();
    const catalog = await discoverClaudeModels(f.command, f.cwd);
    expect(catalog.models.map((model) => model.id)).toEqual([
      "sonnet",
      "haiku",
      "future",
      "legacy",
    ]);
    expect(catalog.models[0]).toEqual({
      id: "sonnet",
      name: "Sonnet",
      description: "Balanced",
      reasoningEfforts: [{ id: "low" }, { id: "high" }],
    });
    expect(catalog.models[1].reasoningEfforts).toEqual([]);
    expect(catalog.models[2].reasoningEfforts).toEqual([{ id: "xhigh" }]);
    expect(catalog.models[3].reasoningEfforts).toEqual([]);
    expect(JSON.stringify(catalog)).not.toMatch(
      /private@example|do-not-return|account/,
    );
    const entries = readFileSync(f.trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.request)).toHaveLength(1);
    expect(entries[1].request).toMatchObject({
      type: "control_request",
      request: { subtype: "initialize" },
    });
    expect(entries[0].args).toContain("--strict-mcp-config");
    expect(entries[0].args).toContain("--no-session-persistence");
    expect(entries[0].args).not.toContain("--permission-prompt-tool");
    expect(entries[0].args).toContain('{"disableAllHooks":true}');
  });

  it("reports explicit profile defaults without guessing an unadvertised effort", async () => {
    const f = fixture("normal", "--model=claude-sonnet-current --effort high");
    expect(await discoverClaudeModels(f.command, f.cwd)).toMatchObject({
      defaultModel: "sonnet",
      defaultReasoningEffort: "high",
    });
    const plain = fixture();
    const catalog = await discoverClaudeModels(plain.command, plain.cwd);
    expect(catalog.defaultModel).toBeUndefined();
    expect(catalog.defaultReasoningEffort).toBeUndefined();
  });

  it("explains missing metadata and rejects custom settings without reading or replacing them", async () => {
    const f = fixture("unsupported");
    await expect(discoverClaudeModels(f.command, f.cwd)).rejects.toMatchObject({
      code: "AGENT_MODEL_CATALOG_UNAVAILABLE",
    });
    const custom = fixture(
      "normal",
      "--settings=/private/unread-settings.json",
    );
    await expect(
      discoverClaudeModels(custom.command, custom.cwd),
    ).rejects.toThrow(/--settings/);
  });

  it("cancels an initialization probe without sending a prompt", async () => {
    const f = fixture("hang");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60);
    try {
      await expect(
        discoverClaudeModels(f.command, f.cwd, controller.signal),
      ).rejects.toMatchObject({ code: "AGENT_CANCELLED" });
    } finally {
      clearTimeout(timer);
    }
  });

  it("validates explicit selections but preserves profile defaults for empty settings", async () => {
    const catalog = {
      models: [
        {
          id: "sonnet",
          name: "Sonnet",
          reasoningEfforts: [{ id: "low" }, { id: "high" }],
        },
        { id: "haiku", name: "Haiku", reasoningEfforts: [] },
      ],
      defaultModel: "sonnet",
      defaultReasoningEffort: "high",
    };
    expect(resolveClaudeModelSettings(catalog, {})).toEqual({});
    expect(resolveClaudeModelSettings(catalog, { model: "sonnet" })).toEqual({
      model: "sonnet",
    });
    expect(
      resolveClaudeModelSettings(catalog, { reasoningEffort: "low" }),
    ).toEqual({ reasoningEffort: "low" });
    expect(() =>
      resolveClaudeModelSettings(catalog, { model: "missing" }),
    ).toThrow();
    expect(() =>
      resolveClaudeModelSettings(catalog, {
        model: "haiku",
        reasoningEffort: "high",
      }),
    ).toThrow();
    expect(() =>
      resolveClaudeModelSettings(
        { ...catalog, defaultModel: undefined },
        { reasoningEffort: "low" },
      ),
    ).toThrow();
  });
});

describe("Claude per-turn flags", () => {
  it("runs reset-to-profile settings without requiring catalog support or replacing custom settings", async () => {
    const f = fixture(
      "turn",
      "--model=profile-model --effort=high --settings=/private/unread-settings.json",
    );
    const process = startAgentTurn({
      provider: "claude",
      command: f.command,
      cwd: f.cwd,
      prompt: "Synthetic fixture turn",
      modelSettings: {},
      mcp: { url: "http://127.0.0.1/fixture-mcp", token: "fixture-token" },
      onEvent() {},
    });
    await expect(process.completion).resolves.toEqual({
      sessionId: "resumed-session",
    });
    const entries = readFileSync(f.trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.request)).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ type: "user" }),
      }),
    ]);
    const args = entries.filter((entry) => entry.args).at(-1).args;
    expect(args).toContain("--model=profile-model");
    expect(args).toContain("--effort=high");
    expect(args).toContain("--settings=/private/unread-settings.json");
    expect(args).not.toContain("--no-session-persistence");
  });
  it("passes selected flags alongside resume to the actual Claude adapter transport", async () => {
    const f = fixture("turn", "--model old --effort low");
    const process = startClaudeTurn({
      provider: "claude",
      command: f.command,
      cwd: f.cwd,
      prompt: "Synthetic fixture turn",
      resumeSessionId: "previous-session",
      model: "sonnet",
      reasoningEffort: "high",
      mcp: { url: "http://127.0.0.1/fixture-mcp", token: "fixture-token" },
      onEvent() {},
    });
    await expect(process.completion).resolves.toEqual({
      sessionId: "resumed-session",
    });
    const args = JSON.parse(readFileSync(f.trace, "utf8").split("\n")[0]).args;
    expect(
      args.slice(args.indexOf("--model"), args.indexOf("--model") + 2),
    ).toEqual(["--model", "sonnet"]);
    expect(
      args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2),
    ).toEqual(["--effort", "high"]);
    expect(
      args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2),
    ).toEqual(["--resume", "previous-session"]);
    expect(args).not.toContain("old");
  });
  it("overrides only model and effort argv while preserving wrapper, permissions and environment", () => {
    const command =
      "MODE=fixture wrapper agent claude --model=old --effort low --permission-mode default --model second";
    const built = buildAgentCommand("claude", command, {
      model: "sonnet",
      reasoningEffort: "high",
    });
    expect(built.env).toEqual({ MODE: "fixture" });
    expect(built.prefixArgs).toEqual(["agent", "claude"]);
    expect(built.args).toContain("--permission-mode");
    expect(built.args).not.toContain("--model=old");
    expect(built.args).not.toContain("second");
    expect(built.args.filter((value) => value === "--model")).toHaveLength(1);
    expect(built.args.filter((value) => value === "--effort")).toHaveLength(1);
    expect(
      built.args.slice(
        built.args.indexOf("--model"),
        built.args.indexOf("--model") + 2,
      ),
    ).toEqual(["--model", "sonnet"]);
    expect(
      built.args.slice(
        built.args.indexOf("--effort"),
        built.args.indexOf("--effort") + 2,
      ),
    ).toEqual(["--effort", "high"]);
  });
  it("leaves unspecified profile choices intact and rejects flag-shaped override values", () => {
    const command = "claude --model=sonnet --effort=high";
    expect(buildAgentCommand("claude", command, {}).args).toEqual(
      buildAgentCommand("claude", command).args,
    );
    const built = buildAgentCommand("claude", command, { model: "haiku" });
    expect(built.args).toContain("--effort=high");
    expect(() =>
      buildAgentCommand("claude", command, {
        model: "--dangerously-skip-permissions",
      }),
    ).toThrow();
  });
});
