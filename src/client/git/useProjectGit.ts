import { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatus } from "../../shared/project-git";
import { api, json } from "../api";

export type GitAction = "commit" | "branches" | "switch";
const changedEvent = "miracle:git-status-changed";
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Не удалось получить состояние Git";

function checkedStatus(value: GitStatus): GitStatus {
  if (
    !value ||
    !["ready", "not_repository", "unavailable"].includes(value.state) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.branches) ||
    !Array.isArray(value.worktrees) ||
    !value.counts ||
    typeof value.revision !== "string"
  )
    throw new Error(
      "Сервер вернул неизвестное состояние Git. Обновите страницу.",
    );
  return value;
}

export function useProjectGit(
  workspaceId: string,
  onCheckoutChanged: () => Promise<void>,
) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = useRef<GitStatus | null>(null);
  const pending = useRef(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const checkoutChanged = useRef(onCheckoutChanged);
  checkoutChanged.current = onCheckoutChanged;
  const apply = useCallback((next: GitStatus) => {
    current.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    if (pending.current) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const next = checkedStatus(await api<GitStatus>("/api/project/git"));
      if (!mounted.current || sequence.current !== request) return;
      const previous = current.current;
      const checkoutMoved =
        previous?.state === "ready" &&
        next.state === "ready" &&
        (previous.root !== next.root ||
          previous.branch !== next.branch ||
          previous.head !== next.head);
      apply(next);
      setError("");
      if (checkoutMoved) await checkoutChanged.current();
    } catch (cause) {
      if (mounted.current && sequence.current === request)
        setError(errorText(cause));
    } finally {
      if (mounted.current && sequence.current === request) setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const fromOtherControl = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string }>).detail;
      if (detail?.workspaceId === workspaceId) visibleRefresh();
    };
    void refresh();
    const timer = window.setInterval(visibleRefresh, 10_000);
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    window.addEventListener(changedEvent, fromOtherControl);
    return () => {
      mounted.current = false;
      sequence.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
      window.removeEventListener(changedEvent, fromOtherControl);
    };
  }, [refresh, workspaceId]);

  const mutate = async (
    action: GitAction,
    body: Record<string, unknown>,
    before: () => Promise<void>,
    after?: () => Promise<void>,
  ) => {
    const previous = current.current;
    if (pending.current || !previous || previous.state !== "ready")
      return false;
    if (!previous.canMutate) {
      setError(
        previous.mutationBlockedReason || "Изменения Git сейчас недоступны",
      );
      return false;
    }
    pending.current = true;
    const request = ++sequence.current;
    setBusy(true);
    setLoading(false);
    setError("");
    try {
      await before();
      if (!mounted.current || sequence.current !== request) return false;
      const next = checkedStatus(
        await api<GitStatus>(`/api/project/git/${action}`, {
          method: "POST",
          body: json({ ...body, revision: previous.revision }),
        }),
      );
      if (!mounted.current || sequence.current !== request) return false;
      apply(next);
      window.dispatchEvent(
        new CustomEvent(changedEvent, { detail: { workspaceId } }),
      );
      await after?.();
      return true;
    } catch (cause) {
      if (mounted.current && sequence.current === request)
        setError(errorText(cause));
      return false;
    } finally {
      pending.current = false;
      if (mounted.current && sequence.current === request) setBusy(false);
    }
  };
  return { status, error, loading, busy, refresh, mutate };
}

export type ProjectGitState = ReturnType<typeof useProjectGit>;
