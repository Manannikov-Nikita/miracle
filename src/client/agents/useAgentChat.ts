import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentChat,
  AgentConversation,
  AgentMessage,
  AgentProfile,
  AgentTurn,
  ProjectContext,
} from "../../shared/agents";
import { api, json } from "../api";
import { useProjectSync } from "./ProjectSync";
export function useAgentChat() {
  const project = useProjectSync();
  const [resolvedApprovals, setResolvedApprovals] = useState(
    new Map<string, "allow" | "deny">(),
  );
  const [profiles, setProfiles] = useState<AgentProfile[]>([]),
    [chats, setChats] = useState<AgentChat[]>([]);
  const [projectRoot, setProjectRoot] = useState(""),
    [selected, setSelected] = useState("");
  const [conversation, setConversation] = useState<AgentConversation | null>(
      null,
    ),
    [active, setActive] = useState<AgentTurn | null>(null);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(false),
    [open, setOpen] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const openRef = useRef(open);
  openRef.current = open;
  const mounted = useRef(true),
    generation = useRef(0);
  const initialized = useRef(false);
  const turnEpoch = useRef(0),
    messageEpoch = useRef(0),
    refreshSequence = useRef(0);
  const terminalTurns = useRef(new Set<string>());
  const sendRequests = useRef(
    new Map<
      string,
      {
        chatId: string;
        context: import("../../shared/agents").AgentTargetContext;
      }
    >(),
  );
  const refresh = useCallback(async () => {
    const epoch = turnEpoch.current,
      sequence = ++refreshSequence.current;
    const [p, c, s, context] = await Promise.all([
      api<AgentProfile[]>("/api/agent-profiles"),
      api<AgentChat[]>("/api/chats"),
      api<{ activeTurn: AgentTurn | null }>("/api/agent-state"),
      api<ProjectContext>("/api/project"),
    ]);
    if (!mounted.current || sequence !== refreshSequence.current) return;
    setProfiles(p);
    setChats(c);
    if (epoch === turnEpoch.current)
      setActive(
        s.activeTurn && !terminalTurns.current.has(s.activeTurn.id)
          ? s.activeTurn
          : null,
      );
    setProjectRoot(context.projectRoot);
    const firstLoad = !initialized.current;
    initialized.current = true;
    setSelected((id) =>
      c.some((x) => x.id === id)
        ? id
        : firstLoad
          ? s.activeTurn?.chatId || c[0]?.id || ""
          : "",
    );
  }, []);
  const loadConversation = useCallback(async (id: string) => {
    const sequence = ++generation.current,
      epoch = messageEpoch.current;
    if (!id) {
      setConversation(null);
      return;
    }
    const value = await api<AgentConversation>(`/api/chats/${id}`);
    if (
      mounted.current &&
      sequence === generation.current &&
      id === selectedRef.current
    )
      setConversation((current) => {
        if (
          epoch === messageEpoch.current ||
          current?.chat.id !== value.chat.id
        )
          return value;
        const messages = new Map(
          value.messages.map((message) => [message.id, message]),
        );
        for (const message of current.messages)
          messages.set(message.id, message);
        return { ...value, messages: [...messages.values()] };
      });
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      mounted.current = false;
    };
  }, [refresh]);
  useEffect(() => {
    setConversation(null);
    void loadConversation(selected).catch((e) => setError(e.message));
  }, [selected, loadConversation]);
  useEffect(() => {
    if (!project) return;
    const reconnect = project.onReconnect(() => {
      void refresh()
        .then(() => loadConversation(selectedRef.current))
        .catch((e) => setError(e.message));
    });
    const unsubscribe = project.subscribe((event) => {
      if (event.type === "turn.updated") {
        const turn = event.data as AgentTurn;
        turnEpoch.current++;
        if (!["running", "waiting"].includes(turn.status))
          terminalTurns.current.add(turn.id);
        setActive((current) =>
          ["running", "waiting"].includes(turn.status) &&
          !terminalTurns.current.has(turn.id)
            ? turn
            : current?.id === turn.id
              ? null
              : current,
        );
        if (!openRef.current) setUnread(true);
        if (turn.chatId === selectedRef.current)
          void loadConversation(turn.chatId).catch((e) => setError(e.message));
      }
      if (event.type === "agent.event") {
        const message = event.data as AgentMessage;
        messageEpoch.current++;
        if (!openRef.current || message.chatId !== selectedRef.current)
          setUnread(true);
        if (message.chatId === selectedRef.current)
          setConversation((current) =>
            current
              ? {
                  ...current,
                  messages: current.messages.some((m) => m.id === message.id)
                    ? current.messages.map((m) =>
                        m.id === message.id ? message : m,
                      )
                    : [...current.messages, message],
                }
              : current,
          );
      }
      if (event.type === "profiles.changed" || event.type === "chat.updated")
        void refresh().catch((e) => setError(e.message));
    });
    return () => {
      reconnect();
      unsubscribe();
    };
  }, [project, refresh, loadConversation]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  const create = async (profileId: string) => {
    const chat = await api<AgentChat>("/api/chats", {
      method: "POST",
      body: json({ profileId }),
    });
    setChats((items) => [chat, ...items]);
    setSelected(chat.id);
    return chat;
  };
  const send = async (
    content: string,
    profileId: string,
    clientRequestId: string,
    onCreated?: (id: string) => void,
  ) =>
    action(async () => {
      const selectedChat = selectedRef.current;
      const retry = sendRequests.current.get(clientRequestId);
      const context = retry?.context || (await project?.prepare()) || {};
      let chatId = retry?.chatId || selectedChat;
      if (!chatId) {
        const chat = await create(profileId);
        chatId = chat.id;
        onCreated?.(chat.id);
      }
      sendRequests.current.set(clientRequestId, { chatId, context });
      const turn = await api<AgentTurn>(`/api/chats/${chatId}/messages`, {
        method: "POST",
        body: json({ content, context, clientRequestId }),
      });
      if (!terminalTurns.current.has(turn.id)) setActive(turn);
      sendRequests.current.delete(clientRequestId);
      await loadConversation(chatId).catch((e) => setError(e.message));
    });
  return {
    profiles,
    resolvedApprovals,
    chats,
    projectRoot,
    selected,
    setSelected,
    conversation,
    active,
    error,
    setError,
    loading,
    busy,
    unread,
    open,
    toggle: () =>
      setOpen((value) => {
        if (!value) setUnread(false);
        return !value;
      }),
    close: () => setOpen(false),
    refresh,
    action,
    create,
    send,
    stop: () =>
      action(async () => {
        if (!active) return;
        await api(`/api/agent-turns/${active.id}/cancel`, { method: "POST" });
        await refresh();
      }),
    approve: (id: string, decision: "allow" | "deny") =>
      action(async () => {
        await api(`/api/agent-approvals/${id}`, {
          method: "POST",
          body: json({ decision }),
        });
        setResolvedApprovals((items) => new Map(items).set(id, decision));
        await loadConversation(selectedRef.current);
        await refresh();
      }),
  };
}
export type AgentChatState = ReturnType<typeof useAgentChat>;
