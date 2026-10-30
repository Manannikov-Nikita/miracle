import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import {
  Database,
  migrate,
  retention,
  WORKSPACE_SCHEMA_VERSION,
} from "./db.js";
import { loadKey, SecretBox, verifyEncryptionKey } from "./secrets.js";
import { resolveDataDir, resolvePort } from "./config.js";
import {
  mergeClickHouseOptions,
  publicClickHouseOptions,
  validateClickHouseConnection,
} from "./clickhouseOptions.js";
import { assertReadOnly } from "./sql.js";
import { registerMetadataRoutes } from "./metadata.js";
import {
  prepareDateBatch,
  performDateBatch,
  interruptQueryRuns,
} from "./date-batch.js";
import {
  executeEngine,
  engineMetadata,
  validateConnectionUrl,
  quoteIdentifier,
  quoteLiteral,
  type EngineConnection,
} from "./connectors.js";
import {
  sourceSchema,
  connectionSchema,
  boardDocumentSchema,
} from "./validation.js";
import type {
  QuerySource,
  QueryRun,
  ResultSet,
  BoardDocument,
  SqlFunctionCatalog,
} from "../shared/types.js";
export interface Limits {
  timeoutMs: number;
  maxRows: number;
  maxBytes: number;
  maxGlobalRuns: number;
  quotaBytes: number;
}
export interface AppOptions {
  dataDir?: string;
  controlToken?: string;
  onShutdown?: () => void;
  encryptionKey?: Buffer;
  appOrigin?: string;
  cookieSecure?: boolean;
  limits?: Partial<Limits>;
  serveStatic?: boolean;
  logger?: boolean;
}
declare module "fastify" {
  interface FastifyInstance {
    miracle: {
      db: Database;
      closeRuns: () => Promise<void>;
    };
  }
  interface FastifyRequest {
    sessionId: string | null;
    csrfToken: string | null;
  }
}
const err = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { statusCode: status, code });
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const resultDto = (r: any): ResultSet => ({
  id: r.id,
  columns: r.columns,
  rowCount: r.row_count,
  byteCount: Number(r.byte_count),
  createdAt: new Date(r.created_at).toISOString(),
  source: r.source,
});
const runDto = (r: any): QueryRun => ({
  id: r.id,
  status: r.status,
  source: r.source,
  resultSetId: r.result_set_id || undefined,
  error: r.error || undefined,
  startedAt: new Date(r.started_at).toISOString(),
  finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : undefined,
  rowCount: r.row_count ?? undefined,
  elapsedMs: r.elapsed_ms ?? undefined,
  batch: r.batch ?? undefined,
});
const boardDto = (r: any) => ({
  id: r.id,
  name: r.name,
  revision: r.revision,
  document: r.document,
  updatedAt: new Date(r.updated_at).toISOString(),
});
const queryDto = (r: any) => ({
  id: r.id,
  name: r.name,
  revision: r.revision,
  ...r.source,
  updatedAt: new Date(r.updated_at).toISOString(),
});
const nameSchema = z.string().trim().min(1).max(200);
export async function buildApp(
  options: AppOptions = {},
): Promise<FastifyInstance> {
  // Fail configuration before constructing SQLite or generating the workspace key.
  options = z
    .object({
      dataDir: z.string().min(1).optional(),
      controlToken: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[\x21-\x7e]+$/)
        .optional(),
      onShutdown: z
        .custom<() => void>((value) => typeof value === "function")
        .optional(),
      encryptionKey: z
        .instanceof(Buffer)
        .refine(
          (value) => value.length === 32,
          "Workspace encryption key must contain exactly 32 bytes",
        )
        .optional(),
      appOrigin: z.string().min(1).optional(),
      cookieSecure: z.boolean().optional(),
      limits: z
        .object({
          timeoutMs: z.number().int().positive().optional(),
          maxRows: z.number().int().positive().optional(),
          maxBytes: z.number().int().positive().optional(),
          maxGlobalRuns: z.number().int().positive().optional(),
          quotaBytes: z.number().int().positive().optional(),
        })
        .optional(),
      serveStatic: z.boolean().optional(),
      logger: z.boolean().optional(),
    })
    .parse(options);
  const port = resolvePort();
  const dataDir = options.dataDir || resolveDataDir();
  const configuredOrigin =
    options.appOrigin || process.env.APP_ORIGIN || `http://127.0.0.1:${port}`;
  const originUrl = new URL(configuredOrigin);
  if (
    !["http:", "https:"].includes(originUrl.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(originUrl.hostname) ||
    originUrl.username ||
    originUrl.password ||
    originUrl.pathname !== "/" ||
    originUrl.search ||
    originUrl.hash
  )
    throw new Error(
      "APP_ORIGIN must be an HTTP(S) loopback origin without credentials, path, query or fragment",
    );
  const appOrigin = originUrl.origin;
  const expectedHost = originUrl.host;
  const secure = options.cookieSecure ?? originUrl.protocol === "https:";
  const envNum = (name: string, fallback: number) => {
    const value = Number(process.env[name] || fallback);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  const limits: Limits = {
    timeoutMs: envNum("QUERY_TIMEOUT_MS", 120000),
    maxRows: envNum("MAX_RESULT_ROWS", 50000),
    maxBytes: envNum("MAX_RESULT_BYTES", 20 * 1024 * 1024),
    maxGlobalRuns: 2,
    quotaBytes: envNum("RESULT_QUOTA_BYTES", 2 * 1024 ** 3),
    ...options.limits,
  };
  limits.maxGlobalRuns = Math.min(2, limits.maxGlobalRuns);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });
  const initialFiles = existsSync(dataDir) ? readdirSync(dataDir) : [];
  // The exclusive connection owns even interrupted initialization recovery.
  const db = new Database(dataDir);
  try {
    const schemaVersion = Number(
      db.sqlite.prepare("PRAGMA user_version").get()!.user_version,
    );
    const isNew =
      initialFiles.every((name) =>
        [
          "miracle.sqlite",
          "miracle.sqlite-wal",
          "miracle.sqlite-shm",
          "miracle.sqlite-journal",
          "encryption.key",
          ".encryption.key.pending",
        ].includes(name),
      ) &&
      schemaVersion === 0 &&
      db.sqlite
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        )
        .all().length === 0;
    // Reject incomplete or unsupported schemas before accessing their settings.
    if (
      schemaVersion > WORKSPACE_SCHEMA_VERSION ||
      (!isNew && schemaVersion === 0)
    )
      migrate(db);
    const box = new SecretBox(loadKey(dataDir, isNew, options.encryptionKey));
    // A schema is established only together with its UUID and authenticated key.
    if (!isNew) verifyEncryptionKey(db, box);
    migrate(db, isNew ? () => verifyEncryptionKey(db, box, true) : undefined);
    verifyEncryptionKey(db, box);
    const workspaceId = db.query(
      "SELECT value FROM app_settings WHERE key='workspace_id'",
    ).rows[0].value as string;
    interruptQueryRuns(db);
    retention(db);
    await app.register(cookie);
    app.decorateRequest("sessionId", null);
    app.decorateRequest("csrfToken", null);
    // Tabs share a host-only cookie. Bootstrap must return one matching pair,
    // even when several tabs reconnect before either Set-Cookie is applied.
    let browserSession:
      { token: string; id: string; csrf: string; expires: number } | undefined;
    const live = new Map<
      string,
      {
        controller: AbortController;
        cancel?: () => Promise<void>;
        promise?: Promise<void>;
      }
    >();
    app.setErrorHandler((e: any, _req, reply) => {
      if (e instanceof z.ZodError)
        return reply
          .code(400)
          .send({ error: e.issues[0]?.message || "Некорректные данные" });
      if (e.errcode === 2067 || e.errcode === 1555)
        return reply
          .code(409)
          .send({ error: "Запись уже существует", code: "CONFLICT" });
      if (e.errcode === 787)
        return reply
          .code(409)
          .send({ error: "Ссылка на отсутствующий или используемый объект" });
      const status = e.statusCode || 500;
      if (status >= 500) app.log.error(e);
      return reply.code(status).send({
        error: status >= 500 ? "Внутренняя ошибка сервера" : e.message,
        code: typeof e.code === "string" ? e.code : undefined,
      });
    });
    app.addHook("onRequest", async (req, reply) => {
      if (req.headers.host !== expectedHost)
        throw err(403, "Недопустимый Host");
      if (req.headers.origin && req.headers.origin !== appOrigin)
        throw err(403, "Недопустимый Origin");
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw err(403, "Недопустимый источник запроса");
      if (!req.url.startsWith("/api/")) return;
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      const path = req.url.split("?")[0];
      if (path === "/api/local/control" || path === "/api/health") return;
      // Removed account routes remain absent, including for callers without a session.
      if (/^\/api\/(auth|setup|users)(\/|$)/.test(path!))
        return reply.code(404).send({ error: "Маршрут не найден" });
      const sid = req.cookies.miracle_session;
      if (
        sid &&
        browserSession &&
        browserSession.expires > Date.now() &&
        digest(sid) === browserSession.id
      ) {
        req.sessionId = browserSession.id;
        req.csrfToken = browserSession.csrf;
      }
      if (path === "/api/session" && req.method === "GET") return;
      if (!req.sessionId)
        throw err(401, "Локальная сессия завершена", "LOCAL_SESSION_EXPIRED");
      const requestedWorkspace = req.headers["x-miracle-workspace"];
      if (
        requestedWorkspace !== undefined &&
        requestedWorkspace !== workspaceId
      )
        throw err(
          409,
          "Рабочая область изменилась. Перезагрузите страницу",
          "WORKSPACE_CHANGED",
        );
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        const token = req.headers["x-csrf-token"];
        if (
          typeof token !== "string" ||
          !req.csrfToken ||
          Buffer.byteLength(token) !== Buffer.byteLength(req.csrfToken) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(req.csrfToken))
        )
          throw err(
            403,
            "Недопустимый CSRF токен",
            typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)
              ? "LOCAL_SESSION_STALE"
              : undefined,
          );
      }
    });
    const need = (req: FastifyRequest) => {
      if (!req.sessionId)
        throw err(401, "Локальная сессия завершена", "LOCAL_SESSION_EXPIRED");
    };
    const uuid = (req: FastifyRequest, key = "id") =>
      z.uuid().parse((req.params as any)[key]);
    app.get("/api/health", async () => ({ ok: true }));
    app.get("/api/session", async (_req, reply) => {
      if (!browserSession || browserSession.expires <= Date.now()) {
        const token = randomBytes(32).toString("base64url");
        browserSession = {
          token,
          id: digest(token),
          csrf: randomBytes(32).toString("base64url"),
          expires: Date.now() + 604800000,
        };
      }
      // Read the current pair here, rather than a hook's earlier TTL snapshot.
      reply.setCookie("miracle_session", browserSession.token, {
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/",
        maxAge: Math.max(
          1,
          Math.ceil((browserSession.expires - Date.now()) / 1000),
        ),
      });
      return { workspaceId, csrfToken: browserSession.csrf };
    });
    app.post("/api/local/control", async (req, reply) => {
      const authorization = req.headers.authorization;
      const expected = options.controlToken
        ? `Bearer ${options.controlToken}`
        : "";
      if (
        !expected ||
        !authorization ||
        Buffer.byteLength(expected) !== Buffer.byteLength(authorization) ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(authorization))
      )
        throw err(401, "Invalid instance token");
      const { action } = z
        .object({ action: z.enum(["status", "stop"]) })
        .parse(req.body);
      if (action === "stop")
        reply.raw.once("finish", () => {
          setImmediate(() => {
            void app
              .close()
              .then(() => options.onShutdown?.())
              .catch((error) => app.log.error(error));
          });
        });
      return { ok: true };
    });
    function savedClickHouseOptions(r: any) {
      return r.clickhouse_options_encrypted
        ? JSON.parse(box.decrypt(r.clickhouse_options_encrypted))
        : undefined;
    }
    function connectionDto(r: any) {
      return {
        id: r.id,
        name: r.name,
        engine: r.engine,
        url: r.url,
        username: r.username,
        database: r.database_name || undefined,
        catalog: r.catalog || undefined,
        schema: r.schema_name || undefined,
        hasPassword: !!r.password_encrypted,
        clickhouse: publicClickHouseOptions(savedClickHouseOptions(r)),
        createdAt: new Date(r.created_at).toISOString(),
      };
    }
    async function connection(id: string): Promise<EngineConnection> {
      const r = db.query("SELECT * FROM connections WHERE id=?1", [id]).rows[0];
      if (!r) throw err(404, "Подключение не найдено");
      return {
        ...connectionDto(r),
        password: r.password_encrypted ? box.decrypt(r.password_encrypted) : "",
        clickhouse: savedClickHouseOptions(r),
      };
    }
    app.get("/api/connections", async (req) => {
      need(req);
      return db
        .query("SELECT * FROM connections ORDER BY created_at")
        .rows.map(connectionDto);
    });
    function validateConnection(input: unknown): EngineConnection {
      const b = connectionSchema.parse(input);
      try {
        b.url = validateConnectionUrl(b.url);
        validateClickHouseConnection(b);
      } catch (e: any) {
        throw err(400, e.message);
      }
      return {
        ...b,
        password: b.password || "",
        clickhouse: b.clickhouse || undefined,
      };
    }
    function mergedConnection(
      old: EngineConnection,
      patch: z.infer<ReturnType<typeof connectionSchema.partial>>,
    ) {
      // Public DTO flags never participate in merging: only decrypted saved options do.
      return validateConnection({
        name: patch.name ?? old.name,
        engine: patch.engine ?? old.engine,
        url: patch.url ?? old.url,
        username: patch.username ?? old.username,
        password: patch.password ?? old.password,
        database: patch.database ?? old.database,
        catalog: patch.catalog ?? old.catalog,
        schema: patch.schema ?? old.schema,
        clickhouse: mergeClickHouseOptions(old.clickhouse, patch.clickhouse),
      });
    }
    const encryptedOptions = (c: EngineConnection) =>
      c.clickhouse ? box.encrypt(JSON.stringify(c.clickhouse)) : null;
    app.post("/api/connections", async (req, reply) => {
      need(req);
      const b = validateConnection(req.body);
      const r = db.query(
        "INSERT INTO connections(id,name,engine,url,username,password_encrypted,database_name,catalog,schema_name,clickhouse_options_encrypted) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) RETURNING *",
        [
          randomUUID(),
          b.name,
          b.engine,
          b.url,
          b.username,
          b.password ? box.encrypt(b.password) : "",
          b.database,
          b.catalog,
          b.schema,
          encryptedOptions(b),
        ],
      ).rows[0];
      reply.code(201);
      return connectionDto(r);
    });
    app.patch("/api/connections/:id", async (req) => {
      need(req);
      const id = uuid(req);
      const patch = connectionSchema.partial().parse(req.body);
      const b = mergedConnection(await connection(id), patch);
      const r = db.query(
        "UPDATE connections SET name=?2,engine=?3,url=?4,username=?5,password_encrypted=?6,database_name=?7,catalog=?8,schema_name=?9,clickhouse_options_encrypted=?10 WHERE id=?1 RETURNING *",
        [
          id,
          b.name,
          b.engine,
          b.url,
          b.username,
          b.password ? box.encrypt(b.password) : "",
          b.database,
          b.catalog,
          b.schema,
          encryptedOptions(b),
        ],
      ).rows[0];
      return connectionDto(r);
    });
    app.post("/api/connections/test", async (req) => {
      need(req);
      const body = connectionSchema
        .extend({ id: z.uuid().optional() })
        .parse(req.body);
      const { id, ...input } = body;
      const c = id
        ? mergedConnection(await connection(id), input)
        : validateConnection(input);
      try {
        const result = await engineMetadata(c, "SELECT version()");
        return { ok: true, version: String(result.rows[0]?.[0] || "") };
      } catch (e: any) {
        throw err(400, e.message);
      }
    });
    app.delete("/api/connections/:id", async (req) => {
      need(req);
      if (
        !db.query("DELETE FROM connections WHERE id=?1", [uuid(req)]).rowCount
      )
        throw err(404, "Подключение не найдено");
      return { ok: true };
    });
    app.post("/api/connections/:id/test", async (req) => {
      need(req);
      const c = await connection(uuid(req));
      try {
        const r = await engineMetadata(c, "SELECT version()");
        return { ok: true, version: String(r.rows[0]?.[0] || "") };
      } catch (e: any) {
        throw err(400, e.message);
      }
    });
    registerMetadataRoutes(app, { need, connection });
    app.get("/api/connections/:id/schema", async (req) => {
      need(req);
      const c = await connection(uuid(req));
      try {
        const sql =
          c.engine === "clickhouse"
            ? "SELECT database, name FROM system.tables WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') ORDER BY database,name"
            : `SELECT table_catalog,table_schema,table_name FROM ${c.catalog ? quoteIdentifier(c.catalog) + "." : ""}information_schema.tables ORDER BY table_schema,table_name`;
        const r = await engineMetadata(c, sql);
        return r.rows.map((row) =>
          c.engine === "clickhouse"
            ? { schema: String(row[0]), name: String(row[1]) }
            : {
                catalog: String(row[0]),
                schema: String(row[1]),
                name: String(row[2]),
              },
        );
      } catch (e: any) {
        throw err(400, e.message);
      }
    });
    app.get("/api/connections/:id/columns", async (req) => {
      need(req);
      const c = await connection(uuid(req));
      const q = z
        .object({
          schema: z.string().max(200),
          table: z.string().max(200),
          catalog: z.string().max(200).optional(),
        })
        .parse(req.query);
      try {
        const sql =
          c.engine === "clickhouse"
            ? `SELECT name,type FROM system.columns WHERE database=${quoteLiteral(q.schema, c.engine)} AND table=${quoteLiteral(q.table, c.engine)} ORDER BY position`
            : `SELECT column_name,data_type FROM ${q.catalog || c.catalog ? quoteIdentifier(q.catalog || c.catalog!) + "." : ""}information_schema.columns WHERE table_schema=${quoteLiteral(q.schema, c.engine)} AND table_name=${quoteLiteral(q.table, c.engine)} ORDER BY ordinal_position`;
        const r = await engineMetadata(c, sql);
        return r.rows.map((row) => ({
          name: String(row[0]),
          type: String(row[1]),
        }));
      } catch (e: any) {
        throw err(400, e.message);
      }
    });
    app.get(
      "/api/connections/:id/functions",
      async (req): Promise<SqlFunctionCatalog> => {
        need(req);
        const c = await connection(uuid(req));
        if (c.engine !== "clickhouse")
          return { functions: [], aggregateCombinators: [] };
        try {
          // These columns are available in older ClickHouse versions as well.
          // Generated combinations are not individual rows in system.functions.
          const [functions, combinators] = await Promise.all([
            engineMetadata(
              c,
              "SELECT name, is_aggregate FROM system.functions ORDER BY name",
            ),
            engineMetadata(
              c,
              "SELECT name FROM system.aggregate_function_combinators WHERE is_internal = 0 ORDER BY name",
            ),
          ]);
          return {
            functions: functions.rows.map((row) => ({
              name: String(row[0]),
              isAggregate: Number(row[1]) === 1,
            })),
            aggregateCombinators: combinators.rows.map((row) => String(row[0])),
          };
        } catch (e: any) {
          throw err(400, e.message);
        }
      },
    );
    app.get("/api/queries", async (req) => {
      need(req);
      return db
        .query("SELECT * FROM queries ORDER BY updated_at DESC")
        .rows.map(queryDto);
    });
    app.post("/api/queries", async (req, reply) => {
      need(req);
      const b = sourceSchema.extend({ name: nameSchema }).parse(req.body);
      const { name, ...source } = b;
      await connection(source.connectionId);
      const r = db.query(
        "INSERT INTO queries(id,name,source) VALUES(?1,?2,?3) RETURNING *",
        [randomUUID(), name, source],
      ).rows[0];
      reply.code(201);
      return queryDto(r);
    });
    app.patch("/api/queries/:id", async (req) => {
      need(req);
      const id = uuid(req);
      const b = sourceSchema
        .extend({
          name: nameSchema,
          baseRevision: z.number().int().nonnegative(),
        })
        .parse(req.body);
      const { name, baseRevision, ...source } = b;
      await connection(source.connectionId);
      const r = db.query(
        "UPDATE queries SET name=?2,source=?3,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND revision=?4 RETURNING *",
        [id, name, source, baseRevision],
      ).rows[0];
      if (!r)
        throw err(
          409,
          "Запрос изменён в другой вкладке. Перезагрузите или сохраните копию",
          "REVISION_CONFLICT",
        );
      return queryDto(r);
    });
    app.delete("/api/queries/:id", async (req) => {
      need(req);
      if (!db.query("DELETE FROM queries WHERE id=?1", [uuid(req)]).rowCount)
        throw err(404, "Запрос не найден");
      return { ok: true };
    });
    async function startRun(req: FastifyRequest, source: QuerySource) {
      need(req);
      const engine = await connection(source.connectionId);
      let batch;
      try {
        batch = prepareDateBatch(source, engine);
      } catch (e: any) {
        throw err(400, e.message);
      }
      const id = randomUUID();
      const c = db;
      let created;
      try {
        c.query("BEGIN");
        const r = c.query(
          "SELECT id FROM query_runs WHERE status IN ('running','cancelling')",
        );
        if (r.rows.length >= limits.maxGlobalRuns)
          throw err(429, "Достигнут лимит одновременных запросов");
        created = c.query(
          "INSERT INTO query_runs(id,status,source,batch) VALUES(?1,'running',?2,?3) RETURNING *",
          [id, source, batch],
        ).rows[0];
        c.query("COMMIT");
      } catch (e) {
        c.query("ROLLBACK");
        throw e;
      }
      const state: {
        controller: AbortController;
        cancel?: () => Promise<void>;
        promise?: Promise<void>;
      } = { controller: new AbortController() };
      live.set(id, state);
      state.promise = batch
        ? performDateBatch({ db, id, engine, source, state, batch, limits })
            .catch((error) => app.log.error(error))
            .finally(() => {
              live.delete(id);
            })
        : performRun(id, engine, source, state);
      return runDto(created);
    }
    async function performRun(
      id: string,
      engine: EngineConnection,
      source: QuerySource,
      state: {
        controller: AbortController;
        cancel?: () => Promise<void>;
      },
    ) {
      const started = Date.now();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        state.controller.abort();
        void state.cancel?.().catch(() => {});
      }, limits.timeoutMs);
      try {
        const output = await executeEngine(
          engine,
          source,
          id,
          limits,
          state.controller.signal,
          (fn) => {
            state.cancel = fn;
          },
        );
        if (state.controller.signal.aborted) throw new Error("Запрос отменён");
        const resultId = randomUUID();
        const c = db;
        try {
          c.query("BEGIN");
          const run = c.query("SELECT status FROM query_runs WHERE id=?1", [id])
            .rows[0];
          if (run?.status !== "running" || state.controller.signal.aborted)
            throw new Error("Запрос отменён");
          const total = Number(
            c.query("SELECT COALESCE(sum(byte_count),0) size FROM result_sets")
              .rows[0].size,
          );
          if (total + output.byteCount > limits.quotaBytes)
            throw new Error(
              "Квота хранения результатов исчерпана. Удалите ненужные доски или дождитесь очистки истории",
            );
          c.query(
            "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES(?1,?2,?3,?4,?5)",
            [
              resultId,
              JSON.stringify(output.columns),
              output.rows.length,
              output.byteCount,
              source,
            ],
          );
          for (let i = 0; i < output.rows.length; i += 500)
            c.query(
              "INSERT INTO result_chunks(result_set_id,chunk_index,rows) VALUES(?1,?2,?3)",
              [
                resultId,
                i / 500,
                JSON.stringify(output.rows.slice(i, i + 500)),
              ],
            );
          c.query(
            "UPDATE query_runs SET status='completed',result_set_id=?2,row_count=?3,elapsed_ms=?4,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
            [id, resultId, output.rows.length, Date.now() - started],
          );
          c.query("COMMIT");
        } catch (e) {
          c.query("ROLLBACK");
          throw e;
        }
      } catch (e: any) {
        await state.cancel?.().catch(() => {});
        const cancelled = state.controller.signal.aborted && !timedOut;
        let message = timedOut
          ? "Превышено время выполнения запроса"
          : cancelled
            ? "Запрос отменён"
            : String(e.message || "Ошибка запроса").slice(0, 4000);
        if (engine.password)
          message = message.replaceAll(engine.password, "[скрыто]");
        db.query(
          "UPDATE query_runs SET status=?2,error=?3,elapsed_ms=?4,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
          [
            id,
            cancelled ? "cancelled" : "failed",
            message,
            Date.now() - started,
          ],
        );
      } finally {
        clearTimeout(timer);
        live.delete(id);
      }
    }
    app.post("/api/query-runs", async (req, reply) => {
      const r = await startRun(req, sourceSchema.parse(req.body));
      reply.code(202);
      return r;
    });
    app.get("/api/query-runs", async (req) => {
      need(req);
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .parse((req.query as any).limit);
      return db
        .query("SELECT * FROM query_runs ORDER BY started_at DESC LIMIT ?1", [
          limit,
        ])
        .rows.map(runDto);
    });
    app.get("/api/query-runs/:id", async (req) => {
      need(req);
      const r = db.query("SELECT * FROM query_runs WHERE id=?1", [uuid(req)])
        .rows[0];
      if (!r) throw err(404, "Выполнение не найдено");
      return runDto(r);
    });
    app.post("/api/query-runs/:id/cancel", async (req) => {
      need(req);
      const id = uuid(req);
      const r = db.query("SELECT * FROM query_runs WHERE id=?1", [id]).rows[0];
      if (!r) throw err(404, "Выполнение не найдено");
      const state = live.get(id);
      if (state) {
        db.query(
          "UPDATE query_runs SET status='cancelling' WHERE id=?1 AND status='running'",
          [id],
        );
        state.controller.abort();
        void state.cancel?.().catch(() => {});
      }
      return runDto(
        db.query("SELECT * FROM query_runs WHERE id=?1", [id]).rows[0],
      );
    });
    async function getResult(id: string) {
      const r = db.query("SELECT * FROM result_sets WHERE id=?1", [id]).rows[0];
      if (!r) throw err(404, "Результат не найден или срок хранения истёк");
      return resultDto(r);
    }
    async function rows(id: string, offset: number, limit: number) {
      const chunks = db.query(
        "SELECT rows FROM result_chunks WHERE result_set_id=?1 AND chunk_index >= ?2 AND chunk_index <= ?3 ORDER BY chunk_index",
        [id, Math.floor(offset / 500), Math.floor((offset + limit - 1) / 500)],
      ).rows;
      return chunks
        .flatMap((c) => c.rows)
        .slice(offset % 500, (offset % 500) + limit);
    }
    app.get("/api/result-sets/:id", async (req) => {
      need(req);
      return getResult(uuid(req));
    });
    app.get("/api/result-sets/:id/rows", async (req) => {
      need(req);
      const id = uuid(req);
      const q = z
        .object({
          offset: z.coerce
            .number()
            .int()
            .nonnegative()
            .max(100000000)
            .default(0),
          limit: z.coerce.number().int().min(1).max(5000).default(500),
        })
        .parse(req.query);
      const result = await getResult(id);
      return {
        result,
        rows: await rows(id, q.offset, q.limit),
        offset: q.offset,
        total: result.rowCount,
      };
    });
    app.get("/api/result-sets/:id/chart", async (req) => {
      need(req);
      const id = uuid(req);
      const result = await getResult(id);
      if (result.rowCount > 5000)
        throw err(
          422,
          "Для графика допустимо не более 5000 точек. Агрегируйте данные в SQL",
        );
      return {
        result,
        rows: result.rowCount ? await rows(id, 0, result.rowCount) : [],
      };
    });
    app.get("/api/result-sets/:id/table", async (req) => {
      need(req);
      const id = uuid(req);
      const result = await getResult(id);
      if (
        result.rowCount > 50000 ||
        result.byteCount > 20 * 1024 * 1024 ||
        result.rowCount * result.columns.length > 1000000
      )
        throw err(
          422,
          "Для преобразований таблицы допустимы 50 000 строк, 20 MiB и 1 000 000 ячеек. Сократите результат в SQL.",
        );
      const data = result.rowCount ? await rows(id, 0, result.rowCount) : [];
      if (data.length !== result.rowCount)
        throw err(
          422,
          "Снимок неполный. Повторите исходный SQL перед преобразованием таблицы.",
        );
      return { result, rows: data };
    });
    function saveRefs(c: any, id: string, document: BoardDocument) {
      const ids = [
        ...new Set(
          document.nodes.flatMap((n) =>
            n.data.resultSetId ? [n.data.resultSetId] : [],
          ),
        ),
      ];
      c.query("DELETE FROM board_result_refs WHERE board_id=?1", [id]);
      for (const resultId of ids) {
        const r = c.query("SELECT id,row_count FROM result_sets WHERE id=?1", [
          resultId,
        ]).rows[0];
        if (!r) throw err(400, "Результат блока не найден");
        if (
          c.query(
            "SELECT id FROM query_runs WHERE result_set_id=?1 AND status IN ('running','cancelling')",
            [resultId],
          ).rowCount
        )
          throw err(
            409,
            "Дождитесь завершения или остановите пакет перед добавлением результата на доску",
          );
        if (
          document.nodes.some(
            (n) => n.data.resultSetId === resultId && n.data.view === "chart",
          ) &&
          r.row_count > 5000
        )
          throw err(422, "График превышает лимит 5000 точек");
        c.query(
          "INSERT INTO board_result_refs(board_id,result_set_id) VALUES(?1,?2)",
          [id, resultId],
        );
      }
    }
    app.get("/api/boards", async (req) => {
      need(req);
      return db
        .query(
          "SELECT id,name,revision,updated_at FROM boards ORDER BY updated_at DESC",
        )
        .rows.map((r) => ({
          id: r.id,
          name: r.name,
          revision: r.revision,
          updatedAt: new Date(r.updated_at).toISOString(),
        }));
    });
    app.get("/api/boards/:id", async (req) => {
      need(req);
      const r = db.query("SELECT * FROM boards WHERE id=?1", [uuid(req)])
        .rows[0];
      if (!r) throw err(404, "Доска не найдена");
      return boardDto(r);
    });
    app.post("/api/boards", async (req, reply) => {
      need(req);
      const b = z
        .object({
          name: nameSchema,
          document: boardDocumentSchema.default({
            schemaVersion: 1,
            nodes: [],
            edges: [],
          }),
        })
        .parse(req.body);
      const id = randomUUID();
      const c = db;
      try {
        c.query("BEGIN");
        const r = c.query(
          "INSERT INTO boards(id,name,document) VALUES(?1,?2,?3) RETURNING *",
          [id, b.name, b.document],
        ).rows[0];
        saveRefs(c, id, b.document);
        c.query("COMMIT");
        reply.code(201);
        return boardDto(r);
      } catch (e) {
        c.query("ROLLBACK");
        throw e;
      }
    });
    app.patch("/api/boards/:id", async (req) => {
      need(req);
      const id = uuid(req);
      const b = z
        .object({
          baseRevision: z.number().int().nonnegative(),
          name: nameSchema.optional(),
          document: boardDocumentSchema,
        })
        .parse(req.body);
      const c = db;
      try {
        c.query("BEGIN");
        const r = c.query(
          "UPDATE boards SET name=COALESCE(?2,name),document=?3,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND revision=?4 RETURNING *",
          [id, b.name, b.document, b.baseRevision],
        ).rows[0];
        if (!r)
          throw err(
            409,
            "Доска изменена в другой вкладке. Перезагрузите или сохраните копию",
            "REVISION_CONFLICT",
          );
        saveRefs(c, id, b.document);
        c.query("COMMIT");
        return boardDto(r);
      } catch (e) {
        c.query("ROLLBACK");
        throw e;
      }
    });
    app.delete("/api/boards/:id", async (req) => {
      need(req);
      if (!db.query("DELETE FROM boards WHERE id=?1", [uuid(req)]).rowCount)
        throw err(404, "Доска не найдена");
      return { ok: true };
    });
    app.post("/api/boards/:id/nodes/:nodeId/refresh", async (req, reply) => {
      need(req);
      const id = uuid(req);
      const nodeId = z
        .string()
        .max(200)
        .parse((req.params as any).nodeId);
      const b = z
        .object({ sourceRevision: z.number().int().nonnegative() })
        .parse(req.body);
      const board = db.query("SELECT document FROM boards WHERE id=?1", [id])
        .rows[0];
      if (!board) throw err(404, "Доска не найдена");
      const node = (board.document as BoardDocument).nodes.find(
        (n) => n.id === nodeId,
      );
      if (!node?.data.source) throw err(400, "У блока нет источника SQL");
      if ((node.data.sourceRevision ?? 0) !== b.sourceRevision)
        throw err(
          409,
          "Источник изменён. Перезагрузите доску",
          "REVISION_CONFLICT",
        );
      const r = await startRun(req, node.data.source);
      reply.code(202);
      return r;
    });
    const closeRuns = async () => {
      for (const state of live.values()) {
        state.controller.abort();
        void state.cancel?.().catch(() => {});
      }
      await Promise.allSettled([...live.values()].map((s) => s.promise));
    };
    app.decorate("miracle", { db, closeRuns });
    const cleaner = setInterval(() => {
      try {
        retention(db);
      } catch (e) {
        app.log.error(e);
      }
    }, 3600000);
    cleaner.unref();
    app.addHook("onClose", async () => {
      clearInterval(cleaner);
      await closeRuns();
      db.close();
    });
    if (options.serveStatic !== false) {
      const root = fileURLToPath(new URL("../../client/", import.meta.url));
      if (existsSync(root)) {
        await app.register(fastifyStatic, { root });
        app.setNotFoundHandler((req, reply) => {
          if (req.url.startsWith("/api/"))
            return reply.code(404).send({ error: "Маршрут не найден" });
          return reply.sendFile("index.html");
        });
      }
    }
    return app;
  } catch (error) {
    db.close();
    throw error;
  }
}
