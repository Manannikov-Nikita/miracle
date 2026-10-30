import {
  Agent,
  fetch as fetchWithDispatcher,
  type Response as UndiciResponse,
} from "undici";
import type { EngineConnection } from "./connectors.js";

export type TrinoResponse = Response | UndiciResponse;
interface TrinoRequestOptions {
  method?: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

/** Never surface raw TLS errors: they may contain certificate or connection data. */
export function trinoConnectionError(
  error: unknown,
  signal?: AbortSignal | null,
) {
  if (signal?.aborted)
    return new Error("Запрос Trino отменён или истёк таймаут");
  const codes = new Set<string>();
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const detail = current as { code?: unknown; cause?: unknown };
    if (typeof detail.code === "string") codes.add(detail.code);
    current = detail.cause;
  }
  if (codes.has("ERR_TLS_CERT_ALTNAME_INVALID"))
    return new Error(
      "Имя сервера Trino не совпадает с сертификатом TLS. Проверьте HTTPS-адрес подключения.",
    );
  if (codes.has("CERT_HAS_EXPIRED") || codes.has("CERT_NOT_YET_VALID"))
    return new Error(
      "Сертификат TLS сервера Trino просрочен или ещё не действует. Проверьте сертификат и дату на компьютере.",
    );
  if (
    [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "CERT_UNTRUSTED",
      "INVALID_CA",
      "CERT_SIGNATURE_FAILURE",
    ].some((code) => codes.has(code))
  )
    return new Error(
      "Не удалось проверить сертификат TLS сервера Trino. Загрузите доверенный CA или его цепочку в формате PEM в настройках подключения.",
    );
  if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN"))
    return new Error(
      "Не удалось найти сервер Trino. Проверьте имя сервера, сеть и подключение к VPN.",
    );
  return new Error(
    "Не удалось подключиться к Trino; проверьте адрес, доступность сети и настройки TLS.",
  );
}

/** A dispatcher belongs to one operation; CA trust never crosses connections. */
export function createTrinoTransport(c: EngineConnection) {
  const ca = c.trino?.tls?.caCert;
  const dispatcher = ca
    ? new Agent({
        connect: { ca, rejectUnauthorized: true },
        connections: 1,
        allowH2: false,
      })
    : undefined;
  return {
    async request(
      url: string,
      options: TrinoRequestOptions,
    ): Promise<TrinoResponse> {
      try {
        // Match the dispatch protocol to the installed Agent version. Node's
        // built-in fetch can bundle a different major version of undici.
        if (dispatcher)
          return await fetchWithDispatcher(url, {
            ...options,
            dispatcher,
            redirect: "error",
          });
        return await fetch(url, {
          ...options,
          redirect: "error",
        });
      } catch (error) {
        throw trinoConnectionError(error, options.signal);
      }
    },
    async close() {
      // An aborted or partially read response must not keep pooled sockets alive.
      await dispatcher?.destroy();
    },
  };
}
