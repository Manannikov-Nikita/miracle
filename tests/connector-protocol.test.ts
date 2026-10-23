import { expect, it } from "vitest";
import { parseEngineJson, validateNextUri } from "../src/server/connectors.js";
it("preserves integer and decimal precision from engine JSON", () => {
  const x = parseEngineJson(
    '{"data":[[9007199254740993,1.234567890123456789,42,0.1]]}',
  );
  expect(x.data[0]).toEqual([
    "9007199254740993",
    "1.234567890123456789",
    42,
    0.1,
  ]);
});
it("pins Trino continuation and cancellation to the configured origin", () => {
  expect(
    validateNextUri(
      "http://localhost:8080/v1/statement/x",
      "http://localhost:8080",
    ),
  ).toBe("http://localhost:8080/v1/statement/x");
  expect(() =>
    validateNextUri("http://evil.test/x", "http://localhost:8080"),
  ).toThrow();
  expect(() =>
    validateNextUri(
      "http://user:pass@localhost:8080/x",
      "http://localhost:8080",
    ),
  ).toThrow();
});
import { createServer, type Server } from "node:http";
import { executeEngine } from "../src/server/connectors.js";
async function serve(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  return "http://127.0.0.1:" + address.port;
}
async function stop(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
it.each(["initial", "continuation", "cancel"] as const)(
  "rejects cross-origin Trino %s redirects without forwarding identity",
  async (stage) => {
    let reached = 0;
    const foreign = createServer((_req, res) => {
      reached++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          columns: [{ name: "leak", type: "varchar" }],
          data: [["unexpected"]],
        }),
      );
    });
    const target = await serve(foreign);
    let origin = "";
    const coordinator = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      const redirect =
        stage === "initial" ||
        (stage === "continuation" && req.url === "/v1/statement/valid") ||
        (stage === "cancel" && req.method === "DELETE");
      if (redirect) {
        res.writeHead(302, { Location: target + "/unexpected" });
        res.end();
      } else
        res.end(
          JSON.stringify(
            req.url === "/v1/statement"
              ? { nextUri: origin + "/v1/statement/valid" }
              : { columns: [{ name: "n", type: "bigint" }], data: [[1]] },
          ),
        );
    });
    origin = await serve(coordinator);
    let cancel: undefined | (() => Promise<void>);
    try {
      const run = executeEngine(
        {
          engine: "trino",
          name: "fixture",
          url: origin,
          username: "secret-identity",
          password: "",
        },
        { connectionId: "fixture", sql: "SELECT 1" },
        "fixture",
        { timeoutMs: 2000, maxRows: 10, maxBytes: 10000 },
        AbortSignal.timeout(2000),
        (fn) => {
          cancel = fn;
        },
      );
      if (stage === "cancel") {
        await run;
        expect(cancel).toBeTypeOf("function");
        await expect(cancel!()).rejects.toThrow();
      } else await expect(run).rejects.toThrow();
      expect(reached).toBe(0);
    } finally {
      await stop(coordinator);
      await stop(foreign);
    }
  },
);
it('executes a formatted Trino aggregate with trailing semicolon and comment',async()=>{
  const sql=`SELECT\n  orderstatus,\n  count(*) AS orders\nFROM tpch.tiny.orders\nGROUP BY orderstatus\nORDER BY orderstatus; -- editor delimiter;\n`;
  const result=await executeEngine({engine:'trino',name:'real Trino',url:process.env.TRINO_URL||'http://127.0.0.1:18080',username:'miracle_reader',password:'',catalog:'tpch',schema:'tiny'},{connectionId:'fixture',sql},'fixture',{timeoutMs:15000,maxRows:20,maxBytes:100000},AbortSignal.timeout(15000),()=>{});
  expect(result.rows.map(row=>row[0])).toEqual(['F','O','P']);
  expect(result.rows.every(row=>Number(row[1])>0)).toBe(true);
});
