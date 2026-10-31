import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentManager } from "./manager.js";
import { callMiracleTool, miracleTools } from "./tools.js";

export function registerAgentRoutes(
  app: FastifyInstance,
  manager: AgentManager,
  need: (req: FastifyRequest) => void,
) {
  const id = (req: FastifyRequest) =>
    z.uuid().parse((req.params as { id: string }).id);
  app.post("/api/chats/:id/messages", async (req, reply) => {
    need(req);
    const turn = manager.start(id(req), req.body);
    reply.code(202);
    return turn;
  });
  app.post("/api/agent-turns/:id/cancel", async (req) => {
    need(req);
    return manager.cancel(id(req));
  });
  app.post("/api/agent-approvals/:id", async (req) => {
    need(req);
    return manager.respond(
      id(req),
      z.object({ decision: z.enum(["allow", "deny"]) }).parse(req.body)
        .decision,
    );
  });
  app.post("/agent/mcp", async (req, reply) => {
    const active = manager.authenticate(req.headers.authorization);
    const body = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(req.body);
    if (body.id === undefined) {
      reply.code(202);
      return reply.send();
    }
    const response = (result: unknown) => ({
      jsonrpc: "2.0",
      id: body.id,
      result,
    });
    switch (body.method) {
      case "initialize":
        return response({
          protocolVersion: [
            "2024-11-05",
            "2025-03-26",
            "2025-06-18",
            "2025-11-25",
          ].includes(String(body.params?.protocolVersion))
            ? body.params!.protocolVersion
            : "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "miracle", version: "1.0.0" },
          instructions:
            "Use tools to work with the current Miracle project. Never edit its internal database files.",
        });
      case "ping":
        return response({});
      case "tools/list":
        return response({ tools: miracleTools });
      case "tools/call": {
        try {
          const params = z
            .object({
              name: z.string(),
              arguments: z.record(z.string(), z.unknown()).optional(),
            })
            .parse(body.params);
          const value = await callMiracleTool(
            manager,
            active,
            params.name,
            params.arguments,
          );
          return response({
            content: [{ type: "text", text: JSON.stringify(value) }],
            isError: false,
          });
        } catch (error) {
          const e = error as Error & { code?: string };
          return response({
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: e.message, code: e.code }),
              },
            ],
            isError: true,
          });
        }
      }
      default:
        return {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32601, message: "Method not found" },
        };
    }
  });
  app.get("/agent/mcp", async (req, reply) => {
    manager.authenticate(req.headers.authorization);
    reply.header("Allow", "POST, DELETE").code(405);
    return { error: "Use stateless POST requests" };
  });
  app.delete("/agent/mcp", async (req, reply) => {
    manager.authenticate(req.headers.authorization);
    reply.code(204);
    return reply.send();
  });
  app.addHook("preClose", async () => {
    await manager.close();
  });
}
