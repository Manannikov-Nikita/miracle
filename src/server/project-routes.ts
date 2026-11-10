import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ProjectStore, problem } from "./project-store.js";
import {
  createProjectFile,
  createProjectDirectory,
  listProjectTree,
  moveProjectFile,
  readProjectFile,
  saveProjectFile,
  searchProjectFiles,
} from "./project-files.js";
import { MAX_PROJECT_FILE_BYTES } from "../shared/project-files.js";
import { assertProjectGitIdle } from "./project-git.js";

export function registerProjectRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  need: (req: FastifyRequest) => void,
) {
  const modelRequests = new Set<AbortController>();
  app.addHook("onClose", async () => {
    for (const controller of modelRequests) controller.abort();
  });
  const id = (req: FastifyRequest) =>
    z.uuid().parse((req.params as { id: string }).id);
  app.get("/api/project", async (req) => {
    need(req);
    return store.context;
  });
  app.get("/api/project/files", async (req) => {
    need(req);
    const { q } = z
      .object({ q: z.string().max(200).default("") })
      .parse(req.query);
    return searchProjectFiles(store.context, q);
  });
  app.get("/api/project/tree", async (req) => {
    need(req);
    const { path } = z
      .object({ path: z.string().max(4096).default("") })
      .parse(req.query);
    return listProjectTree(store.context, path);
  });
  app.get("/api/project/file", async (req) => {
    need(req);
    const { path } = z
      .object({ path: z.string().min(1).max(4096) })
      .parse(req.query);
    return readProjectFile(store.context, path);
  });
  app.post("/api/project/file", async (req, reply) => {
    need(req);
    assertProjectGitIdle(store.context);
    const input = z
      .object({ directory: z.string().max(4096), name: z.string().max(255) })
      .parse(req.body);
    const file = createProjectFile(store.context, input, (path) =>
      store.work.check([{ kind: "file", id: path }]),
    );
    reply.code(201);
    return file;
  });
  app.post("/api/project/directory", async (req, reply) => {
    need(req);
    assertProjectGitIdle(store.context);
    const input = z
      .object({ directory: z.string().max(4096), name: z.string().max(255) })
      .parse(req.body);
    const directory = createProjectDirectory(store.context, input, (path) =>
      store.work.check([{ kind: "file", id: path }]),
    );
    reply.code(201);
    return directory;
  });
  app.post("/api/project/file/move", async (req) => {
    need(req);
    assertProjectGitIdle(store.context);
    const input = z
      .object({
        path: z.string().min(1).max(4096),
        directory: z.string().max(4096),
      })
      .parse(req.body);
    return moveProjectFile(store.context, input, (from, to) =>
      store.work.check([
        { kind: "file", id: from },
        { kind: "file", id: to },
      ]),
    );
  });
  app.put(
    "/api/project/file",
    { bodyLimit: MAX_PROJECT_FILE_BYTES * 6 + 1024 },
    async (req) => {
      need(req);
      assertProjectGitIdle(store.context);
      const { path } = z
        .object({ path: z.string().min(1).max(4096) })
        .parse(req.query);
      const input = z
        .object({
          content: z.string().max(MAX_PROJECT_FILE_BYTES),
          baseRevision: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .parse(req.body);
      store.work.check([{ kind: "file", id: path }]);
      return saveProjectFile(store.context, path, input);
    },
  );
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
  // One valid legacy SQL draft can contain 1M characters, or up to 6M bytes
  // after JSON escaping. Keep this exception confined to the migration route.
  app.post(
    "/api/editor-documents/import",
    { bodyLimit: 8 * 1024 * 1024 },
    async (req) => {
      need(req);
      return store.importEditors(req.body);
    },
  );
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
  app.get("/api/agent-profiles/:id/models", async (req, reply) => {
    need(req);
    const profile = store.profile(id(req));
    if (!profile.trusted)
      throw problem(
        403,
        "Сначала подтвердите локальную настройку команды",
        "AGENT_PROFILE_UNTRUSTED",
      );
    if (modelRequests.size >= 4)
      throw problem(
        429,
        "Список моделей уже загружается. Повторите через несколько секунд",
        "AGENT_MODELS_BUSY",
      );
    const controller = new AbortController();
    modelRequests.add(controller);
    const abort = () => controller.abort();
    req.raw.on("aborted", abort);
    reply.raw.on("close", abort);
    reply.header("Cache-Control", "no-store");
    try {
      const discover =
        profile.provider === "codex"
          ? (await import("./agents/codex-models.js")).discoverCodexModels
          : (await import("./agents/claude-models.js")).discoverClaudeModels;
      const catalog = await discover(
        profile.command,
        store.context.projectRoot,
        controller.signal,
      );
      const current = store.profile(profile.id);
      if (
        !current.trusted ||
        current.command !== profile.command ||
        current.provider !== profile.provider
      )
        throw problem(
          409,
          "Профиль изменился. Обновите список моделей",
          "AGENT_PROFILE_CHANGED",
        );
      return catalog;
    } finally {
      req.raw.off("aborted", abort);
      reply.raw.off("close", abort);
      modelRequests.delete(controller);
    }
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
  app.get("/api/agent-work", async (req) => {
    need(req);
    return store.work.snapshot();
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
    let closed = false,
      blocked = false,
      flushing = false;
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    const write = (frame: string) => {
      // false means the frame was accepted, but subsequent writes must wait.
      if (!reply.raw.write(frame)) {
        blocked = true;
        drainTimeout = setTimeout(cleanup, 60000);
        drainTimeout.unref();
      }
    };
    const flush = () => {
      if (closed || blocked || flushing) return;
      flushing = true;
      try {
        while (!closed && !blocked) {
          // The durable log is the queue: retain no live payloads while blocked.
          const batch = store.since(cursor, 64);
          if (!batch.length) break;
          for (const event of batch) {
            if (closed || blocked) break;
            cursor = event.id;
            write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          }
        }
      } catch (error) {
        req.log.error({ err: error }, "Unable to stream project events");
        cleanup();
      } finally {
        flushing = false;
      }
    };
    const drained = () => {
      clearTimeout(drainTimeout);
      drainTimeout = undefined;
      blocked = false;
      flush();
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      clearTimeout(drainTimeout);
      store.events.off("event", flush);
      reply.raw.off("drain", drained);
      reply.raw.off("close", cleanup);
      streams.delete(cleanup);
      // Ending a blocked response can wait forever for its non-reading peer.
      reply.raw.destroy();
    };
    const timer = setInterval(() => {
      if (!closed && !blocked) write(": heartbeat\n\n");
    }, 15000);
    timer.unref();
    streams.add(cleanup);
    reply.raw.on("drain", drained);
    reply.raw.on("close", cleanup);
    reply.raw.once("error", cleanup);
    // Subscribe before replay; both live and historical delivery use the same cursor.
    store.events.on("event", flush);
    write(": connected\n\n");
    flush();
  });
  app.addHook("preClose", async () => {
    for (const close of [...streams]) close();
  });
}
