import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { createGunzip, gzipSync } from "node:zlib";
import type { Readable } from "node:stream";
import type { EngineConnection } from "./connectors.js";

/** A request-scoped TLS configuration: never changes process trust or pools credentials. */
export async function clickhouseRequest(
  c: EngineConnection,
  url: URL,
  sql: string,
  signal: AbortSignal,
): Promise<{ response: IncomingMessage; body: Readable }> {
  const tls = c.clickhouse?.tls;
  const compression = c.clickhouse?.compression === true;
  const body = compression ? gzipSync(Buffer.from(sql)) : Buffer.from(sql);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        agent: false,
        signal,
        ...(url.protocol === "https:"
          ? {
              rejectUnauthorized: true,
              ...(tls?.caCert ? { ca: tls.caCert } : {}),
              ...(tls?.clientCert ? { cert: tls.clientCert } : {}),
              ...(tls?.clientKey ? { key: tls.clientKey } : {}),
            }
          : {}),
        headers: {
          ...(tls?.certificateAuth
            ? {
                "X-ClickHouse-SSL-Certificate-Auth": "on",
                "X-ClickHouse-User": c.username,
              }
            : {
                Authorization:
                  "Basic " +
                  Buffer.from(c.username + ":" + c.password).toString("base64"),
              }),
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": body.byteLength,
          ...(compression
            ? { "Accept-Encoding": "gzip", "Content-Encoding": "gzip" }
            : {}),
        },
      },
      resolve,
    );
    req.on("error", () =>
      reject(
        new Error(
          signal.aborted
            ? "Запрос ClickHouse отменён или истёк таймаут"
            : "Не удалось подключиться к ClickHouse; проверьте адрес, TLS и учётные данные",
        ),
      ),
    );
    req.end(body);
  });
  // IncomingMessage abort/error must not escape unhandled while a decompressor owns the consumer.
  const encoding = response.headers["content-encoding"];
  let decoded: Readable = response;
  if (encoding === "gzip") {
    const gunzip = createGunzip();
    decoded = gunzip;
    response.on("error", (e) => gunzip.destroy(e));
    response.pipe(gunzip);
    decoded.once("close", () => response.destroy());
  } else if (encoding && encoding !== "identity") {
    response.destroy();
    throw new Error("Неподдерживаемое сжатие ответа ClickHouse");
  }
  if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
    // Bound collection before decoding and never return transport/config diagnostics.
    const parts: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let interrupted = false;
    try {
      for await (const chunk of decoded) {
        const part = Buffer.from(chunk).subarray(0, 2048 - bytes);
        parts.push(part);
        bytes += part.byteLength;
        if (bytes >= 2048) {
          truncated = true;
          break;
        }
      }
    } catch {
      interrupted = true;
    } finally {
      decoded.destroy();
      response.destroy();
    }
    if (interrupted)
      throw new Error(
        `ClickHouse HTTP ${response.statusCode}: не удалось прочитать сообщение движка`,
      );
    // A clipped response can contain only a prefix of a secret, which exact
    // redaction cannot recognize. Never expose any engine body in that case.
    if (truncated)
      throw new Error(
        `ClickHouse HTTP ${response.statusCode}: сообщение движка превышает допустимый размер`,
      );
    let message = Buffer.concat(parts).toString("utf8");
    for (const secret of [
      c.password,
      tls?.caCert,
      tls?.clientCert,
      tls?.clientKey,
      Buffer.from(c.username + ":" + c.password).toString("base64"),
    ]) {
      if (secret) message = message.split(secret).join("[скрыто]");
    }
    message = message
      .replace(
        /-----BEGIN [^-]+-----[\s\S]*?(?:-----END [^-]+-----|$)/g,
        "[скрыто]",
      )
      .slice(0, 2000);
    throw new Error(
      `ClickHouse HTTP ${response.statusCode}${message ? ": " + message : "; проверьте адрес и учётные данные"}`,
    );
  }

  return { response, body: decoded };
}
