import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";
import {
  Pool,
  migrate,
  retention,
  validatePassword,
  setupRequired,
  completeSetup,
  type Database,
} from "./db.js";
import { loadKey, SecretBox, verifyEncryptionKey } from "./secrets.js";
import { databaseConfig } from "./config.js";
import { acquireApplicationLock } from "./singleton.js";
import {
  mergeClickHouseOptions,
  publicClickHouseOptions,
  validateClickHouseConnection,
} from "./clickhouseOptions.js";
import { assertReadOnly } from "./sql.js";
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
  User,
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
  maxUserRuns: number;
  maxGlobalRuns: number;
  quotaBytes: number;
}
export interface AppOptions {
  databaseUrl?: string;
  encryptionKey?: Buffer;
  appOrigin?: string;
  cookieSecure?: boolean;
  limits?: Partial<Limits>;
  serveStatic?: boolean;
  logger?: boolean;
  onLockLost?: (error: Error) => void;
}
declare module "fastify" {
  interface FastifyInstance {
    miracle: {
      db: Database;
      closeRuns: () => Promise<void>;
    };
  }
  interface FastifyRequest {
    account: User | null;
    sessionId: string | null;
    csrfToken: string | null;
  }
}
const err = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { statusCode: status, code });
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const publicUser = (r: any): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  disabled: r.disabled,
});
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
const roleSchema = z.enum(["admin", "editor", "viewer"]);
const nameSchema = z.string().trim().min(1).max(200);
export async function buildApp(
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });
  const config = options.databaseUrl
    ? { connectionString: options.databaseUrl }
    : databaseConfig();
  const db = new Pool({ ...config, max: 12 });
  let singleton: Awaited<ReturnType<typeof acquireApplicationLock>> | undefined;
  let lockLost = false;
  let closeActiveRuns: (() => Promise<void>) | undefined;
  try {
    const box = new SecretBox(options.encryptionKey || loadKey());
    const appOrigin =
      options.appOrigin || process.env.APP_ORIGIN || "http://127.0.0.1:5178";
    const secure =
      options.cookieSecure ?? process.env.COOKIE_SECURE !== "false";
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
      maxUserRuns: envNum("MAX_USER_RUNS", 2),
      maxGlobalRuns: envNum("MAX_GLOBAL_RUNS", 4),
      quotaBytes: envNum("RESULT_QUOTA_BYTES", 2 * 1024 ** 3),
      ...options.limits,
    };
    singleton = await acquireApplicationLock(config, (error) => {
      lockLost = true;
      app.log.error(error.message);
      void closeActiveRuns?.();
      options.onLockLost?.(error);
      void app.close().catch(() => {});
    });
    await migrate(db);
    await verifyEncryptionKey(db, box);
    await singleton.interruptPreviousRuns();
    await retention(db);
    await app.register(cookie);
    app.decorateRequest("account", null);
    app.decorateRequest("sessionId", null);
    app.decorateRequest("csrfToken", null);
    const live = new Map<
      string,
      {
        controller: AbortController;
        cancel?: () => Promise<void>;
        promise?: Promise<void>;
        userId: string;
      }
    >();
    const rate = new Map<
      string,
      {
        count: number;
        until: number;
      }
    >();
    function throttle(key: string, max: number) {
      const now = Date.now();
      if (rate.size > 10000)
        for (const [k, v] of rate) if (v.until < now) rate.delete(k);
      let r = rate.get(key);
      if (!r || r.until < now) {
        r = { count: 0, until: now + 60000 };
        rate.set(key, r);
      }
      if (++r.count > max)
        throw err(429, "Слишком много попыток. Попробуйте через минуту");
    }
    app.setErrorHandler((e: any, _req, reply) => {
      if (e instanceof z.ZodError)
        return reply
          .code(400)
          .send({ error: e.issues[0]?.message || "Некорректные данные" });
      if (e.code === "23505")
        return reply
          .code(409)
          .send({ error: "Запись уже существует", code: "CONFLICT" });
      if (e.code === "23503")
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
      if (lockLost)
        throw err(
          503,
          "Сервер потерял соединение с базой данных и останавливается",
        );
      if (!req.url.startsWith("/api/")) return;
      reply.header("Cache-Control", "no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      const sid = req.cookies.miracle_session;
      if (sid) {
        const r = (
          await db.query(
            "SELECT s.id,s.csrf,u.id user_id,u.email,u.name,u.role,u.disabled FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at>now()",
            [digest(sid)],
          )
        ).rows[0];
        if (r && !r.disabled) {
          req.sessionId = r.id;
          req.csrfToken = r.csrf;
          if (r.user_id) req.account = publicUser({ ...r, id: r.user_id });
        }
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        if (req.headers.origin && req.headers.origin !== appOrigin)
          throw err(403, "Недопустимый Origin");
        if (
          ![
            "/api/auth/login",
            "/api/auth/activate",
            "/api/setup/complete",
          ].includes(req.url.split("?")[0]!)
        ) {
          const token = req.headers["x-csrf-token"];
          if (
            typeof token !== "string" ||
            !req.csrfToken ||
            Buffer.byteLength(token) !== Buffer.byteLength(req.csrfToken) ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(req.csrfToken))
          )
            throw err(403, "Недопустимый CSRF токен");
        }
      }
    });
    const need = (
      req: FastifyRequest,
      level: "viewer" | "editor" | "admin" = "viewer",
    ) => {
      if (!req.account) throw err(401, "Требуется вход");
      if (
        (level === "admin" && req.account.role !== "admin") ||
        (level === "editor" && req.account.role === "viewer")
      )
        throw err(403, "Недостаточно прав");
      return req.account;
    };
    async function session(
      reply: any,
      userId: string | null,
      old: string | null,
    ) {
      if (old) await db.query("DELETE FROM sessions WHERE id=$1", [old]);
      const token = randomBytes(32).toString("base64url");
      const csrf = randomBytes(32).toString("base64url");
      await db.query(
        "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",
        [digest(token), userId, csrf],
      );
      reply.setCookie("miracle_session", token, {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/",
        maxAge: 604800,
      });
      return csrf;
    }
    const uuid = (req: FastifyRequest, key = "id") =>
      z.uuid().parse((req.params as any)[key]);
    app.get("/api/health", async () => {
      await db.query("SELECT 1");
      return { ok: true };
    });
    app.get("/api/setup/status", async () => ({
      required: await setupRequired(db),
    }));
    app.post("/api/setup/complete", async (req, reply) => {
      throttle("setup:" + req.ip, 20);
      const input = z
        .object({
          token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          name: nameSchema,
          email: z.email().max(320),
          password: z
            .string()
            .min(12, "Пароль должен содержать от 12 до 256 символов")
            .max(256),
        })
        .parse(req.body);
      const user = await completeSetup(db, input);
      return {
        user: publicUser(user),
        csrfToken: await session(reply, user.id, req.sessionId),
      };
    });
    app.get("/api/auth/me", async (req, reply) => ({
      user: req.account,
      csrfToken: req.csrfToken || (await session(reply, null, null)),
    }));
    app.post("/api/auth/login", async (req, reply) => {
      throttle("ip:" + req.ip, 20);
      const b = z
        .object({ email: z.email().max(320), password: z.string().max(256) })
        .parse(req.body);
      throttle("email:" + b.email.toLowerCase(), 10);
      const r = (
        await db.query("SELECT * FROM users WHERE email=$1", [
          b.email.trim().toLowerCase(),
        ])
      ).rows[0];
      if (
        !r?.password_hash ||
        r.disabled ||
        !(await verify(r.password_hash, b.password))
      )
        throw err(401, "Неверный email или пароль");
      return {
        user: publicUser(r),
        csrfToken: await session(reply, r.id, req.sessionId),
      };
    });
    app.post("/api/auth/logout", async (req, reply) => {
      if (req.sessionId)
        await db.query("DELETE FROM sessions WHERE id=$1", [req.sessionId]);
      reply.clearCookie("miracle_session", {
        path: "/",
        httpOnly: true,
        secure,
        sameSite: "lax",
      });
      return { ok: true };
    });
    app.post("/api/auth/activate", async (req, reply) => {
      throttle("activate:" + req.ip, 20);
      const b = z
        .object({
          token: z.string().min(20).max(200),
          password: z.string(),
          name: nameSchema.optional(),
        })
        .parse(req.body);
      try {
        validatePassword(b.password);
      } catch (e: any) {
        throw err(400, e.message);
      }
      const ph = await hash(b.password);
      const c = await db.connect();
      let user;
      try {
        await c.query("BEGIN");
        const t = (
          await c.query(
            "DELETE FROM account_tokens WHERE token_hash=$1 AND expires_at>now() RETURNING user_id",
            [digest(b.token)],
          )
        ).rows[0];
        if (!t) throw err(400, "Ссылка недействительна или истекла");
        user = (
          await c.query(
            "UPDATE users SET password_hash=$2,name=COALESCE($3,name) WHERE id=$1 AND disabled=false RETURNING *",
            [t.user_id, ph, b.name],
          )
        ).rows[0];
        if (!user) throw err(400, "Аккаунт отключён");
        await c.query("DELETE FROM account_tokens WHERE user_id=$1", [user.id]);
        await c.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
      return {
        user: publicUser(user),
        csrfToken: await session(reply, user.id, req.sessionId),
      };
    });
    async function activationLink(userId: string) {
      const token = randomBytes(32).toString("base64url");
      await db.query("DELETE FROM account_tokens WHERE user_id=$1", [userId]);
      await db.query(
        "INSERT INTO account_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '24 hours')",
        [digest(token), userId],
      );
      return appOrigin + "/activate?token=" + token;
    }
    app.get("/api/users", async (req) => {
      need(req, "admin");
      return (
        await db.query("SELECT * FROM users ORDER BY created_at")
      ).rows.map(publicUser);
    });
    app.post("/api/users", async (req, reply) => {
      need(req, "admin");
      const b = z
        .object({
          email: z.email().max(320),
          name: nameSchema,
          role: roleSchema,
        })
        .parse(req.body);
      const user = (
        await db.query(
          "INSERT INTO users(id,email,name,role) VALUES($1,$2,$3,$4) RETURNING *",
          [randomUUID(), b.email.trim().toLowerCase(), b.name, b.role],
        )
      ).rows[0];
      reply.code(201);
      return {
        user: publicUser(user),
        activationUrl: await activationLink(user.id),
      };
    });
    app.patch("/api/users/:id", async (req) => {
      need(req, "admin");
      const id = uuid(req);
      const b = z
        .object({
          role: roleSchema.optional(),
          disabled: z.boolean().optional(),
          name: nameSchema.optional(),
        })
        .parse(req.body);
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(67432913)");
        const old = (
          await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [id])
        ).rows[0];
        if (!old) throw err(404, "Пользователь не найден");
        if (
          old.role === "admin" &&
          !old.disabled &&
          (b.disabled || (b.role && b.role !== "admin"))
        ) {
          const n = await c.query(
            "SELECT id FROM users WHERE role='admin' AND disabled=false AND password_hash IS NOT NULL AND id<>$1",
            [id],
          );
          if (!n.rowCount)
            throw err(409, "Нельзя отключить последнего администратора");
        }
        const u = (
          await c.query(
            "UPDATE users SET name=COALESCE($2,name),role=COALESCE($3,role),disabled=COALESCE($4,disabled) WHERE id=$1 RETURNING *",
            [id, b.name, b.role, b.disabled],
          )
        ).rows[0];
        if (b.disabled || b.role)
          await c.query("DELETE FROM sessions WHERE user_id=$1", [id]);
        await c.query("COMMIT");
        return publicUser(u);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    });
    app.post("/api/users/:id/reset", async (req) => {
      need(req, "admin");
      const id = uuid(req);
      if (!(await db.query("SELECT id FROM users WHERE id=$1", [id])).rowCount)
        throw err(404, "Пользователь не найден");
      await db.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      return { url: await activationLink(id) };
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
      const r = (await db.query("SELECT * FROM connections WHERE id=$1", [id]))
        .rows[0];
      if (!r) throw err(404, "Подключение не найдено");
      return {
        ...connectionDto(r),
        password: r.password_encrypted ? box.decrypt(r.password_encrypted) : "",
        clickhouse: savedClickHouseOptions(r),
      };
    }
    app.get("/api/connections", async (req) => {
      need(req);
      return (
        await db.query("SELECT * FROM connections ORDER BY created_at")
      ).rows.map(connectionDto);
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
      need(req, "admin");
      const b = validateConnection(req.body);
      const r = (
        await db.query(
          "INSERT INTO connections(id,name,engine,url,username,password_encrypted,database_name,catalog,schema_name,clickhouse_options_encrypted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
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
        )
      ).rows[0];
      reply.code(201);
      return connectionDto(r);
    });
    app.patch("/api/connections/:id", async (req) => {
      need(req, "admin");
      const id = uuid(req);
      const patch = connectionSchema.partial().parse(req.body);
      const b = mergedConnection(await connection(id), patch);
      const r = (
        await db.query(
          "UPDATE connections SET name=$2,engine=$3,url=$4,username=$5,password_encrypted=$6,database_name=$7,catalog=$8,schema_name=$9,clickhouse_options_encrypted=$10 WHERE id=$1 RETURNING *",
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
        )
      ).rows[0];
      return connectionDto(r);
    });
    app.post("/api/connections/test", async (req) => {
      need(req, "admin");
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
      need(req, "admin");
      if (
        !(await db.query("DELETE FROM connections WHERE id=$1", [uuid(req)]))
          .rowCount
      )
        throw err(404, "Подключение не найдено");
      return { ok: true };
    });
    app.post("/api/connections/:id/test", async (req) => {
      need(req, "admin");
      const c = await connection(uuid(req));
      try {
        const r = await engineMetadata(c, "SELECT version()");
        return { ok: true, version: String(r.rows[0]?.[0] || "") };
      } catch (e: any) {
        throw err(400, e.message);
      }
    });
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
      return (
        await db.query("SELECT * FROM queries ORDER BY updated_at DESC")
      ).rows.map(queryDto);
    });
    app.post("/api/queries", async (req, reply) => {
      need(req, "editor");
      const b = sourceSchema.extend({ name: nameSchema }).parse(req.body);
      const { name, ...source } = b;
      await connection(source.connectionId);
      const r = (
        await db.query(
          "INSERT INTO queries(id,name,source) VALUES($1,$2,$3) RETURNING *",
          [randomUUID(), name, source],
        )
      ).rows[0];
      reply.code(201);
      return queryDto(r);
    });
    app.patch("/api/queries/:id", async (req) => {
      need(req, "editor");
      const id = uuid(req);
      const b = sourceSchema
        .extend({
          name: nameSchema,
          baseRevision: z.number().int().nonnegative(),
        })
        .parse(req.body);
      const { name, baseRevision, ...source } = b;
      await connection(source.connectionId);
      const r = (
        await db.query(
          "UPDATE queries SET name=$2,source=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING *",
          [id, name, source, baseRevision],
        )
      ).rows[0];
      if (!r)
        throw err(
          409,
          "Запрос изменён другим пользователем. Перезагрузите или сохраните копию",
          "REVISION_CONFLICT",
        );
      return queryDto(r);
    });
    app.delete("/api/queries/:id", async (req) => {
      need(req, "editor");
      if (
        !(await db.query("DELETE FROM queries WHERE id=$1", [uuid(req)]))
          .rowCount
      )
        throw err(404, "Запрос не найден");
      return { ok: true };
    });
    async function startRun(req: FastifyRequest, source: QuerySource) {
      const user = need(req, "editor");
      try {
        assertReadOnly(source.sql);
      } catch (e: any) {
        throw err(400, e.message);
      }
      const engine = await connection(source.connectionId);
      const id = randomUUID();
      const c = await db.connect();
      let created;
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(67432915)");
        const r = await c.query(
          "SELECT user_id FROM query_runs WHERE status IN ('running','cancelling')",
        );
        if (
          r.rows.length >= limits.maxGlobalRuns ||
          r.rows.filter((r) => r.user_id === user.id).length >=
            limits.maxUserRuns
        )
          throw err(429, "Достигнут лимит одновременных запросов");
        created = (
          await c.query(
            "INSERT INTO query_runs(id,user_id,status,source) VALUES($1,$2,'running',$3) RETURNING *",
            [id, user.id, source],
          )
        ).rows[0];
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
      const state: {
        controller: AbortController;
        cancel?: () => Promise<void>;
        promise?: Promise<void>;
        userId: string;
      } = { controller: new AbortController(), userId: user.id };
      live.set(id, state);
      state.promise = performRun(id, engine, source, state);
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
        const c = await db.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT pg_advisory_xact_lock(67432914)");
          const run = (
            await c.query(
              "SELECT status FROM query_runs WHERE id=$1 FOR UPDATE",
              [id],
            )
          ).rows[0];
          if (run?.status !== "running" || state.controller.signal.aborted)
            throw new Error("Запрос отменён");
          const total = Number(
            (
              await c.query(
                "SELECT COALESCE(sum(byte_count),0) size FROM result_sets",
              )
            ).rows[0].size,
          );
          if (total + output.byteCount > limits.quotaBytes)
            throw new Error(
              "Квота хранения результатов исчерпана. Удалите ненужные доски или дождитесь очистки истории",
            );
          await c.query(
            "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES($1,$2,$3,$4,$5)",
            [
              resultId,
              JSON.stringify(output.columns),
              output.rows.length,
              output.byteCount,
              source,
            ],
          );
          for (let i = 0; i < output.rows.length; i += 500)
            await c.query(
              "INSERT INTO result_chunks(result_set_id,chunk_index,rows) VALUES($1,$2,$3)",
              [
                resultId,
                i / 500,
                JSON.stringify(output.rows.slice(i, i + 500)),
              ],
            );
          await c.query(
            "UPDATE query_runs SET status='completed',result_set_id=$2,row_count=$3,elapsed_ms=$4,finished_at=now() WHERE id=$1",
            [id, resultId, output.rows.length, Date.now() - started],
          );
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
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
        await db.query(
          "UPDATE query_runs SET status=$2,error=$3,elapsed_ms=$4,finished_at=now() WHERE id=$1",
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
      return (
        await db.query(
          "SELECT * FROM query_runs ORDER BY started_at DESC LIMIT $1",
          [limit],
        )
      ).rows.map(runDto);
    });
    app.get("/api/query-runs/:id", async (req) => {
      need(req);
      const r = (
        await db.query("SELECT * FROM query_runs WHERE id=$1", [uuid(req)])
      ).rows[0];
      if (!r) throw err(404, "Выполнение не найдено");
      return runDto(r);
    });
    app.post("/api/query-runs/:id/cancel", async (req) => {
      const user = need(req, "editor");
      const id = uuid(req);
      const r = (await db.query("SELECT * FROM query_runs WHERE id=$1", [id]))
        .rows[0];
      if (!r) throw err(404, "Выполнение не найдено");
      if (r.user_id !== user.id && user.role !== "admin")
        throw err(403, "Нельзя отменить чужой запрос");
      const state = live.get(id);
      if (state) {
        await db.query(
          "UPDATE query_runs SET status='cancelling' WHERE id=$1 AND status='running'",
          [id],
        );
        state.controller.abort();
        void state.cancel?.().catch(() => {});
      }
      return runDto(
        (await db.query("SELECT * FROM query_runs WHERE id=$1", [id])).rows[0],
      );
    });
    async function getResult(id: string) {
      const r = (await db.query("SELECT * FROM result_sets WHERE id=$1", [id]))
        .rows[0];
      if (!r) throw err(404, "Результат не найден или срок хранения истёк");
      return resultDto(r);
    }
    async function rows(id: string, offset: number, limit: number) {
      const chunks = (
        await db.query(
          "SELECT rows FROM result_chunks WHERE result_set_id=$1 AND chunk_index >= $2 AND chunk_index <= $3 ORDER BY chunk_index",
          [
            id,
            Math.floor(offset / 500),
            Math.floor((offset + limit - 1) / 500),
          ],
        )
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
    async function saveRefs(c: any, id: string, document: BoardDocument) {
      const ids = [
        ...new Set(
          document.nodes.flatMap((n) =>
            n.data.resultSetId ? [n.data.resultSetId] : [],
          ),
        ),
      ];
      await c.query("DELETE FROM board_result_refs WHERE board_id=$1", [id]);
      for (const resultId of ids) {
        const r = (
          await c.query(
            "SELECT id,row_count FROM result_sets WHERE id=$1 FOR KEY SHARE",
            [resultId],
          )
        ).rows[0];
        if (!r) throw err(400, "Результат блока не найден");
        if (
          document.nodes.some(
            (n) => n.data.resultSetId === resultId && n.data.view === "chart",
          ) &&
          r.row_count > 5000
        )
          throw err(422, "График превышает лимит 5000 точек");
        await c.query(
          "INSERT INTO board_result_refs(board_id,result_set_id) VALUES($1,$2)",
          [id, resultId],
        );
      }
    }
    app.get("/api/boards", async (req) => {
      need(req);
      return (
        await db.query(
          "SELECT id,name,revision,updated_at FROM boards ORDER BY updated_at DESC",
        )
      ).rows.map((r) => ({
        id: r.id,
        name: r.name,
        revision: r.revision,
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
    });
    app.get("/api/boards/:id", async (req) => {
      need(req);
      const r = (
        await db.query("SELECT * FROM boards WHERE id=$1", [uuid(req)])
      ).rows[0];
      if (!r) throw err(404, "Доска не найдена");
      return boardDto(r);
    });
    app.post("/api/boards", async (req, reply) => {
      need(req, "editor");
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
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(67432914)");
        const r = (
          await c.query(
            "INSERT INTO boards(id,name,document) VALUES($1,$2,$3) RETURNING *",
            [id, b.name, b.document],
          )
        ).rows[0];
        await saveRefs(c, id, b.document);
        await c.query("COMMIT");
        reply.code(201);
        return boardDto(r);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    });
    app.patch("/api/boards/:id", async (req) => {
      need(req, "editor");
      const id = uuid(req);
      const b = z
        .object({
          baseRevision: z.number().int().nonnegative(),
          name: nameSchema.optional(),
          document: boardDocumentSchema,
        })
        .parse(req.body);
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(67432914)");
        const r = (
          await c.query(
            "UPDATE boards SET name=COALESCE($2,name),document=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$4 RETURNING *",
            [id, b.name, b.document, b.baseRevision],
          )
        ).rows[0];
        if (!r)
          throw err(
            409,
            "Доска изменена другим пользователем. Перезагрузите или сохраните копию",
            "REVISION_CONFLICT",
          );
        await saveRefs(c, id, b.document);
        await c.query("COMMIT");
        return boardDto(r);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    });
    app.delete("/api/boards/:id", async (req) => {
      need(req, "editor");
      if (
        !(await db.query("DELETE FROM boards WHERE id=$1", [uuid(req)]))
          .rowCount
      )
        throw err(404, "Доска не найдена");
      return { ok: true };
    });
    app.post("/api/boards/:id/nodes/:nodeId/refresh", async (req, reply) => {
      need(req, "editor");
      const id = uuid(req);
      const nodeId = z
        .string()
        .max(200)
        .parse((req.params as any).nodeId);
      const b = z
        .object({ sourceRevision: z.number().int().nonnegative() })
        .parse(req.body);
      const board = (
        await db.query("SELECT document FROM boards WHERE id=$1", [id])
      ).rows[0];
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
    closeActiveRuns = closeRuns;
    app.decorate("miracle", { db, closeRuns });
    const cleaner = setInterval(() => {
      void retention(db).catch((e) => app.log.error(e));
    }, 3600000);
    cleaner.unref();
    app.addHook("onClose", async () => {
      clearInterval(cleaner);
      await closeRuns();
      await db.end();
      await singleton?.close();
    });
    if (options.serveStatic !== false) {
      const root = resolve("dist/client");
      if (existsSync(root)) {
        await app.register(fastifyStatic, { root });
        app.setNotFoundHandler((req, reply) => {
          if (req.url.startsWith("/api/"))
            return reply.code(404).send({ error: "Маршрут не найден" });
          return reply.sendFile("index.html");
        });
      }
    }
    if (lockLost)
      throw new Error("Application database lock lost during startup");
    return app;
  } catch (error) {
    await singleton?.close();
    await db.end();
    throw error;
  }
}
