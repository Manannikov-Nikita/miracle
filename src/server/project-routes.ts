import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ProjectStore, problem } from "./project-store.js";
import type { ProjectEvent } from "../shared/agents.js";

export function registerProjectRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  need: (req: FastifyRequest) => void,
) {
  const id = (req: FastifyRequest) =>
    z.uuid().parse((req.params as { id: string }).id);
  app.get("/api/project", async (req) => {
    need(req);
    return store.context;
  });
  app.get("/api/editor-documents", async (req) => {
    need(req);
    return store.editors();
  });
  app.post("/api/editor-documents", async (req, reply) => {
    need(req);
    const value = store.createEditor(req.body);
    reply.code(201);
    return value;
  });
  app.post("/api/editor-documents/import", async (req) => {
    need(req);
    return store.importEditors(req.body);
  });
  app.get("/api/editor-documents/:id", async (req) => {
    need(req);
    return store.editor(id(req));
  });
  app.patch("/api/editor-documents/:id", async (req) => {
    need(req);
    return store.updateEditor(id(req), req.body);
  });
  app.delete("/api/editor-documents/:id", async (req) => {
    need(req);
    return store.deleteEditor(id(req), req.body);
  });
  app.get("/api/agent-profiles", async (req) => {
    need(req);
    return store.profiles();
  });
  app.post("/api/agent-profiles", async (req, reply) => {
    need(req);
    const value = store.saveProfile(req.body);
    reply.code(201);
    return value;
  });
  app.patch("/api/agent-profiles/:id", async (req) => {
    need(req);
    return store.saveProfile(req.body, id(req));
  });
  app.delete("/api/agent-profiles/:id", async (req) => {
    need(req);
    return store.deleteProfile(id(req));
  });
  app.post("/api/agent-profiles/:id/trust", async (req) => {
    need(req);
    return store.trustProfile(id(req));
  });
  app.post("/api/agent-profiles/:id/validate", async (req) => {
    need(req);
    const profile = store.profile(id(req));
    if (!profile.trusted)
      throw problem(
        403,
        "Сначала подтвердите локальную настройку команды",
        "AGENT_PROFILE_UNTRUSTED",
      );
    const { validateAgentCommand } = await import("./agents/adapter.js");
    return validateAgentCommand(
      profile.provider,
      profile.command,
      store.context.projectRoot,
    );
  });
  app.get("/api/chats", async (req) => {
    need(req);
    return store.chats();
  });
  app.post("/api/chats", async (req, reply) => {
    need(req);
    const value = store.createChat(req.body);
    reply.code(201);
    return value;
  });
  app.get("/api/chats/:id", async (req) => {
    need(req);
    return store.conversation(id(req));
  });
  app.get("/api/agent-state", async (req) => {
    need(req);
    return { activeTurn: store.activeTurn() };
  });
  const streams = new Set<() => void>();
  app.get("/api/events", async (req, reply) => {
    need(req);
    let cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0)
      .parse((req.query as { after?: string }).after);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    const send = (event: ProjectEvent) => {
      if (closed || event.id <= cursor) return;
      cursor = event.id;
      if (
        !reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)
      )
        cleanup();
    };
    const timer = setInterval(() => {
      if (!closed) reply.raw.write(": heartbeat\n\n");
    }, 15000);
    timer.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      store.events.off("event", send);
      streams.delete(cleanup);
      reply.raw.end();
    };
    streams.add(cleanup);
    reply.raw.on("close", cleanup);
    store.events.on("event", send);
    // Subscribe before replay. Ordered IDs deduplicate live/replayed delivery.
    for (
      let batch = store.since(cursor);
      batch.length && !closed;
      batch = store.since(cursor)
    )
      for (const event of batch) send(event);
    if (!closed) reply.raw.write(": connected\n\n");
  });
  app.addHook("preClose", async () => {
    for (const close of [...streams]) close();
  });
}
