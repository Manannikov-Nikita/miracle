import { createServer } from "node:http";
/** Deterministic remote HTTP engine; exercises the actual connector and SQLite API. */
export async function apiEngineFixture() {
  const server = createServer(async (req, res) => {
    let sql = "";
    for await (const part of req) sql += part;
    const compact = (names: string[], types: string[], rows: unknown[][]) =>
      res.end(
        [names, types, ...rows].map((v) => JSON.stringify(v)).join("\n") + "\n",
      );
    if (sql.startsWith("KILL")) return res.end("");
    if (sql.includes("sleepEachRow")) {
      setTimeout(() => compact(["n"], ["UInt8"], [[1]]), 1500).unref();
      return;
    }
    if (sql.includes("system.aggregate_function_combinators"))
      return compact(
        ["name"],
        ["String"],
        [["Array"], ["If"], ["State"], ["Merge"]],
      );
    if (sql.includes("system.functions"))
      return compact(
        ["name", "is_aggregate"],
        ["String", "UInt8"],
        [
          ["arrayJoin", 0],
          ["uniqExact", 1],
        ],
      );
    if (sql.includes("system.columns"))
      return compact(
        ["name", "type"],
        ["String", "String"],
        sql.includes("database='demo' AND table='sales'")
          ? [["customer_id", "UInt64"]]
          : [],
      );
    if (sql.includes("toUInt64"))
      return compact(
        ["exact", "n"],
        ["UInt64", "UInt8"],
        [["9007199254740993", 1]],
      );
    return compact(["n"], ["UInt8"], [[1]]);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
