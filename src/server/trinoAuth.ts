import { createHash, randomUUID } from "node:crypto";
import type { EngineConnection } from "./connectors.js";
import { ConnectionDiagnosticError } from "./connectionErrors.js";
import { createTrinoTransport, type TrinoResponse } from "./trinoTransport.js";

export interface TrinoAuthContext {
  getToken(): string | undefined;
  rejectToken(token: string): void;
}
type Status = { status: "pending" | "authenticated" };
type Session = {
  id: string;
  scope: string;
  key: string;
  fingerprint: string;
  connection: EngineConnection;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  status: Status["status"];
  tokenUrl?: string;
  redirectUrl?: string;
  flight?: Promise<Status>;
};
const protocolError = () =>
  new ConnectionDiagnosticError(
    "Сервер Trino вернул неподдерживаемый ответ внешней авторизации.",
    "TRINO_AUTH_PROTOCOL",
  );
const expiredError = () =>
  new ConnectionDiagnosticError(
    "Вход в Trino отменён или время ожидания истекло. Начните вход заново.",
    "TRINO_AUTH_EXPIRED",
  );
function fingerprint(c: EngineConnection) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        c.engine,
        c.url,
        c.username,
        c.password,
        c.catalog || "",
        c.schema || "",
        Boolean(c.trino?.externalAuthentication),
        c.trino?.tls?.caCert || "",
      ]),
    )
    .digest("hex");
}
function safeUrl(value: string, coordinator?: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw protocolError();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (coordinator && url.origin !== new URL(coordinator).origin)
  )
    throw protocolError();
  return url.href;
}
/** Authentication challenges can contain commas in quoted realms and multiple schemes. */
function challenge(header: string | null, coordinator: string) {
  if (!header || header.length > 16384) throw protocolError();
  const parts: string[] = [];
  let quoted = false,
    escaped = false,
    part = "";
  for (const char of header) {
    if (escaped) {
      part += char;
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      part += char;
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      parts.push(part.trim());
      part = "";
    } else part += char;
  }
  if (quoted || escaped) throw protocolError();
  parts.push(part.trim());
  let scheme = "";
  const params = new Map<string, string>();
  for (let text of parts) {
    const prefix = /^([A-Za-z][A-Za-z0-9_-]*)\s+/.exec(text);
    if (prefix) {
      scheme = prefix[1]!.toLowerCase();
      text = text.slice(prefix[0].length);
    }
    const match =
      /^([A-Za-z0-9_-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s"]+))$/.exec(text);
    if (scheme !== "bearer" || !match) continue;
    const key = match[1]!.toLowerCase();
    if (params.has(key)) throw protocolError();
    params.set(key, (match[2] ?? match[3]!).replace(/\\(.)/g, "$1"));
  }
  const token = params.get("x_token_server");
  if (!token) throw protocolError();
  const redirect = params.get("x_redirect_server");
  return {
    tokenUrl: safeUrl(token, coordinator),
    redirectUrl: redirect ? safeUrl(redirect) : undefined,
  };
}
async function jsonBody(
  response: TrinoResponse,
): Promise<Record<string, unknown>> {
  if (!response.body) throw protocolError();
  const reader = response.body.getReader();
  let bytes = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 128 * 1024) throw protocolError();
      parts.push(next.value);
    }
    const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw protocolError();
    return body as Record<string, unknown>;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ConnectionDiagnosticError) throw error;
    throw protocolError();
  } finally {
    reader.releaseLock();
  }
}

/** One manager per running project. No tokens or challenge URLs enter durable state. */
export class TrinoAuthManager {
  private readonly tokens = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  private closed = false;

  context(c: EngineConnection, scope: string): TrinoAuthContext {
    const key = `${scope}:${fingerprint(c)}`;
    return {
      getToken: () => (this.closed ? undefined : this.tokens.get(key)),
      rejectToken: (token) => {
        if (this.tokens.get(key) !== token) return;
        this.tokens.delete(key);
        for (const s of this.sessions.values())
          if (s.key === key) this.cancel(s.id);
      },
    };
  }
  sessionContext(
    c: EngineConnection,
    id: string,
    scope?: string,
  ): TrinoAuthContext {
    const session = this.matchingSession(c, id, scope);
    return this.context(c, session.scope);
  }
  private matchingSession(c: EngineConnection, id: string, scope?: string) {
    const session = this.sessions.get(id);
    if (
      !session ||
      session.status !== "authenticated" ||
      session.fingerprint !== fingerprint(c) ||
      (!session.scope.startsWith("draft:") && session.scope !== scope)
    )
      throw expiredError();
    return session;
  }
  promote(c: EngineConnection, id: string, scope: string) {
    const session = this.matchingSession(c, id, scope);
    const token = this.tokens.get(session.key);
    const nextKey = `${scope}:${session.fingerprint}`;
    if (token) this.tokens.set(nextKey, token);
    if (session.scope.startsWith("draft:") && nextKey !== session.key)
      this.tokens.delete(session.key);
    session.scope = scope;
    session.key = nextKey;
  }
  invalidate(scope: string, keepSessionId?: string) {
    const keepKey = keepSessionId
      ? this.sessions.get(keepSessionId)?.key
      : undefined;
    for (const s of this.sessions.values())
      if (s.scope === scope && s.id !== keepSessionId) this.cancel(s.id);
    for (const key of this.tokens.keys())
      if (key.startsWith(`${scope}:`) && key !== keepKey)
        this.tokens.delete(key);
  }
  changed(a: EngineConnection, b: EngineConnection) {
    return fingerprint(a) !== fingerprint(b);
  }
  async start(c: EngineConnection, savedScope?: string) {
    if (this.closed) throw expiredError();
    if (
      c.engine !== "trino" ||
      !c.trino?.externalAuthentication ||
      new URL(c.url).protocol !== "https:"
    )
      throw new ConnectionDiagnosticError(
        "Выберите внешнюю авторизацию Trino и HTTPS.",
        "TRINO_AUTH_CONFIG",
      );
    if (this.sessions.size >= 32)
      throw new ConnectionDiagnosticError(
        "Завершите или отмените предыдущие попытки входа в Trino.",
        "TRINO_AUTH_BUSY",
      );
    const id = randomUUID(),
      scope = savedScope || `draft:${id}`,
      fp = fingerprint(c);
    const key = `${scope}:${fp}`;
    for (const old of this.sessions.values())
      if (old.key === key) this.cancel(old.id);
    const timer = setTimeout(() => this.cancel(id), 5 * 60 * 1000);
    timer.unref();
    const session: Session = {
      id,
      scope,
      key,
      fingerprint: fp,
      connection: { ...c, trinoAuth: undefined },
      controller: new AbortController(),
      timer,
      status: "pending",
    };
    this.sessions.set(id, session);
    const transport = createTrinoTransport(c, { authentication: false });
    try {
      const token = this.tokens.get(key);
      const headers: Record<string, string> = {
        "X-Trino-Source": "miracle",
        "X-Trino-Session": "query_max_run_time=15s",
      };
      if (c.username) headers["X-Trino-User"] = c.username;
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await transport.request(
        c.url.replace(/\/$/, "") + "/v1/statement",
        {
          method: "POST",
          headers,
          body: "SELECT 1",
          signal: AbortSignal.any([
            session.controller.signal,
            AbortSignal.timeout(15000),
          ]),
        },
      );
      if (response.status === 401) {
        this.tokens.delete(key);
        const auth = challenge(response.headers.get("www-authenticate"), c.url);
        await response.body?.cancel();
        Object.assign(session, auth);
      } else if (response.ok) {
        const page = await jsonBody(response);
        if (typeof page.nextUri === "string") {
          const next = safeUrl(page.nextUri, c.url);
          if (!new URL(next).pathname.startsWith("/v1/statement/"))
            throw protocolError();
          const cancelled = await transport.request(next, {
            method: "DELETE",
            headers,
            signal: AbortSignal.any([
              session.controller.signal,
              AbortSignal.timeout(5000),
            ]),
          });
          await cancelled.body?.cancel();
        }
        session.status = "authenticated";
      } else {
        await response.body?.cancel();
        throw protocolError();
      }
      this.ensureActive(session);
      return {
        id,
        status: session.status,
        ...(session.redirectUrl ? { redirectUrl: session.redirectUrl } : {}),
      };
    } catch (error) {
      this.cancel(id);
      throw error;
    } finally {
      await transport.close();
    }
  }
  private ensureActive(s: Session) {
    if (
      this.closed ||
      this.sessions.get(s.id) !== s ||
      s.controller.signal.aborted
    )
      throw expiredError();
  }
  async poll(id: string): Promise<Status> {
    const s = this.sessions.get(id);
    if (!s) throw expiredError();
    this.ensureActive(s);
    if (s.status === "authenticated") return { status: s.status };
    if (s.flight) return s.flight;
    s.flight = this.pollOnce(s);
    try {
      return await s.flight;
    } finally {
      s.flight = undefined;
    }
  }
  private async pollOnce(s: Session): Promise<Status> {
    const transport = createTrinoTransport(s.connection, {
      authentication: false,
    });
    try {
      const response = await transport.request(s.tokenUrl!, {
        headers: {},
        signal: AbortSignal.any([
          s.controller.signal,
          AbortSignal.timeout(20000),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw protocolError();
      }
      const body = await jsonBody(response);
      this.ensureActive(s);
      if (
        typeof body.token === "string" &&
        body.token.length > 0 &&
        body.token.length <= 16384 &&
        /^[\x21-\x7e]+$/.test(body.token)
      ) {
        // Acknowledge receipt so the coordinator can discard its temporary token.
        try {
          const acknowledged = await transport.request(s.tokenUrl!, {
            method: "DELETE",
            headers: {},
            signal: AbortSignal.any([
              s.controller.signal,
              AbortSignal.timeout(4000),
            ]),
          });
          await acknowledged.body?.cancel();
        } catch {
          /* receipt cleanup is best-effort; the token itself remains valid */
        }
        this.ensureActive(s);
        this.tokens.set(s.key, body.token);
        s.status = "authenticated";
        s.tokenUrl = undefined;
        s.redirectUrl = undefined;
      } else if (body.error !== undefined) {
        throw new ConnectionDiagnosticError(
          "Сервис входа отклонил авторизацию Trino. Начните вход заново.",
          "TRINO_AUTH_FAILED",
        );
      } else if (typeof body.nextUri === "string") {
        s.tokenUrl = safeUrl(body.nextUri, s.connection.url);
      } else throw protocolError();
      return { status: s.status };
    } catch (error) {
      const cancelled = s.controller.signal.aborted;
      this.cancel(s.id);
      if (cancelled) throw expiredError();
      throw error;
    } finally {
      await transport.close();
    }
  }
  cancel(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    clearTimeout(s.timer);
    s.controller.abort();
    if (s.scope.startsWith("draft:")) this.tokens.delete(s.key);
  }
  close() {
    this.closed = true;
    for (const id of this.sessions.keys()) this.cancel(id);
    this.tokens.clear();
  }
}
