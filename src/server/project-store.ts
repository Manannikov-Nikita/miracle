import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Database } from "./db.js";
import type { SecretBox } from "./secrets.js";
import { dateRangeSchema } from "./validation.js";
import type {
  AgentChat,
  AgentConversation,
  AgentMessage,
  AgentProfile,
  AgentTurn,
  EditorDocument,
  ProjectContext,
  ProjectEvent,
} from "../shared/agents.js";

export const problem = (statusCode: number, message: string, code?: string) =>
  Object.assign(new Error(message), { statusCode, code });
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const now = () => new Date().toISOString();
export const editorFields = z.object({
  name: z.string().trim().min(1).max(200),
  sql: z.string().max(1000000),
  connectionId: z.union([z.uuid(), z.literal("")]),
  database: z.string().max(200).optional(),
  catalog: z.string().max(200).optional(),
  schema: z.string().max(200).optional(),
  queryId: z.uuid().optional(),
  queryRevision: z.number().int().nonnegative().optional(),
  resultSetId: z.uuid().optional(),
  runId: z.uuid().optional(),
  dateRange: dateRangeSchema.optional(),
});
export const profileFields = z.object({
  name: z.string().trim().min(1).max(120),
  provider: z.enum(["codex", "claude"]),
  command: z.string().trim().min(1).max(16384),
});

export class ProjectStore {
  readonly events = new EventEmitter();
  private readonly trustDir: string;
  private closed = false;
  constructor(
    readonly db: Database,
    readonly box: SecretBox,
    readonly context: ProjectContext,
  ) {
    const root =
      process.env.MIRACLE_INSTALL_ROOT ||
      (process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "Miracle")
        : join(
            process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
            "miracle",
          ));
    this.trustDir = join(root, "agent-trust");
    this.events.setMaxListeners(100);
  }
  close() {
    this.closed = true;
    this.events.removeAllListeners();
  }
  atomic<T>(fn: () => T): T {
    return this.db.sqlite.isTransaction ? fn() : this.db.transaction(fn);
  }
  publish(
    type: string,
    entityId: string | undefined,
    data: unknown,
  ): ProjectEvent {
    const payload = JSON.stringify(data);
    const row = this.db.query(
      "INSERT INTO project_events(type,entity_id,payload) VALUES(?1,?2,?3) RETURNING id",
      [type, entityId, payload],
    ).rows[0];
    const event = { id: Number(row.id), type, entityId, data };
    queueMicrotask(() => {
      if (this.closed) return;
      const committed = this.db.query(
        "SELECT payload,type FROM project_events WHERE id=?1",
        [event.id],
      ).rows[0];
      if (committed?.payload === payload && committed.type === type)
        this.events.emit("event", event);
    });
    return event;
  }
  since(after: number, limit = 500): ProjectEvent[] {
    return this.db
      .query("SELECT * FROM project_events WHERE id>?1 ORDER BY id LIMIT ?2", [
        after,
        limit,
      ])
      .rows.map((r) => ({
        id: Number(r.id),
        type: r.type,
        entityId: r.entity_id || undefined,
        data: JSON.parse(r.payload),
      }));
  }
  once<T>(scope: string, id: string, input: unknown, run: () => T): T {
    return this.atomic(() => {
      const digest = hash(JSON.stringify(input));
      const saved = this.db.query(
        "SELECT * FROM project_mutations WHERE scope=?1 AND id=?2",
        [scope, id],
      ).rows[0];
      if (saved) {
        if (saved.input_hash !== digest)
          throw problem(
            409,
            "Идентификатор операции уже использован с другими данными",
            "MUTATION_CONFLICT",
          );
        return JSON.parse(saved.response) as T;
      }
      const value = run();
      this.db.query(
        "INSERT INTO project_mutations(scope,id,input_hash,response) VALUES(?1,?2,?3,?4)",
        [scope, id, digest, JSON.stringify(value)],
      );
      return value;
    });
  }
  editors(): EditorDocument[] {
    return this.db
      .query("SELECT * FROM editor_documents ORDER BY rowid")
      .rows.map((r) => ({
        ...r.document,
        id: r.id,
        revision: r.revision,
        updatedAt: r.updated_at,
      }));
  }
  editor(id: string): EditorDocument {
    const r = this.db.query("SELECT * FROM editor_documents WHERE id=?1", [id])
      .rows[0];
    if (!r) throw problem(404, "Документ редактора не найден");
    return {
      ...r.document,
      id: r.id,
      revision: r.revision,
      updatedAt: r.updated_at,
    };
  }
  createEditor(input: unknown): EditorDocument {
    const b = editorFields.extend({ id: z.uuid().optional() }).parse(input);
    const id = b.id || randomUUID();
    const { id: _, ...document } = b;
    return this.atomic(() => {
      const existing = this.db.query(
        "SELECT id FROM editor_documents WHERE id=?1",
        [id],
      ).rows[0];
      if (existing) {
        const current = this.editor(id);
        if (
          JSON.stringify(editorFields.parse(current)) !==
          JSON.stringify(document)
        )
          throw problem(409, "Документ с этим идентификатором уже существует");
        return current;
      }
      this.db.query(
        "INSERT INTO editor_documents(id,document,updated_at) VALUES(?1,?2,?3)",
        [id, document, now()],
      );
      const result = this.editor(id);
      this.publish("editor.updated", id, result);
      return result;
    });
  }
  updateEditor(id: string, input: unknown): EditorDocument {
    const b = editorFields
      .partial()
      .extend({
        baseRevision: z.number().int().positive(),
        mutationId: z.uuid(),
        database: z.string().max(200).nullable().optional(),
        catalog: z.string().max(200).nullable().optional(),
        schema: z.string().max(200).nullable().optional(),
        queryId: z.uuid().nullable().optional(),
        queryRevision: z.number().int().nonnegative().nullable().optional(),
        resultSetId: z.uuid().nullable().optional(),
        runId: z.uuid().nullable().optional(),
        dateRange: dateRangeSchema.nullable().optional(),
      })
      .parse(input);
    return this.once(`editor:${id}`, b.mutationId, b, () => {
      const current = this.editor(id);
      if (current.revision !== b.baseRevision)
        throw problem(
          409,
          "Документ изменён. Сохраните свою копию или загрузите актуальный текст",
          "REVISION_CONFLICT",
        );
      const { baseRevision, mutationId, ...patch } = b;
      const merged: Record<string, unknown> = { ...current, ...patch };
      for (const key of Object.keys(merged))
        if (merged[key] === null) delete merged[key];
      const document = editorFields.parse(merged);
      this.db.query(
        "UPDATE editor_documents SET document=?2,revision=revision+1,updated_at=?3 WHERE id=?1",
        [id, document, now()],
      );
      const result = this.editor(id);
      this.publish("editor.updated", id, result);
      return result;
    });
  }
  deleteEditor(id: string, input: unknown) {
    const b = z
      .object({
        baseRevision: z.number().int().positive(),
        mutationId: z.uuid(),
      })
      .parse(input);
    return this.once(`editor-delete:${id}`, b.mutationId, b, () => {
      if (this.editor(id).revision !== b.baseRevision)
        throw problem(409, "Документ изменён", "REVISION_CONFLICT");
      this.db.query("DELETE FROM editor_documents WHERE id=?1", [id]);
      this.publish("editor.deleted", id, { id });
      return { ok: true };
    });
  }
  importEditors(input: unknown): EditorDocument[] {
    const b = z
      .object({
        migrationId: z.string().min(1).max(200),
        documents: z.array(z.record(z.string(), z.unknown())).max(200),
      })
      .parse(input);
    return this.atomic(() => {
      if (
        this.db.query("SELECT id FROM editor_imports WHERE id=?1", [
          b.migrationId,
        ]).rowCount
      )
        return this.editors();
      for (const raw of b.documents) {
        const existing =
          typeof raw.id === "string"
            ? this.db.query("SELECT id FROM editor_documents WHERE id=?1", [
                raw.id,
              ]).rowCount
            : 0;
        if (existing) continue;
        this.createEditor({
          ...raw,
          queryRevision: raw.queryRevision ?? raw.revision,
        });
      }
      this.db.query("INSERT INTO editor_imports(id) VALUES(?1)", [
        b.migrationId,
      ]);
      return this.editors();
    });
  }
  private trustPath(
    profile: Pick<AgentProfile, "id" | "command" | "provider">,
  ) {
    return join(
      this.trustDir,
      hash(
        JSON.stringify([
          resolve(this.context.projectRoot),
          resolve(this.context.dataDir),
          profile.id,
          profile.provider,
          profile.command,
        ]),
      ),
    );
  }
  profile(id: string): AgentProfile {
    const r = this.db.query("SELECT * FROM agent_profiles WHERE id=?1", [id])
      .rows[0];
    if (!r) throw problem(404, "Профиль агента не найден");
    const profile = {
      id: r.id,
      name: r.name,
      provider: r.provider,
      command: this.box.decrypt(r.command_encrypted),
      createdAt: r.created_at,
      trusted: false,
    } as AgentProfile;
    profile.trusted = existsSync(this.trustPath(profile));
    return profile;
  }
  profiles(): AgentProfile[] {
    return this.db
      .query("SELECT id FROM agent_profiles ORDER BY created_at")
      .rows.map((r) => this.profile(r.id));
  }
  trustProfile(id: string): AgentProfile {
    const p = this.profile(id);
    mkdirSync(this.trustDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.trustPath(p), "Configured locally\n", { mode: 0o600 });
    this.publish("profiles.changed", id, {});
    return { ...p, trusted: true };
  }
  saveProfile(input: unknown, id?: string): AgentProfile {
    const b = profileFields.parse(input);
    if (id) {
      const previous = this.profile(id);
      if (
        previous.provider !== b.provider &&
        this.db.query("SELECT id FROM agent_chats WHERE profile_id=?1", [id])
          .rowCount
      )
        throw problem(409, "Для другого провайдера создайте новый профиль");
      if (
        this.db.query(
          "SELECT t.id FROM agent_turns t JOIN agent_chats c ON c.id=t.chat_id WHERE c.profile_id=?1 AND t.status IN ('running','waiting')",
          [id],
        ).rowCount
      )
        throw problem(
          409,
          "Дождитесь завершения задачи перед изменением профиля",
        );
      this.db.query(
        "UPDATE agent_profiles SET name=?2,provider=?3,command_encrypted=?4 WHERE id=?1",
        [id, b.name, b.provider, this.box.encrypt(b.command)],
      );
    } else {
      id = randomUUID();
      this.db.query("INSERT INTO agent_profiles VALUES(?1,?2,?3,?4,?5)", [
        id,
        b.name,
        b.provider,
        this.box.encrypt(b.command),
        now(),
      ]);
    }
    return this.trustProfile(id);
  }
  deleteProfile(id: string) {
    this.profile(id);
    if (
      this.db.query("SELECT id FROM agent_chats WHERE profile_id=?1", [id])
        .rowCount
    )
      throw problem(409, "Профиль используется в сохранённых чатах");
    this.db.query("DELETE FROM agent_profiles WHERE id=?1", [id]);
    this.publish("profiles.changed", id, {});
    return { ok: true };
  }
  chat(id: string): AgentChat {
    const r = this.db.query("SELECT * FROM agent_chats WHERE id=?1", [id])
      .rows[0];
    if (!r) throw problem(404, "Чат не найден");
    return {
      id: r.id,
      title: r.title,
      profileId: r.profile_id,
      provider: r.provider,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
  chats(): AgentChat[] {
    return this.db
      .query("SELECT id FROM agent_chats ORDER BY updated_at DESC")
      .rows.map((r) => this.chat(r.id));
  }
  createChat(input: unknown): AgentChat {
    const b = z
      .object({
        profileId: z.uuid(),
        title: z.string().trim().min(1).max(200).optional(),
      })
      .parse(input);
    const p = this.profile(b.profileId);
    const id = randomUUID(),
      time = now();
    this.db.query(
      "INSERT INTO agent_chats(id,title,profile_id,provider,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
      [id, b.title || "Новый чат", p.id, p.provider, time],
    );
    const chat = this.chat(id);
    this.publish("chat.updated", id, chat);
    return chat;
  }
  turn(id: string): AgentTurn {
    const r = this.db.query("SELECT * FROM agent_turns WHERE id=?1", [id])
      .rows[0];
    if (!r) throw problem(404, "Задача не найдена");
    return {
      id: r.id,
      chatId: r.chat_id,
      status: r.status,
      context: JSON.parse(r.context_json),
      error: r.error || undefined,
      createdAt: r.created_at,
      finishedAt: r.finished_at || undefined,
    };
  }
  activeTurn(): AgentTurn | null {
    const row = this.db.query(
      "SELECT id FROM agent_turns WHERE status IN ('running','waiting')",
    ).rows[0];
    return row ? this.turn(row.id) : null;
  }
  message(
    chatId: string,
    turnId: string | undefined,
    role: AgentMessage["role"],
    content: string,
    details?: Record<string, unknown>,
  ): AgentMessage {
    const msg = {
      id: randomUUID(),
      chatId,
      turnId,
      role,
      content,
      details,
      createdAt: now(),
    };
    this.db.query("INSERT INTO agent_messages VALUES(?1,?2,?3,?4,?5,?6,?7)", [
      msg.id,
      chatId,
      turnId,
      role,
      content,
      details ? JSON.stringify(details) : null,
      msg.createdAt,
    ]);
    this.db.query("UPDATE agent_chats SET updated_at=?2 WHERE id=?1", [
      chatId,
      msg.createdAt,
    ]);
    this.publish("agent.event", chatId, msg);
    return msg;
  }
  conversation(id: string): AgentConversation {
    const chat = this.chat(id);
    const messages = this.db
      .query("SELECT * FROM agent_messages WHERE chat_id=?1 ORDER BY rowid", [
        id,
      ])
      .rows.map((r) => ({
        id: r.id,
        chatId: r.chat_id,
        turnId: r.turn_id || undefined,
        role: r.role,
        content: r.content,
        details: r.details_json ? JSON.parse(r.details_json) : undefined,
        createdAt: r.created_at,
      }));
    const turns = this.db
      .query("SELECT id FROM agent_turns WHERE chat_id=?1 ORDER BY rowid", [id])
      .rows.map((r) => this.turn(r.id));
    return { chat, messages, turns };
  }
}
