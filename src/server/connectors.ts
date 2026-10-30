import { clickhouseRequest } from "./clickhouseTransport.js";
import { createTrinoTransport, type TrinoResponse } from "./trinoTransport.js";
import { CLICKHOUSE_REQUEST_TIMEOUT_DEFAULT } from "../shared/clickhouse-options.js";
import { normalizeTrinoSql } from "./sql.js";
import { parse, isLosslessNumber } from "lossless-json";
import type {
  Cell,
  Column,
  ConnectionInput,
  QuerySource,
} from "../shared/types.js";
export interface EngineConnection extends ConnectionInput {
  password: string;
}
export interface QueryLimits {
  timeoutMs: number;
  maxRows: number;
  maxBytes: number;
}
export interface EngineResult {
  columns: Column[];
  rows: Cell[][];
  byteCount: number;
}
function normalize(value: any): any {
  if (isLosslessNumber(value)) {
    const s = value.toString();
    const n = Number(s);
    return Number.isFinite(n) &&
      String(n) === s &&
      (!Number.isInteger(n) || Number.isSafeInteger(n))
      ? n
      : s;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v)]),
    );
  return value;
}
export function parseEngineJson(value: string): any {
  return normalize(parse(value));
}
export function validateNextUri(uri: string, base: string) {
  const u = new URL(uri);
  const b = new URL(base);
  if (
    u.origin !== b.origin ||
    u.username ||
    u.password ||
    !u.pathname.startsWith("/v1/statement/")
  )
    throw new Error("Trino returned an unsafe continuation URI");
  return u.href;
}
export function validateConnectionUrl(value: string) {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error("URL должен быть http(s), без пароля и параметров");
  return u.href.replace(/\/$/, "");
}
async function checked(res: TrinoResponse) {
  if (!res.ok) {
    const text = (await res.text()).slice(0, 2000);
    throw new Error(`Engine HTTP ${res.status}: ${text}`);
  }
  return res;
}
export async function executeEngine(
  c: EngineConnection,
  source: QuerySource,
  id: string,
  limits: QueryLimits,
  signal: AbortSignal,
  onCancel: (cancel: () => Promise<void>) => void,
): Promise<EngineResult> {
  return c.engine === "clickhouse"
    ? clickhouse(c, source, id, limits, signal, onCancel)
    : trino(c, source, limits, signal, onCancel);
}
function collector(limits: QueryLimits) {
  const rows: Cell[][] = [];
  let byteCount = 0;
  return {
    rows,
    get byteCount() {
      return byteCount;
    },
    add(row: Cell[]) {
      byteCount += Buffer.byteLength(JSON.stringify(row));
      if (rows.length >= limits.maxRows || byteCount > limits.maxBytes)
        throw new Error(
          `Превышен лимит результата: ${limits.maxRows} строк / ${limits.maxBytes} байт`,
        );
      rows.push(row);
    },
  };
}
function auth(c: EngineConnection) {
  return (
    "Basic " + Buffer.from(c.username + ":" + c.password).toString("base64")
  );
}
async function clickhouse(
  c: EngineConnection,
  s: QuerySource,
  id: string,
  l: QueryLimits,
  signal: AbortSignal,
  onCancel: (c: () => Promise<void>) => void,
): Promise<EngineResult> {
  const url = new URL(c.url);
  for (const [name, value] of Object.entries(c.clickhouse?.settings || {}))
    url.searchParams.set(name, value);
  const timeoutMs = Math.min(
    l.timeoutMs,
    c.clickhouse?.requestTimeoutMs ?? CLICKHOUSE_REQUEST_TIMEOUT_DEFAULT,
  );
  if (c.clickhouse?.compression)
    url.searchParams.set("enable_http_compression", "1");
  url.searchParams.set("query_id", id);
  url.searchParams.set(
    "max_execution_time",
    String(Math.ceil(timeoutMs / 1000)),
  );
  url.searchParams.set("max_result_rows", String(l.maxRows));
  url.searchParams.set("max_result_bytes", String(l.maxBytes));
  url.searchParams.set("result_overflow_mode", "throw");
  url.searchParams.set("output_format_json_quote_64bit_integers", "1");
  url.searchParams.set("output_format_json_quote_decimals", "1");
  url.searchParams.set("default_format", "JSONCompactEachRowWithNamesAndTypes");
  if (s.database || c.database)
    url.searchParams.set("database", s.database || c.database!);
  onCancel(async () => {
    const kill = new URL(c.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let response: Awaited<ReturnType<typeof clickhouseRequest>> | undefined;
    try {
      response = await clickhouseRequest(
        c,
        kill,
        `KILL QUERY WHERE query_id = ${quoteLiteral(id, "clickhouse")} SYNC`,
        controller.signal,
      );
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2048) break;
      }
    } catch {
      throw new Error("Не удалось отменить запрос ClickHouse");
    } finally {
      clearTimeout(timer);
      response?.body.destroy();
      response?.response.destroy();
    }
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  let response: Awaited<ReturnType<typeof clickhouseRequest>> | undefined;
  const decoder = new TextDecoder();
  let pending = "";
  let names: string[] | undefined;
  let columns: Column[] = [];
  const result = collector(l);
  function line(text: string) {
    if (!text.trim()) return;
    const row = parseEngineJson(text);
    if (!Array.isArray(row)) throw new Error("Invalid ClickHouse row");
    if (!names) {
      names = row;
      return;
    }
    if (!columns.length) {
      columns = names.map((name, i) => ({
        id: String(i),
        name,
        type: String(row[i]),
      }));
      return;
    }
    result.add(row);
  }
  try {
    response = await clickhouseRequest(c, url, s.sql, requestSignal);
    let decodedBytes = 0;
    for await (const value of response.body) {
      decodedBytes += value.byteLength;
      if (decodedBytes > l.maxBytes + 1024 * 1024)
        throw new Error("Слишком большой ответ ClickHouse");
      pending += decoder.decode(value, { stream: true });
      if (Buffer.byteLength(pending) > l.maxBytes + 65536)
        throw new Error("Слишком большая строка результата");
      let pos;
      while ((pos = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, pos));
        pending = pending.slice(pos + 1);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) line(pending);
  } catch (e) {
    if (requestSignal.aborted)
      throw new Error("Запрос ClickHouse отменён или истёк таймаут");
    if (
      e instanceof Error &&
      /^(Превышен лимит|Слишком больш|ClickHouse HTTP|Не удалось подключиться|Неподдерживаемое сжатие)/.test(
        e.message,
      )
    )
      throw e;
    throw new Error(
      "Не удалось прочитать ответ ClickHouse; проверьте TLS и формат ответа",
    );
  } finally {
    clearTimeout(timer);
    response?.body.destroy();
    response?.response.destroy();
  }
  return { columns, rows: result.rows, byteCount: result.byteCount };
}
async function readLimited(res: TrinoResponse, max: number) {
  if (!res.body) throw new Error("Engine returned empty response");
  const reader = res.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      total += r.value.byteLength;
      if (total > max) throw new Error("Слишком большой ответ Trino");
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function trino(
  c: EngineConnection,
  s: QuerySource,
  l: QueryLimits,
  signal: AbortSignal,
  onCancel: (c: () => Promise<void>) => void,
): Promise<EngineResult> {
  const headers: Record<string, string> = {
    "X-Trino-User": c.username || "miracle",
    "X-Trino-Source": "miracle",
    "X-Trino-Time-Zone": "UTC",
    "X-Trino-Session": `query_max_run_time=${Math.ceil(l.timeoutMs / 1000)}s`,
  };
  if (c.password) headers.Authorization = auth(c);
  if (s.catalog || c.catalog)
    headers["X-Trino-Catalog"] = s.catalog || c.catalog!;
  if (s.schema || c.schema) headers["X-Trino-Schema"] = s.schema || c.schema!;
  let uri: string | undefined;
  onCancel(async () => {
    if (!uri) return;
    // Cancellation can run after the query has failed and its pool was closed.
    const cancellation = createTrinoTransport(c);
    try {
      const response = await checked(
        await cancellation.request(uri, {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(5000),
        }),
      );
      await response.body?.cancel();
    } finally {
      await cancellation.close();
    }
  });
  const transport = createTrinoTransport(c);
  try {
    let response = await checked(
      await transport.request(c.url.replace(/\/$/, "") + "/v1/statement", {
        method: "POST",
        headers,
        body: normalizeTrinoSql(s.sql),
        signal,
      }),
    );
    let columns: Column[] = [];
    const result = collector(l);
    while (true) {
      const page = parseEngineJson(
        await readLimited(response, l.maxBytes + 1024 * 1024),
      );
      if (page.nextUri) uri = validateNextUri(page.nextUri, c.url);
      if (page.error)
        throw new Error(String(page.error.message || "Trino query failed"));
      if (page.columns)
        columns = page.columns.map((x: any, i: number) => ({
          id: String(i),
          name: x.name,
          type: x.type,
        }));
      if (page.data) for (const row of page.data) result.add(row);
      if (!page.nextUri) break;
      response = await checked(
        await transport.request(uri!, { headers, signal }),
      );
    }
    return { columns, rows: result.rows, byteCount: result.byteCount };
  } finally {
    await transport.close();
  }
}
export async function engineMetadata(
  c: EngineConnection,
  sql: string,
  options: { signal?: AbortSignal; maxRows?: number } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  let cancel: (() => Promise<void>) | undefined;
  try {
    signal.throwIfAborted();
    return await executeEngine(
      c,
      { connectionId: "metadata", sql },
      crypto.randomUUID(),
      {
        timeoutMs: 15000,
        maxRows: options.maxRows ?? 50000,
        maxBytes: 20 * 1024 * 1024,
      },
      signal,
      (fn) => {
        cancel = fn;
      },
    );
  } catch (e) {
    await cancel?.().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
/** ClickHouse interprets backslash escapes; Trino follows SQL-standard quoting. */
export function quoteLiteral(value: string, engine: "clickhouse" | "trino") {
  const escaped =
    engine === "clickhouse"
      ? value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")
      : value.replaceAll("'", "''");
  return "'" + escaped + "'";
}
export function quoteIdentifier(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}
