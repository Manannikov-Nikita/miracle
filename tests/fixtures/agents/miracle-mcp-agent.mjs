/** Deterministic Claude wire peer exercising Miracle's actual HTTP MCP tools. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
const endpoint = config.mcpServers.miracle.url;
const token = process.env.MIRACLE_AGENT_MCP_TOKEN;
const control = process.env.FIXTURE_CONTROL;
let seq = 0;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
  });
  if (!response.ok)
    throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()).result;
}
async function call(name, input = {}, allowError = false) {
  const response = await rpc("tools/call", { name, arguments: input });
  const value = JSON.parse(response.content[0].text);
  if (response.isError && !allowError)
    throw new Error(`${name}: ${JSON.stringify(value)}`);
  return { value, isError: response.isError };
}
const value = async (name, input = {}) => (await call(name, input)).value;
async function workflow() {
  const context = await value("project_context");
  const fileText = readFileSync("project-data.txt", "utf8");
  const connections = await value("list_connections");
  const connectionId = connections[0].id;
  const schema = await value("read_schema", {
    connectionId,
    kind: "columns",
    schema: "demo",
    table: "sales",
  });
  const editor = await value("create_editor", {
    id: randomUUID(),
    name: "agent.sql",
    sql: "SELECT 0",
    connectionId,
  });
  const edit = {
    id: editor.id,
    baseRevision: editor.revision,
    mutationId: randomUUID(),
    sql: "SELECT toUInt64(9007199254740993) AS exact, 1 AS n",
  };
  const updated = await value("edit_editor", edit);
  const repeatedEdit = await value("edit_editor", edit);
  const staleEdit = await call(
    "edit_editor",
    { ...edit, mutationId: randomUUID(), sql: "SELECT 999" },
    true,
  );
  const saved = await value("save_query", {
    name: "Agent query",
    connectionId,
    sql: updated.sql,
    mutationId: randomUUID(),
  });
  const runArgs = { connectionId, sql: updated.sql, mutationId: randomUUID() };
  const run = await value("run_query", runArgs);
  const repeatedRun = await value("run_query", runArgs);
  let status = run;
  for (
    let i = 0;
    i < 300 && ["running", "cancelling"].includes(status.status);
    i++
  ) {
    await delay(10);
    status = await value("query_status", { id: run.id });
  }
  if (status.status !== "completed")
    throw new Error(`Query did not complete: ${JSON.stringify(status)}`);
  const result = await value("read_result", {
    id: status.resultSetId,
    limit: 10,
  });
  const board = await value("create_board", {
    name: "Agent board",
    mutationId: randomUUID(),
  });
  const patchArgs = {
    id: board.id,
    baseRevision: board.revision,
    mutationId: randomUUID(),
    operations: [
      {
        type: "add_node",
        node: {
          id: "result",
          type: "artifact",
          position: { x: 10, y: 20 },
          data: {
            kind: "result",
            title: "Exact result",
            resultSetId: status.resultSetId,
            source: { connectionId, sql: updated.sql },
            view: "table",
          },
        },
      },
      {
        type: "add_node",
        node: {
          id: "note",
          type: "artifact",
          position: { x: 100, y: 50 },
          data: { kind: "note", title: "Project fact", text: fileText },
        },
      },
      {
        type: "add_edge",
        edge: { id: "link", source: "result", target: "note" },
      },
    ],
  };
  const populated = await value("board_patch", patchArgs);
  const repeatedBoard = await value("board_patch", patchArgs);
  const rearranged = await value("board_patch", {
    id: board.id,
    baseRevision: populated.revision,
    mutationId: randomUUID(),
    operations: [
      {
        type: "update_node",
        id: "result",
        patch: { position: { x: 400, y: 250 }, width: 600, height: 300 },
      },
    ],
  });
  const staleBoard = await call(
    "board_patch",
    {
      id: board.id,
      baseRevision: populated.revision,
      mutationId: randomUUID(),
      operations: [{ type: "remove_node", id: "result" }],
    },
    true,
  );
  return {
    context,
    cwd: process.cwd(),
    fileText,
    connections,
    schema,
    editor: updated,
    repeatedEdit,
    staleEdit,
    saved,
    run,
    repeatedRun,
    status,
    result,
    board: rearranged,
    repeatedBoard,
    staleBoard,
  };
}
createInterface({ input: process.stdin }).once("line", async (line) => {
  try {
    const message = JSON.parse(line);
    if (message.type !== "user") throw new Error("Expected user input");
    emit({
      type: "system",
      subtype: "init",
      session_id: "miracle-mcp-fixture",
    });
    const initialized = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    });
    const tools = await rpc("tools/list");
    writeFileSync(
      join(control, "capability.json"),
      JSON.stringify({
        endpoint,
        token,
        initialized,
        toolNames: tools.tools.map((t) => t.name),
      }),
      { mode: 0o600 },
    );
    const result = process.env.FIXTURE_WORKFLOW === "1" ? await workflow() : {};
    writeFileSync(join(control, "result.json"), JSON.stringify(result));
    while (!existsSync(join(control, "release"))) await delay(10);
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "miracle-mcp-fixture",
      result: "MCP workflow complete",
    });
  } catch (error) {
    writeFileSync(join(control, "failure.txt"), String(error?.stack || error));
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: [String(error?.message || error)],
    });
  }
});
