import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionInput } from "../../shared/types";
import { api, json } from "../api";

type LoginResponse = {
  id: string;
  status: "pending" | "authenticated";
  redirectUrl?: string;
};
type LoginState =
  | { status: "idle" | "starting" }
  | LoginResponse
  | { status: "error"; error: unknown };
type Attempt = {
  form: ConnectionInput;
  connectionId?: string;
  id?: string;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
};

const discard = (id: string) =>
  api(`/api/connections/auth/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).catch(() => {});

export function useTrinoLogin(
  form: ConnectionInput,
  connectionId: string | undefined,
  enabled: boolean,
) {
  const [state, setState] = useState<LoginState>({ status: "idle" });
  const active = useRef<Attempt | undefined>(undefined);
  const input = useRef({ form, connectionId, enabled });
  input.current = { form, connectionId, enabled };

  const release = useCallback(() => {
    const attempt = active.current;
    active.current = undefined;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    if (attempt.id) void discard(attempt.id);
  }, []);
  const cancel = useCallback(() => {
    release();
    setState({ status: "idle" });
  }, [release]);

  useEffect(() => {
    cancel();
    return release;
  }, [form, connectionId, enabled, cancel, release]);

  async function start() {
    if (!input.current.enabled) return;
    release();
    const attempt: Attempt = {
      form,
      connectionId,
      controller: new AbortController(),
    };
    active.current = attempt;
    setState({ status: "starting" });
    const current = () =>
      active.current === attempt &&
      input.current.enabled &&
      input.current.form === attempt.form &&
      input.current.connectionId === attempt.connectionId;
    const fail = (error: unknown) => {
      if (!current()) return;
      release();
      setState({ status: "error", error });
    };
    const poll = async () => {
      if (!current() || !attempt.id) return;
      try {
        const result = await api<Pick<LoginResponse, "status">>(
          `/api/connections/auth/${encodeURIComponent(attempt.id)}/poll`,
          { method: "POST", signal: attempt.controller.signal },
        );
        if (!current()) return;
        if (result.status === "authenticated")
          setState({ id: attempt.id, status: "authenticated" });
        else attempt.timer = setTimeout(() => void poll(), 1000);
      } catch (error) {
        fail(error);
      }
    };
    try {
      // Keep the start response readable after cancellation so a late session
      // can be deleted instead of leaving an orphaned login on the server.
      const result = await api<LoginResponse>("/api/connections/auth/start", {
        method: "POST",
        body: json({
          ...form,
          password: form.password || undefined,
          id: connectionId,
        }),
      });
      if (!current()) {
        void discard(result.id);
        return;
      }
      attempt.id = result.id;
      setState(result);
      if (result.status === "pending")
        attempt.timer = setTimeout(() => void poll(), 1000);
    } catch (error) {
      fail(error);
    }
  }

  return {
    state,
    start,
    cancel,
    pending: state.status === "starting" || state.status === "pending",
    authSessionId: state.status === "authenticated" ? state.id : undefined,
  };
}
