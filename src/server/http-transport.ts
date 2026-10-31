import {
  Agent,
  fetch as packageFetch,
  type Response as UndiciResponse,
} from "undici";

export type HttpResponse = Response | UndiciResponse;
export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: "error" | "follow" | "manual";
}

/** Node 24's shared dispatcher can still be builtin undici 7, even when fetch
 * comes from package undici 8. Own the dispatcher as well as the fetch client. */
export function createHttpTransport(options: Agent.Options = {}) {
  const dispatcher = new Agent({ allowH2: false, ...options });
  return {
    request(url: string, options: HttpRequestOptions = {}) {
      return packageFetch(url, { ...options, dispatcher });
    },
    async close() {
      // Aborted or unread bodies must not hold a CLI, installer or query open.
      await dispatcher.destroy();
    },
  };
}
