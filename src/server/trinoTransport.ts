import { createHttpTransport, type HttpResponse } from "./http-transport.js";
import type { EngineConnection } from "./connectors.js";
import { connectionTransportError } from "./connectionErrors.js";

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
export function createTrinoTransport(c: EngineConnection) {
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
      try {
        return await transport.request(url, {
          ...options,
          redirect: "error",
        });
      } catch (error) {
        throw trinoConnectionError(error, options.signal);
      }
    },
    async close() {
      // An aborted or partially read response must not keep pooled sockets alive.
      await transport.close();
    },
  };
}
