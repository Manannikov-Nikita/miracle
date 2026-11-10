import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Dataset } from "../shared/datasets";
import type { QueryRun, QuerySource } from "../shared/types";
import { api, ApiRequestError, json, waitForRun } from "./api";
import { ProjectSyncProvider, useProjectSync } from "./agents/ProjectSync";
import { describeError } from "./error-message";

export type DatasetRevision = Pick<Dataset, "id" | "revision">;
type RefreshAction = "resume" | "cancel" | "track";
type RefreshState = {
  busy: boolean;
  run?: QueryRun;
  error?: string;
  action?: RefreshAction;
};

type DatasetCatalog = {
  items: Dataset[];
  loading: boolean;
  error: string;
  reload(): Promise<void>;
  recovering: boolean;
  refreshes: Record<string, RefreshState>;
  refresh(
    dataset: DatasetRevision,
    source?: QuerySource,
    onComplete?: () => void,
  ): Promise<void>;
  act(id: string, action: RefreshAction): Promise<void>;
};

const CatalogContext = createContext<DatasetCatalog | null>(null);
export const useDatasetCatalog = () => useContext(CatalogContext);
export const datasetPath = (id: string) =>
  `/api/datasets/${encodeURIComponent(id)}`;

export function ProjectDataProvider({
  workspaceId,
  ...catalog
}: Parameters<typeof DatasetCatalogProvider>[0] & { workspaceId: string }) {
  return (
    <ProjectSyncProvider workspaceId={workspaceId}>
      <DatasetCatalogProvider key={workspaceId} {...catalog} />
    </ProjectSyncProvider>
  );
}

export function DatasetCatalogProvider({
  children,
  onNotify,
}: {
  children: ReactNode;
  onNotify: (message: string, tone?: "error" | "success" | "info") => void;
}) {
  const sync = useProjectSync();
  const [items, setItems] = useState<Dataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshes, setRefreshes] = useState<Record<string, RefreshState>>({});
  const [recovering, setRecovering] = useState(true);
  const request = useRef<AbortController | null>(null);
  const recoveryRequest = useRef<AbortController | null>(null);
  const pollers = useRef(new Map<string, AbortController>());
  const knownRuns = useRef(new Map<string, QueryRun>());
  const completionCallbacks = useRef(new Map<string, () => void>());
  const starting = useRef(new Set<string>());
  const acting = useRef(new Set<string>());
  const lifetime = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    if (lifetime.current?.signal.aborted) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await api<Dataset[]>("/api/datasets", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setItems(next);
    } catch (error) {
      if (!controller.signal.aborted) setError(describeError(error).details);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const update = useCallback((id: string, state: RefreshState) => {
    if (!lifetime.current?.signal.aborted)
      setRefreshes((current) => ({ ...current, [id]: state }));
  }, []);

  const track = useCallback(
    async (id: string, run: QueryRun, recoveringRun = false) => {
      pollers.current.get(id)?.abort();
      const controller = new AbortController();
      pollers.current.set(id, controller);
      knownRuns.current.set(id, run);
      update(id, { busy: true, run });
      let latest = run;
      try {
        const done = await waitForRun(
          run.id,
          (next) => {
            if (controller.signal.aborted) return;
            latest = next;
            knownRuns.current.set(id, next);
            update(id, { busy: true, run: next });
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (done.status === "paused") {
          update(id, { busy: false, run: done });
          if (!recoveringRun || run.status !== "paused")
            onNotify(
              "Обновление приостановлено. Откройте датасет в источниках данных, чтобы продолжить.",
              "info",
            );
        } else if (done.status === "completed" || done.status === "cancelled") {
          knownRuns.current.delete(id);
          const onComplete = completionCallbacks.current.get(done.id);
          completionCallbacks.current.delete(done.id);
          setRefreshes((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          if (done.status === "completed") {
            onComplete?.();
            void reload();
            onNotify("Датасет обновлён.", "success");
          }
        } else {
          knownRuns.current.delete(id);
          completionCallbacks.current.delete(done.id);
          void reload();
          update(id, {
            busy: false,
            error: done.error || "Не удалось обновить датасет.",
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const missing =
            error instanceof ApiRequestError && error.status === 404;
          if (missing) {
            knownRuns.current.delete(id);
            completionCallbacks.current.delete(run.id);
          }
          update(id, {
            busy: false,
            run: missing ? undefined : latest,
            error: describeError(error).details,
          });
        }
      } finally {
        if (pollers.current.get(id) === controller) pollers.current.delete(id);
      }
    },
    [onNotify, reload, update],
  );

  const recover = useCallback(async () => {
    if (lifetime.current?.signal.aborted) return;
    recoveryRequest.current?.abort();
    const controller = new AbortController();
    recoveryRequest.current = controller;
    try {
      const active = await api<{ datasetId: string; run: QueryRun }[]>(
        "/api/datasets/refreshes",
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const runs = new Map(knownRuns.current);
      for (const { datasetId, run } of active) runs.set(datasetId, run);
      for (const [id, run] of runs) {
        if (
          !pollers.current.has(id) &&
          !starting.current.has(id) &&
          !acting.current.has(id)
        )
          void track(id, run, true);
      }
    } catch {
      // Reconnect and conflicting starts can retry discovery. A refresh start
      // remains protected by the server even when this request fails.
    } finally {
      if (!controller.signal.aborted) setRecovering(false);
    }
  }, [track]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    const rehydrate = () => {
      void reload();
      void recover();
    };
    rehydrate();
    const unsubscribe = sync?.subscribe((event) => {
      if (event.type === "datasets.changed") void reload();
      if (event.type === "datasets.refreshes") void recover();
    });
    const reconnect = sync?.onReconnect(rehydrate);
    return () => {
      controller.abort();
      request.current?.abort();
      recoveryRequest.current?.abort();
      for (const poller of pollers.current.values()) poller.abort();
      pollers.current.clear();
      knownRuns.current.clear();
      completionCallbacks.current.clear();
      unsubscribe?.();
      reconnect?.();
    };
  }, [sync, reload, recover]);

  async function refresh(
    { id, revision }: DatasetRevision,
    source?: QuerySource,
    onComplete?: () => void,
  ) {
    const signal = lifetime.current?.signal;
    if (
      starting.current.has(id) ||
      acting.current.has(id) ||
      pollers.current.has(id) ||
      refreshes[id]?.run ||
      recovering ||
      signal?.aborted
    )
      return;
    starting.current.add(id);
    update(id, { busy: true });
    try {
      const run = await api<QueryRun>(`${datasetPath(id)}/refresh`, {
        method: "POST",
        body: json({
          baseRevision: revision,
          source,
          mutationId: crypto.randomUUID(),
        }),
        signal,
      });
      if (!signal?.aborted) {
        if (onComplete) completionCallbacks.current.set(run.id, onComplete);
        void track(id, run);
      }
    } catch (error) {
      if (!signal?.aborted) {
        update(id, { busy: false, error: describeError(error).details });
        void recover();
        if (
          error instanceof ApiRequestError &&
          (error.status === 404 || error.status === 409)
        )
          void reload();
      }
    } finally {
      starting.current.delete(id);
    }
  }

  async function act(id: string, action: RefreshAction) {
    const run = refreshes[id]?.run;
    const signal = lifetime.current?.signal;
    if (!run || acting.current.has(id) || signal?.aborted) return;
    acting.current.add(id);
    update(id, { busy: true, run, action });
    try {
      const next =
        action === "track"
          ? run
          : await api<QueryRun>(
              `/api/query-runs/${encodeURIComponent(run.id)}/${action}`,
              { method: "POST", signal },
            );
      if (!signal?.aborted) void track(id, next);
    } catch (error) {
      if (!signal?.aborted)
        update(id, { busy: false, run, error: describeError(error).details });
    } finally {
      acting.current.delete(id);
    }
  }

  return (
    <CatalogContext.Provider
      value={{
        items,
        loading,
        error,
        reload,
        recovering,
        refreshes,
        refresh,
        act,
      }}
    >
      {children}
    </CatalogContext.Provider>
  );
}
