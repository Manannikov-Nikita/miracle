import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("2.1.200 (Claude Code)");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log(
    "--input-format --output-format --verbose --include-partial-messages --permission-prompt-tool --mcp-config --resume",
  );
  process.exit(0);
}

const emit = (event) => console.log(JSON.stringify(event));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
createInterface({ input: process.stdin }).once("line", async (line) => {
  const prompt = JSON.parse(line).message.content;
  const text =
    typeof prompt === "string"
      ? prompt
      : prompt.map(({ text }) => text).join("\n");
  const name = JSON.parse(text.match(/^Board worker: (.+)$/m)?.[1] || '"root"');
  const session = name + "-session";
  emit({ type: "system", subtype: "init", session_id: session });
  const path = join(process.env.FIXTURE_CONTROL, name + ".json");
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const temporary = path + ".tmp";
  writeFileSync(
    temporary,
    JSON.stringify({
      pid: process.pid,
      token: process.env.MIRACLE_AGENT_MCP_TOKEN,
      args,
      prompt: text,
      endpoint: config.mcpServers.miracle.url,
    }),
    { mode: 0o600 },
  );
  renameSync(temporary, path);
  while (!existsSync(join(process.env.FIXTURE_CONTROL, name + ".finish")))
    await delay(10);
  if (name === "reports-outcome") {
    emit({
      type: "assistant",
      message: {
        id: "progress",
        content: [{ type: "text", text: "Checking geometry. ".repeat(100) }],
      },
    });
    emit({
      type: "stream_event",
      event: { type: "message_start", message: { id: "outcome" } },
    });
    for (const text of [
      "\n",
      "Could not place the shape ",
      "because its anchor disappeared.",
    ])
      emit({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        },
      });
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: session,
    result: "x".repeat(10000) + "\nfixture finished",
  });
});
