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
export interface LocalSession {
  workspaceId: string;
  csrfToken: string;
}
let sessionRefresh: Promise<LocalSession> | undefined;
let workspaceId: string | undefined;
let workspaceChanged: ApiRequestError | undefined;
function changedWorkspace(): ApiRequestError {
  if (!workspaceChanged) {
    csrf = "";
    workspaceChanged = new ApiRequestError(
      "Сервер открыл другую рабочую область. Перезагрузите страницу, чтобы продолжить. Ваши черновики остаются в этой вкладке.",
      409,
      "WORKSPACE_CHANGED",
    );
    window.dispatchEvent(
      new CustomEvent("miracle:workspace-changed", {
        detail: workspaceChanged.message,
      }),
    );
  }
  return workspaceChanged;
}
export function openLocalSession(): Promise<LocalSession> {
  if (workspaceChanged) return Promise.reject(workspaceChanged);
  if (!sessionRefresh) {
    sessionRefresh = request<LocalSession>("/api/session", {})
      .then((session) => {
        if (workspaceId && session.workspaceId !== workspaceId)
          throw changedWorkspace();
        workspaceId = session.workspaceId;
        setCsrfToken(session.csrfToken);
        return session;
      })
      .finally(() => {
        sessionRefresh = undefined;
      });
  }
  return sessionRefresh;
}
async function request<T>(path: string, options: RequestInit): Promise<T> {
  // A different data directory may reuse the same origin. Keep this tab bound
  // to its original workspace until reload, including after a failed refresh.
  if (workspaceChanged) throw workspaceChanged;
  const headers = new Headers(options.headers);
  const endpoint = path.split("?")[0];
  if (
    workspaceId &&
    !["/api/session", "/api/health", "/api/local/control"].includes(endpoint)
  )
    headers.set("X-Miracle-Workspace", workspaceId);
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
  if (response.status === 409 && data?.code === "WORKSPACE_CHANGED")
    throw changedWorkspace();
  if (!response.ok)
    throw new ApiRequestError(
      data?.error || `Ошибка ${response.status}`,
      response.status,
      data?.code,
    );
  return data as T;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  try {
    return await request<T>(path, options);
  } catch (error) {
    // Only these explicit pre-execution session rejections permit a replay.
    // Generic 403s and network failures may not safely be retried.
    if (
      !(error instanceof ApiRequestError) ||
      !(
        error.status === 401 ||
        (error.status === 403 && error.code === "LOCAL_SESSION_STALE")
      ) ||
      path === "/api/session"
    )
      throw error;
    await openLocalSession();
    options.signal?.throwIfAborted();
    return request<T>(path, options);
  }
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
