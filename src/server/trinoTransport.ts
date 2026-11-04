import { createHttpTransport, type HttpResponse } from "./http-transport.js";
import type { EngineConnection } from "./connectors.js";
import { connectionTransportError } from "./connectionErrors.js";
import { ConnectionDiagnosticError } from "./connectionErrors.js";

export type TrinoResponse = HttpResponse;
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
  return connectionTransportError("Trino", error, signal);
}

/** A dispatcher belongs to one operation; CA trust never crosses connections. */
export function createTrinoTransport(
  c: EngineConnection,
  config: { authentication?: boolean } = {},
) {
  const ca = c.trino?.tls?.caCert;
  const transport = createHttpTransport(
    ca
      ? {
          connect: { ca, rejectUnauthorized: true },
          connections: 1,
        }
      : {},
  );
  return {
    async request(
      url: string,
      options: TrinoRequestOptions,
    ): Promise<TrinoResponse> {
      const external =
        config.authentication !== false && c.trino?.externalAuthentication;
      const token = external ? c.trinoAuth?.getToken() : undefined;
      if (external && new URL(url).origin !== new URL(c.url).origin)
        throw new ConnectionDiagnosticError(
          "Trino вернул недопустимый адрес запроса.",
          "TRINO_AUTH_PROTOCOL",
        );
      const headers = { ...options.headers };
      if (external) {
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === "authorization") delete headers[key];
        if (token) headers.Authorization = `Bearer ${token}`;
      }
      let response: TrinoResponse;
      try {
        response = await transport.request(url, {
          ...options,
          headers,
          redirect: "error",
        });
      } catch (error) {
        throw trinoConnectionError(error, options.signal);
      }
      if (external && response.status === 401) {
        if (token) c.trinoAuth?.rejectToken(token);
        await response.body?.cancel();
        throw new ConnectionDiagnosticError(
          "Войдите в Trino через браузер в настройках подключения и повторите запрос.",
          "TRINO_AUTH_REQUIRED",
        );
      }
      return response;
    },
    async close() {
      // An aborted or partially read response must not keep pooled sockets alive.
      await transport.close();
    },
  };
}
