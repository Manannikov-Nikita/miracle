import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.167.0");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("app-server --stdio");
  process.exit(0);
}
const scenario = process.env.MODEL_FIXTURE_SCENARIO ?? "normal";
const trace = (value) =>
  appendFileSync(process.env.MODEL_FIXTURE_TRACE, JSON.stringify(value) + "\n");
trace({ pid: process.pid, args });
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const config = {
  model: "model-deep",
  model_reasoning_effort: "high",
  provider_api_key: "private-config-key",
};
for (let index = 0; index < args.length; index++) {
  if (args[index] !== "-c") continue;
  const assignment = args[++index];
  const equal = assignment.indexOf("=");
  const key = assignment.slice(0, equal);
  if (!["model", "model_reasoning_effort"].includes(key)) continue;
  const raw = assignment.slice(equal + 1);
  try {
    config[key] = JSON.parse(raw);
  } catch {
    config[key] = raw;
  }
}
if (scenario === "catalog-default") {
  config.model = null;
  config.model_reasoning_effort = null;
}
const model = (id, value, efforts, defaultEffort, isDefault = false) => ({
  id,
  model: value,
  displayName: value === "model-fast" ? "Fast" : "Deep",
  description: "Model description",
  hidden: false,
  isDefault,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
    reasoningEffort,
    description: reasoningEffort + " description",
  })),
  defaultReasoningEffort: defaultEffort,
  privateAccount: "never-return-this",
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  trace({ wire: message });
  const reply = (result) => emit({ id: message.id, result });
  if (message.method === "initialize")
    return reply({ userAgent: "fixture/0.167.0" });
  if (message.method === "config/read")
    return reply({ config, layers: [{ secret: "private-layer" }] });
  if (message.method === "model/list") {
    if (scenario === "hang") return;
    if (scenario === "unsupported")
      return emit({
        id: message.id,
        error: {
          code: -32601,
          message: "unknown model/list " + process.env.TEST_API_TOKEN,
        },
      });
    if (scenario === "invalid")
      return reply({
        data: [{ model: "bad", supportedReasoningEfforts: "any" }],
      });
    if (scenario === "empty") return reply({ data: [], nextCursor: null });
    if (scenario === "repeat") return reply({ data: [], nextCursor: "same" });
    if (scenario === "no-efforts")
      return reply({
        data: [model("opaque-plain-id", "model-plain", [], null, true)],
        nextCursor: null,
      });
    return reply(
      message.params.cursor
        ? {
            data: [
              model("opaque-deep-id", "model-deep", ["high", "ultra"], "high"),
            ],
            nextCursor: null,
          }
        : {
            data: [
              model(
                "opaque-fast-id",
                "model-fast",
                ["low", "high"],
                "low",
                true,
              ),
              { ...model("hidden", "hidden", ["low"], "low"), hidden: true },
            ],
            nextCursor: "page-two",
          },
    );
  }
  if (message.method === "thread/start" || message.method === "thread/resume")
    return reply({
      thread: { id: "native-thread" },
      model: message.params.model ?? "previous-model",
      reasoningEffort: "ultra",
    });
  if (message.method === "turn/start") {
    reply({ turn: { id: "native-turn" } });
    setTimeout(
      () =>
        emit({
          method: "turn/completed",
          params: {
            threadId: "native-thread",
            turn: { id: "native-turn", status: "completed" },
          },
        }),
      5,
    );
  }
});
