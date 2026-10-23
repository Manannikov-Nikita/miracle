import type { QueryRun, ResultPage } from "../shared/types";
let csrf = "";
export function setCsrfToken(token: string) {
  csrf = token;
}
export class ApiRequestError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()))
    headers.set("X-CSRF-Token", csrf);
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const data =
    response.status === 204
      ? undefined
      : await response
          .json()
          .catch(() => ({ error: "Сервер вернул некорректный ответ" }));
  if (!response.ok) {
    if (
      response.status === 401 &&
      !path.startsWith("/api/auth/") &&
      !path.startsWith("/api/setup/")
    )
      window.dispatchEvent(new Event("miracle:unauthorized"));
    throw new ApiRequestError(
      data?.error || `Ошибка ${response.status}`,
      response.status,
      data?.code,
    );
  }
  return data as T;
}
export function getResultRows(id: string, offset = 0, limit = 500) {
  return api<ResultPage>(
    `/api/result-sets/${encodeURIComponent(id)}/rows?offset=${offset}&limit=${limit}`,
  );
}
export async function waitForRun(
  id: string,
  onUpdate?: (run: QueryRun) => void,
  signal?: AbortSignal,
): Promise<QueryRun> {
  while (true) {
    signal?.throwIfAborted();
    const run = await api<QueryRun>(
      `/api/query-runs/${encodeURIComponent(id)}`,
      { signal },
    );
    onUpdate?.(run);
    if (!["running", "cancelling"].includes(run.status)) return run;
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timeout = setTimeout(done, 600);
      const abort = () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
export const json = (value: unknown) => JSON.stringify(value);
