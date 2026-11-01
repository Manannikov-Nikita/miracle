// Local production-build acceptance fixture. No existing project state is opened.
// Run with Node >=24 after npm run build; Ctrl-C closes the temporary project.
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../dist/server/server/app.js";
import { customChartExamples } from "./fixtures/custom-chart-examples.ts";

const root = mkdtempSync(join(tmpdir(), "miracle-custom-chart-browser-"));
const project = join(root, "project");
mkdirSync(project);
const engine = createServer(async (request, response) => {
  let sql = "";
  for await (const part of request) sql += part;
  const example = customChartExamples.find((item) =>
    sql.includes(`custom-example:${item.id}`),
  );
  const columns = example?.columns ?? [{ name: "value", type: "UInt64" }];
  const rows = sql.includes("system.") ? [] : (example?.rows ?? [[12], [24], [36]]);
  response.setHeader("Content-Type", "text/plain");
  response.end(
    [columns.map((c) => c.name), columns.map((c) => c.type), ...rows]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
});
await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));
let origin = "http://127.0.0.1:3001";
const app = await buildApp({
  projectRoot: project,
  dataDir: join(project, ".miracle"),
  appOrigin: origin,
  runtimeOrigin: () => origin,
  serveStatic: true,
});
origin = await app.listen({ port: 0, host: "127.0.0.1" });
const sessionResponse = await fetch(origin + "/api/session");
const session = await sessionResponse.json();
const headers = {
  "content-type": "application/json",
  origin,
  cookie: sessionResponse.headers.get("set-cookie").split(";")[0],
  "x-csrf-token": session.csrfToken,
};
async function api(method, path, body) {
  const response = await fetch(origin + path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
    );
  return value;
}
const connection = await api("POST", "/api/connections", {
  name: "Демонстрационные данные",
  engine: "clickhouse",
  url: `http://127.0.0.1:${engine.address().port}`,
  username: "demo",
  password: "",
  database: "demo",
});
const nodes = [];
for (const [index, example] of customChartExamples.entries()) {
  const source = {
    connectionId: connection.id,
    sql: `/* custom-example:${example.id} */\n${example.sql}`,
  };
  let run = await api("POST", "/api/query-runs", {
    ...source,
    mutationId: randomUUID(),
  });
  while (["running", "cancelling"].includes(run.status)) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    run = await api("GET", `/api/query-runs/${run.id}`);
  }
  if (run.status !== "completed") throw new Error(run.error);
  nodes.push({
    id: example.id,
    type: "artifact",
    position: { x: index * 1080, y: 0 },
    width: 1020,
    height: 850,
    data: {
      kind: "result",
      title: example.title,
      view: "custom",
      customChart: example.spec,
      resultSetId: run.resultSetId,
      source,
    },
  });
}
const board = await api("POST", "/api/boards", {
  name: "Кастомные графики — проверка",
  document: { schemaVersion: 1, nodes, edges: [] },
  mutationId: randomUUID(),
});
writeFileSync(
  join(project, "README.md"),
  "This is a temporary Miracle test project. Use the Miracle MCP tools for live state. Never read .miracle internals. The current connection is a local synthetic SQL fixture: any SELECT not matching example markers returns a single numeric column named value with rows 12,24,36.\n",
);
writeFileSync(
  join(root, "browser-context.json"),
  JSON.stringify(
    {
      origin,
      project,
      boardId: board.id,
      connectionId: connection.id,
      nodeIds: nodes.map((node) => node.id),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    origin,
    project,
    boardId: board.id,
    connectionId: connection.id,
    nodeIds: nodes.map((node) => node.id),
    contextFile: join(root, "browser-context.json"),
  }),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    engine.closeAllConnections();
    engine.close(() => process.exit(0));
  });
