import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentChat,
  AgentConversation,
  AgentMessage,
  AgentProfile,
  AgentTurn,
  AgentTargetContext,
  AgentImageInput,
  AgentModelSettings,
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
  const [newAutoApprove, setNewAutoApprove] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [modelSettingsBusy, setModelSettingsBusy] = useState(false);
  const [newModelDraft, setNewModelDraft] = useState<{
    profileId: string;
    settings?: AgentModelSettings;
  }>({ profileId: "" });
  const modelDraftRef = useRef(newModelDraft);
  const modelSaving = useRef<{ chatId: string; promise: Promise<void> } | null>(
    null,
  );
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  const chatEpoch = useRef(0);
  const approvalChanging = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const activeRef = useRef(active);
  activeRef.current = active;
  const openRef = useRef(open);
  openRef.current = open;
  const mounted = useRef(true),
    generation = useRef(0);
  const initialized = useRef(false);
  const turnEpoch = useRef(0),
    messageEpoch = useRef(0),
    refreshSequence = useRef(0);
  const terminalTurns = useRef(new Set<string>());
  const setModelProfile = useCallback((profileId: string) => {
    if (modelDraftRef.current.profileId === profileId) return;
    modelDraftRef.current = { profileId };
    setNewModelDraft(modelDraftRef.current);
  }, []);
  const selectChat = useCallback((id: string) => {
    selectedRef.current = id;
    setSelected(id);
    if (!id) {
      modelDraftRef.current = { profileId: modelDraftRef.current.profileId };
      setNewModelDraft(modelDraftRef.current);
    }
  }, []);
  const sendRequests = useRef(
    new Map<
      string,
      {
        chatId: string;
        turnId?: string;
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
    chatEpoch.current++;
    chatsRef.current = c;
    setChats(c);
    setConversation((current) => {
      const chat = c.find((item) => item.id === current?.chat.id);
      return current && chat ? { ...current, chat } : current;
    });
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
      epoch = messageEpoch.current,
      metadataEpoch = chatEpoch.current;
    if (!id) {
      setConversation(null);
      return;
    }
    const value = await api<AgentConversation>(`/api/chats/${id}`);
    if (
      mounted.current &&
      sequence === generation.current &&
      id === selectedRef.current
    ) {
      // A later chat.updated event wins over a conversation fetch begun before it.
      const chat =
        metadataEpoch === chatEpoch.current
          ? value.chat
          : (chatsRef.current.find((item) => item.id === id) ?? value.chat);
      chatsRef.current = chatsRef.current.map((item) =>
        item.id === id ? chat : item,
      );
      setChats(chatsRef.current);
      setConversation((current) => {
        if (
          epoch === messageEpoch.current ||
          current?.chat.id !== value.chat.id
        )
          return { ...value, chat };
        const messages = new Map(
          value.messages.map((message) => [message.id, message]),
        );
        for (const message of current.messages)
          messages.set(message.id, message);
        return { ...value, chat, messages: [...messages.values()] };
      });
    }
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
      if (event.type === "chat.updated") {
        chatEpoch.current++;
        const chat = event.data as AgentChat;
        if (chat?.id && chat.profileId) {
          chatsRef.current = chatsRef.current.map((item) =>
            item.id === chat.id ? chat : item,
          );
          setChats(chatsRef.current);
          setConversation((current) =>
            current?.chat.id === chat.id ? { ...current, chat } : current,
          );
        }
      }
      if (event.type === "profiles.changed" || event.type === "chat.updated")
        void refresh().catch((e) => setError(e.message));
    });
    return () => {
      reconnect();
      unsubscribe();
    };
  }, [project, refresh, loadConversation]);
  const action = async (fn: () => Promise<void>, interaction = false) => {
    const setPending = interaction ? setInteractionBusy : setBusy;
    setPending(true);
    if (!interaction) busyRef.current = true;
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setPending(false);
      if (!interaction) busyRef.current = false;
    }
  };
  const create = async (profileId: string) => {
    const modelSettings =
      modelDraftRef.current.profileId === profileId
        ? modelDraftRef.current.settings
        : undefined;
    const chat = await api<AgentChat>("/api/chats", {
      method: "POST",
      body: json({ profileId, autoApprove: newAutoApprove, modelSettings }),
    });
    chatsRef.current = [
      chat,
      ...chatsRef.current.filter((item) => item.id !== chat.id),
    ];
    setChats(chatsRef.current);
    selectChat(chat.id);
    setNewAutoApprove(false);
    modelDraftRef.current = { profileId };
    setNewModelDraft(modelDraftRef.current);
    return chat;
  };
  const setModelSettings = async (
    settings: AgentModelSettings,
    profileId: string,
  ) => {
    const id = selectedRef.current;
    if (activeRef.current?.chatId === id && id)
      throw new Error(
        "Дождитесь завершения текущей задачи, чтобы изменить модель.",
      );
    if (busyRef.current)
      throw new Error("Дождитесь завершения отправки сообщения.");
    if (modelSaving.current) return modelSaving.current.promise;
    if (!id) {
      modelDraftRef.current = { profileId, settings: { ...settings } };
      setNewModelDraft(modelDraftRef.current);
      return;
    }
    setModelSettingsBusy(true);
    setError("");
    const promise = (async () => {
      try {
        await api<AgentChat>(`/api/chats/${id}`, {
          method: "PATCH",
          body: json({ modelSettings: settings }),
        });
        // Read current metadata: another tab may have saved after this PATCH.
        await refresh();
      } catch (error) {
        if (mounted.current) setError((error as Error).message);
        throw error;
      } finally {
        modelSaving.current = null;
        if (mounted.current) setModelSettingsBusy(false);
      }
    })();
    modelSaving.current = { chatId: id, promise };
    return promise;
  };
  const send = async (
    content: string,
    profileId: string,
    clientRequestId: string,
    onCreated?: (id: string) => void,
    references: Partial<AgentTargetContext> = {},
    images: AgentImageInput[] = [],
  ) =>
    action(async () => {
      const selectedChat = selectedRef.current;
      const settingsWrite = modelSaving.current;
      if (settingsWrite?.chatId === selectedChat) await settingsWrite.promise;
      const retry = sendRequests.current.get(clientRequestId);
      // Capture the destination before flushing editor/board writes. A turn
      // ending while prepare() awaits must not turn this input into a new task.
      const activeTurn = activeRef.current;
      if (!retry && activeTurn && activeTurn.chatId !== selectedChat)
        throw new Error("Откройте работающий чат, чтобы направить агента");
      const turnId = retry ? retry.turnId : activeTurn?.id;
      const context =
        retry?.context ||
        (await project?.prepare(references)) ||
        structuredClone(references);
      let chatId = retry?.chatId || selectedChat;
      if (!chatId) {
        const chat = await create(profileId);
        chatId = chat.id;
        onCreated?.(chat.id);
      }
      sendRequests.current.set(clientRequestId, { chatId, turnId, context });
      const turn = await api<AgentTurn>(
        turnId
          ? `/api/agent-turns/${turnId}/steer`
          : `/api/chats/${chatId}/messages`,
        {
          method: "POST",
          body: json({ content, context, clientRequestId, images }),
        },
      );
      if (
        ["running", "waiting"].includes(turn.status) &&
        !terminalTurns.current.has(turn.id)
      )
        setActive(turn);
      sendRequests.current.delete(clientRequestId);
      await loadConversation(chatId).catch((e) => setError(e.message));
    });
  return {
    profiles,
    modelSettings: selected
      ? (
          chats.find((chat) => chat.id === selected) ??
          (conversation?.chat.id === selected ? conversation.chat : undefined)
        )?.modelSettings
      : newModelDraft.settings,
    modelSettingsBusy,
    setModelSettings,
    setModelProfile,
    autoApprove: selected
      ? Boolean(
          chats.find((chat) => chat.id === selected)?.autoApprove ??
          (conversation?.chat.id === selected && conversation.chat.autoApprove),
        )
      : newAutoApprove,
    approvalBusy,
    interactionBusy,
    setAutoApprove: async (enabled: boolean) => {
      if (approvalChanging.current) return;
      const id = selectedRef.current;
      if (!id) {
        setNewAutoApprove(enabled);
        return;
      }
      approvalChanging.current = true;
      setApprovalBusy(true);
      setError("");
      try {
        await api<AgentChat>(`/api/chats/${id}`, {
          method: "PATCH",
          body: json({ autoApprove: enabled }),
        });
        // Another tab may change the policy before this response arrives.
        // Reconcile with the server instead of replacing a newer SSE refresh.
        await refresh();
      } catch (error) {
        setError((error as Error).message);
        throw error;
      } finally {
        approvalChanging.current = false;
        setApprovalBusy(false);
      }
    },
    resolvedApprovals,
    chats,
    projectRoot,
    selected,
    setSelected: selectChat,
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
    answerQuestion: (id: string, answers: Record<string, string[]>) =>
      action(async () => {
        const message = await api<AgentMessage>(`/api/agent-questions/${id}`, {
          method: "POST",
          body: json({ answers }),
        });
        messageEpoch.current++;
        if (selectedRef.current === message.chatId)
          setConversation((current) =>
            current?.chat.id === message.chatId
              ? {
                  ...current,
                  messages: current.messages.map((item) =>
                    item.id === message.id ? message : item,
                  ),
                }
              : current,
          );
        await refresh();
      }, true),
    stop: () =>
      action(async () => {
        if (!active) return;
        await api(`/api/agent-turns/${active.id}/cancel`, { method: "POST" });
        await refresh();
      }, true),
    approve: (id: string, decision: "allow" | "deny") =>
      action(async () => {
        await api(`/api/agent-approvals/${id}`, {
          method: "POST",
          body: json({ decision }),
        });
        setResolvedApprovals((items) => new Map(items).set(id, decision));
        await loadConversation(selectedRef.current);
        await refresh();
      }, true),
  };
}
export type AgentChatState = ReturnType<typeof useAgentChat>;
