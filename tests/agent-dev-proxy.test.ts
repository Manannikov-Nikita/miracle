import { expect, it } from "vitest";
import { createServer } from "vite";
import { createServer as httpServer } from "node:http";
import config from "../vite.config.js";
it("forwards the local MCP endpoint through the development browser origin", async () => {
  const backend = httpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = 401;
    res.end(
      JSON.stringify({ path: req.url, error: "Invalid agent capability" }),
    );
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(backend.address() as any).port}`;
  const proxy = Object.fromEntries(
    Object.keys(config.server.proxy).map((path) => [path, target]),
  );
  const vite = await createServer({
    configFile: false,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0, proxy },
  });
  try {
    await vite.listen();
    const port = (vite.httpServer!.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/agent/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      path: "/agent/mcp",
      error: "Invalid agent capability",
    });
  } finally {
    await vite.close();
    await new Promise<void>((r) => backend.close(() => r()));
  }
});
