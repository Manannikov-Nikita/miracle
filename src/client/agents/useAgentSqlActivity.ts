import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSqlActivity } from "../../shared/agent-sql-activity";
import { api } from "../api";
import { useProjectSync } from "./ProjectSync";

type ActivitySnapshot = {
  chatId: string;
  data: AgentSqlActivity | null;
  loading: boolean;
  error: string;
};
type ActivityOptions = {
  chatId: string;
  open: boolean;
  turnId: string | null;
  turnActive: boolean;
};
const unfinished = new Set(["running", "cancelling", "paused"]);

export function useAgentSqlActivity({
  chatId,
  open,
  turnId,
  turnActive,
}: ActivityOptions) {
  const project = useProjectSync();
  const cache = useRef(new Map<string, AgentSqlActivity>());
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [snapshot, setSnapshot] = useState<ActivitySnapshot>({
    chatId,
    data: null,
    loading: false,
    error: "",
  });
  const refresh = useCallback(async () => {
    if (!open || !chatId) return;
    const sequence = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setSnapshot((previous) => ({
      chatId,
      data: cache.current.get(chatId) || null,
      loading: true,
      error: previous.chatId === chatId ? previous.error : "",
    }));
    try {
      const data = await api<AgentSqlActivity>(
        `/api/chats/${encodeURIComponent(chatId)}/sql-activity`,
        { signal: request.signal },
      );
      if (sequence !== generation.current || request.signal.aborted) return;
      if (
        !data ||
        !Array.isArray(data.runs) ||
        !Number.isSafeInteger(data.activeCount)
      )
        throw new Error("Сервер вернул некорректные данные активности SQL");
      cache.current.set(chatId, data);
      setSnapshot({ chatId, data, loading: false, error: "" });
    } catch (error) {
      if (sequence !== generation.current || request.signal.aborted) return;
      setSnapshot({
        chatId,
        data: cache.current.get(chatId) || null,
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Не удалось обновить активность SQL",
      });
    }
  }, [chatId, open]);

  useEffect(() => {
    setSnapshot({
      chatId,
      data: cache.current.get(chatId) || null,
      loading: false,
      error: "",
    });
    void refresh();
    return () => {
      generation.current++;
      controller.current?.abort();
    };
  }, [chatId, open, turnId, turnActive, refresh]);

  const current =
    snapshot.chatId === chatId
      ? snapshot
      : { chatId, data: null, loading: Boolean(chatId && open), error: "" };
  const hasOwnedWork =
    current.data?.runs.some((run) => unfinished.has(run.status)) || false;
  useEffect(() => {
    if (!open || !chatId || current.loading || !(turnActive || hasOwnedWork))
      return;
    const timer = setTimeout(() => void refresh(), 1500);
    return () => clearTimeout(timer);
  }, [
    open,
    chatId,
    current.loading,
    current.data,
    current.error,
    turnActive,
    hasOwnedWork,
    refresh,
  ]);

  useEffect(() => {
    if (!open || !chatId || !project) return;
    const reconnect = project.onReconnect(() => void refresh());
    // Reconcile the final SQL state even if the parent finishes between polls.
    const unsubscribe = project.subscribe((event) => {
      if (event.type !== "turn.updated") return;
      const turn = event.data as { chatId?: string };
      if (turn.chatId === chatId) void refresh();
    });
    return () => {
      reconnect();
      unsubscribe();
    };
  }, [open, chatId, project, refresh]);

  return { ...current, stale: Boolean(current.error && current.data), refresh };
}
