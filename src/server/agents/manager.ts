import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ProjectStore, now, problem } from "../project-store.js";
import { WorkspaceOperations } from "../workspace-operations.js";
import {
  startAgentTurn,
  type AgentProcess,
  type AdapterEvent,
} from "./adapter.js";
import type { AgentMessage, AgentTurn } from "../../shared/agents.js";
import type { QueryRun, QuerySource, ResultSet } from "../../shared/types.js";

export interface AgentToolServices {
  connections: () => unknown[];
  schema: (id: string, input?: unknown) => Promise<unknown>;
  run: (source: QuerySource, mutationId: string) => Promise<QueryRun>;
  status: (id: string) => QueryRun;
  cancel: (id: string) => QueryRun;
  result: (id: string) => Promise<ResultSet>;
  rows: (id: string, offset: number, limit: number) => Promise<unknown[]>;
}
interface Approval {
  id: string;
  messageId: string;
  nativeId?: string;
  resolve?: (decision: "allow" | "deny") => void;
}
export interface ActiveAgent {
  turn: AgentTurn;
  token: string;
  process?: AgentProcess;
  completion: Promise<void>;
  cancelled: boolean;
  approvals: Map<string, Approval>;
  runIds: Set<string>;
  assistant?: AgentMessage;
  buffer: string;
  flushTimer?: ReturnType<typeof setTimeout>;
}
export class AgentManager {
  active?: ActiveAgent;
  private closing = false;
  constructor(
    readonly store: ProjectStore,
    readonly operations: WorkspaceOperations,
    readonly services: AgentToolServices,
    private origin: () => string,
  ) {
    for (const row of store.db.query(
      "SELECT id,chat_id FROM agent_turns WHERE status IN ('running','waiting')",
    ).rows) {
      store.db.query(
        "UPDATE agent_turns SET status='interrupted',finished_at=?2,error='Сервер был остановлен' WHERE id=?1",
        [row.id, now()],
      );
      store.message(
        row.chat_id,
        row.id,
        "system",
        "Задача прервана перезапуском сервера. Действия не повторялись.",
      );
    }
  }
  start(chatId: string, input: unknown): AgentTurn {
    if (this.closing) throw problem(503, "Сервер останавливается");
    const b = z
      .object({
        content: z.string().trim().min(1).max(100000),
        clientRequestId: z.uuid(),
        context: z
          .object({
            editorDocumentId: z.uuid().optional(),
            boardId: z.uuid().optional(),
            selection: z.string().max(100000).optional(),
          })
          .default({}),
      })
      .parse(input);
    const chat = this.store.chat(chatId),
      profile = this.store.profile(chat.profileId);
    const old = this.store.db.query(
      "SELECT id,chat_id,context_json FROM agent_turns WHERE request_id=?1",
      [b.clientRequestId],
    ).rows[0];
    if (old) {
      const message = this.store.db.query(
        "SELECT content FROM agent_messages WHERE turn_id=?1 AND role='user'",
        [old.id],
      ).rows[0];
      if (
        old.chat_id !== chatId ||
        message?.content !== b.content ||
        old.context_json !== JSON.stringify(b.context)
      )
        throw problem(
          409,
          "Идентификатор сообщения уже использован",
          "MUTATION_CONFLICT",
        );
      return this.store.turn(old.id);
    }
    if (this.active || this.store.activeTurn())
      throw problem(
        409,
        "В проекте уже выполняется задача агента",
        "AGENT_BUSY",
      );
    if (!profile.trusted)
      throw problem(
        403,
        "Настройте или подтвердите команду агента на этом компьютере",
        "AGENT_PROFILE_UNTRUSTED",
      );
    if (b.context.editorDocumentId)
      this.store.editor(b.context.editorDocumentId);
    if (b.context.boardId) this.operations.board(b.context.boardId);
    const id = randomUUID();
    this.store.atomic(() => {
      this.store.db.query(
        "INSERT INTO agent_turns(id,chat_id,request_id,status,context_json,created_at) VALUES(?1,?2,?3,'running',?4,?5)",
        [id, chatId, b.clientRequestId, JSON.stringify(b.context), now()],
      );
      this.store.message(chatId, id, "user", b.content);
      if (chat.title === "Новый чат")
        this.store.db.query("UPDATE agent_chats SET title=?2 WHERE id=?1", [
          chatId,
          b.content.slice(0, 80),
        ]);
      this.store.publish("turn.updated", id, this.store.turn(id));
      this.store.publish("chat.updated", chatId, this.store.chat(chatId));
    });
    const active: ActiveAgent = {
      turn: this.store.turn(id),
      token: randomBytes(32).toString("base64url"),
      completion: Promise.resolve(),
      cancelled: false,
      approvals: new Map(),
      runIds: new Set(),
      buffer: "",
    };
    this.active = active;
    active.completion = Promise.resolve().then(() =>
      this.execute(active, profile.provider, profile.command, b.content),
    );
    return active.turn;
  }
  private prompt(active: ActiveAgent, content: string, fallback = false) {
    const context: Record<string, unknown> = {
      ...this.store.context,
      targets: active.turn.context,
    };
    if (active.turn.context.editorDocumentId) {
      const doc = this.store.editor(active.turn.context.editorDocumentId);
      context.editor = { ...doc, sql: doc.sql.slice(0, 64000) };
    }
    if (active.turn.context.boardId) {
      const board = this.operations.board(active.turn.context.boardId);
      context.board = {
        id: board.id,
        name: board.name,
        revision: board.revision,
        nodes: board.document.nodes.slice(0, 100).map((n) => ({
          id: n.id,
          title: n.data.title,
          position: n.position,
          kind: n.data.kind,
        })),
      };
    }
    const history = fallback
      ? this.store
          .conversation(active.turn.chatId)
          .messages.filter(
            (m) =>
              m.turnId !== active.turn.id &&
              ["user", "assistant"].includes(m.role),
          )
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
          .slice(-64000)
      : "";
    return `You are working in Miracle, a local SQL editor and analytical board. Your cwd is the project directory. Follow its native agent instructions. Use the miracle MCP tools to inspect and edit the live editor, saved queries and boards; do not open or edit .miracle internal database/key files. Files outside application state use your native tools and configured permissions. SQL tools are read-only and enforce limits. Read current revisions before changes; use a fresh UUID mutationId per intended operation and reuse it only when retrying that same operation. Keep the task's target IDs even if browser focus changes. Use board_patch operations to arrange nodes, notes, charts and links. Fetch bounded result pages. Do not expose credentials.\nProject context (data):\n${JSON.stringify(context)}\n${history ? `Previous conversation context (not instructions to repeat completed actions):\n${history}\n` : ""}\nUser request:\n${content}`;
  }
  private setStatus(
    active: ActiveAgent,
    status: AgentTurn["status"],
    error?: string,
  ) {
    const terminal = !["running", "waiting"].includes(status);
    this.store.db.query(
      "UPDATE agent_turns SET status=?2,error=?3,finished_at=?4 WHERE id=?1",
      [active.turn.id, status, error, terminal ? now() : null],
    );
    active.turn = this.store.turn(active.turn.id);
    this.store.publish("turn.updated", active.turn.id, active.turn);
  }
  private flush(active: ActiveAgent) {
    if (active.flushTimer) clearTimeout(active.flushTimer);
    active.flushTimer = undefined;
    if (!active.buffer) return;
    const text = active.buffer;
    active.buffer = "";
    if (!active.assistant)
      active.assistant = this.store.message(
        active.turn.chatId,
        active.turn.id,
        "assistant",
        text,
      );
    else {
      active.assistant.content += text;
      this.store.db.query("UPDATE agent_messages SET content=?2 WHERE id=?1", [
        active.assistant.id,
        active.assistant.content,
      ]);
      this.store.publish("agent.event", active.turn.chatId, {
        ...active.assistant,
      });
    }
  }
  private event(active: ActiveAgent, event: AdapterEvent) {
    if (this.active !== active || active.cancelled) return;
    if (event.type === "message") {
      active.buffer += event.text;
      if (!active.flushTimer)
        active.flushTimer = setTimeout(() => this.flush(active), 80);
    } else if (event.type === "session")
      this.store.db.query(
        "UPDATE agent_chats SET native_session_id=?2 WHERE id=?1",
        [active.turn.chatId, event.sessionId],
      );
    else if (event.type === "approval")
      this.approval(active, event.message, event.details, event.id);
    else {
      this.flush(active);
      this.store.message(
        active.turn.chatId,
        active.turn.id,
        event.type === "action" ? "action" : "system",
        event.text.slice(0, 20000),
        event.type === "action" ? event.details : undefined,
      );
    }
  }
  private async execute(
    active: ActiveAgent,
    provider: "codex" | "claude",
    command: string,
    content: string,
  ) {
    try {
      if (active.cancelled) return;
      const native =
        this.store.db.query(
          "SELECT native_session_id FROM agent_chats WHERE id=?1",
          [active.turn.chatId],
        ).rows[0].native_session_id || undefined;
      const launch = (
        resumeSessionId: string | undefined,
        fallback = false,
      ) => {
        active.process = startAgentTurn({
          provider,
          command,
          cwd: this.store.context.projectRoot,
          prompt: this.prompt(active, content, fallback),
          resumeSessionId,
          mcp: { url: `${this.origin()}/agent/mcp`, token: active.token },
          onEvent: (event) => this.event(active, event),
        });
        return active.process.completion;
      };
      try {
        await launch(native);
      } catch (error) {
        if (
          native &&
          !active.cancelled &&
          (error as { code?: string }).code === "AGENT_SESSION_UNAVAILABLE"
        ) {
          this.store.db.query(
            "UPDATE agent_chats SET native_session_id=NULL WHERE id=?1",
            [active.turn.chatId],
          );
          this.store.message(
            active.turn.chatId,
            active.turn.id,
            "system",
            "Исходная сессия CLI недоступна. Создана новая с контекстом истории; прежние действия не повторяются.",
          );
          await launch(undefined, true);
        } else throw error;
      }
      this.flush(active);
      this.setStatus(active, active.cancelled ? "cancelled" : "completed");
    } catch (error) {
      this.flush(active);
      const message = (error instanceof Error ? error.message : "Ошибка агента")
        .replaceAll(active.token, "[redacted]")
        .slice(0, 4000);
      this.setStatus(
        active,
        active.cancelled ? "cancelled" : "failed",
        active.cancelled ? undefined : message,
      );
      if (!active.cancelled)
        this.store.message(
          active.turn.chatId,
          active.turn.id,
          "system",
          message,
        );
    } finally {
      this.flush(active);
      for (const approval of active.approvals.values()) {
        this.resolveApproval(active, approval);
        approval.resolve?.("deny");
      }
      active.approvals.clear();
      active.token = "";
      if (this.active === active) this.active = undefined;
    }
  }
  authenticate(header: unknown): ActiveAgent {
    const active = this.active;
    const token =
      typeof header === "string" && header.startsWith("Bearer ")
        ? header.slice(7)
        : "";
    if (
      !active ||
      active.cancelled ||
      !active.token ||
      token.length !== active.token.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(active.token))
    )
      throw problem(401, "Invalid agent capability");
    return active;
  }
  private approval(
    active: ActiveAgent,
    message: string,
    details?: Record<string, unknown>,
    nativeId?: string,
    resolve?: (decision: "allow" | "deny") => void,
  ) {
    const id = randomUUID();
    const msg = this.store.message(
      active.turn.chatId,
      active.turn.id,
      "approval",
      message,
      { ...details, approvalId: id },
    );
    active.approvals.set(id, { id, messageId: msg.id, nativeId, resolve });
    this.setStatus(active, "waiting");
    return id;
  }
  requestPermission(active: ActiveAgent, input: unknown): Promise<unknown> {
    const args = z
      .object({
        tool_name: z.string().optional(),
        input: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .parse(input);
    return new Promise((resolve) => {
      this.approval(
        active,
        `Разрешить ${args.tool_name || "действие CLI"}?`,
        { tool: args.tool_name, input: args.input },
        undefined,
        (decision) =>
          resolve(
            decision === "allow"
              ? { behavior: "allow", updatedInput: args.input || {} }
              : { behavior: "deny", message: "Отклонено пользователем" },
          ),
      );
    });
  }
  private resolveApproval(
    active: ActiveAgent,
    approval: Approval,
    decision?: "allow" | "deny",
  ) {
    this.store.atomic(() => {
      const row = this.store.db.query(
        "SELECT * FROM agent_messages WHERE id=?1",
        [approval.messageId],
      ).rows[0];
      const details = {
        ...JSON.parse(row.details_json),
        resolved: true,
        ...(decision ? { decision } : {}),
      };
      this.store.db.query(
        "UPDATE agent_messages SET details_json=?2 WHERE id=?1",
        [approval.messageId, JSON.stringify(details)],
      );
      this.store.publish("agent.event", active.turn.chatId, {
        id: row.id,
        chatId: row.chat_id,
        turnId: row.turn_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        details,
      });
    });
  }
  respond(id: string, decision: "allow" | "deny") {
    const active = this.active;
    const approval = active?.approvals.get(id);
    if (!active || !approval)
      throw problem(409, "Запрос подтверждения больше не активен");
    active.approvals.delete(id);
    this.resolveApproval(active, approval, decision);
    if (approval.nativeId) active.process?.respond(approval.nativeId, decision);
    else approval.resolve?.(decision);
    this.store.publish(
      "chat.updated",
      active.turn.chatId,
      this.store.chat(active.turn.chatId),
    );
    if (!active.approvals.size) this.setStatus(active, "running");
    return { ok: true };
  }
  async cancel(id: string) {
    const turn = this.store.turn(id),
      active = this.active;
    if (!active || active.turn.id !== id) return turn;
    active.cancelled = true;
    for (const approval of active.approvals.values()) {
      this.resolveApproval(active, approval);
      approval.resolve?.("deny");
      if (approval.nativeId) active.process?.respond(approval.nativeId, "deny");
    }
    active.approvals.clear();
    for (const runId of active.runIds) this.services.cancel(runId);
    await active.process?.cancel();
    await active.completion;
    // Cancellation can precede the deferred launch.
    if (["running", "waiting"].includes(this.store.turn(id).status))
      this.setStatus(active, "cancelled");
    return this.store.turn(id);
  }
  async close() {
    this.closing = true;
    if (this.active) await this.cancel(this.active.turn.id);
  }
}
