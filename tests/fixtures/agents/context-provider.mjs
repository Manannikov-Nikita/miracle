import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const provider = process.env.FIXTURE_PROVIDER;
if (process.argv.includes("--version")) {
  console.log(
    provider === "codex" ? "codex-cli 0.167.0" : "2.1.200 (Claude Code)",
  );
  process.exit(0);
}
if (process.argv.includes("--help")) {
  console.log(
    provider === "codex"
      ? "--stdio --listen app-server"
      : "--input-format --output-format --verbose --include-partial-messages --permission-prompt-tool --mcp-config --resume",
  );
  process.exit(0);
}
const fixture = JSON.parse(readFileSync(process.env.FIXTURE_MESSAGES, "utf8"));
const emit = (value) =>
  process.stdout.write(
    (typeof value === "string" ? value : JSON.stringify(value)) + "\n",
  );
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (provider === "claude") {
    if (request.type !== "user") process.exit(10);
    emit({ type: "system", subtype: "init", session_id: "root-session" });
    for (const message of fixture.messages || []) emit(message);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "root-session",
      result: "Finished",
      ...fixture.result,
    });
    return;
  }
  if (request.method === "initialize")
    emit({ id: request.id, result: { userAgent: "fixture/0.167.0" } });
  if (request.method === "config/read")
    emit({ id: request.id, result: { config: {} } });
  if (["thread/start", "thread/resume"].includes(request.method))
    emit({ id: request.id, result: { thread: { id: "root-session" } } });
  if (request.method === "turn/start") {
    for (const message of fixture.beforeStart || []) emit(message);
    emit({
      id: request.id,
      result: { turn: { id: "root-turn", status: "inProgress" } },
    });
    for (const message of fixture.messages || []) emit(message);
    emit({
      method: "turn/completed",
      params: {
        threadId: "root-session",
        turn: { id: "root-turn", status: "completed" },
      },
    });
  }
});
