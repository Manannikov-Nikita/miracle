import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { ProjectStore } from "../project-store.js";
import { projectFileWorkPath } from "../project-files.js";
import {
  agentWorkKey,
  type AgentEntityWork,
  type AgentWorkSnapshot,
  type AgentWorkTarget,
} from "../../shared/agent-work.js";
import type { BoardDocument } from "../../shared/types.js";

const targetSchema = z.union([
  z
    .object({ kind: z.enum(["editor", "query", "board"]), id: z.uuid() })
    .strict(),
  z
    .object({ kind: z.literal("file"), id: z.string().min(1).max(4096) })
    .strict(),
  z
    .object({
      kind: z.enum(["board-node", "board-edge", "board-slide"]),
      boardId: z.uuid(),
      id: z.string().min(1).max(200),
    })
    .strict(),
]);
export const entityWorkInput = z
  .object({ entities: z.array(targetSchema).min(1).max(100) })
  .strict();
export interface AgentWorkActor {
  turnId: string;
  chatId: string;
  isActive: () => boolean;
}
type HeldWork = AgentEntityWork & { roots?: string[] };
const failure = (statusCode: number, message: string, code: string) =>
  Object.assign(new Error(message), { statusCode, code });

/** Ownership is server supplied, never accepted from a browser request body. */
export class EntityWork {
  private readonly actor = new AsyncLocalStorage<AgentWorkActor>();
  constructor(private readonly store: ProjectStore) {}
  runAs<T>(actor: AgentWorkActor, run: () => T): T {
    return this.actor.run(actor, run);
  }
  assertActor() {
    const actor = this.actor.getStore();
    if (actor && !actor.isActive())
      throw failure(401, "Задача агента уже завершена", "AGENT_TASK_ENDED");
    return actor;
  }
  private held(): HeldWork[] {
    const row = this.store.db.query(
      "SELECT payload FROM project_events WHERE type='agent.work' ORDER BY id DESC LIMIT 1",
    ).rows[0];
    return row ? JSON.parse(row.payload).locks : [];
  }
  snapshot(): AgentWorkSnapshot {
    return {
      revision: Number(
        this.store.db.query(
          "SELECT COALESCE(MAX(id),0) AS id FROM project_events",
        ).rows[0].id,
      ),
      locks: this.held().map(({ roots: _, ...lock }) => lock),
    };
  }
  private boardDocument(id: string): BoardDocument | undefined {
    return this.store.db.query("SELECT document FROM boards WHERE id=?1", [id])
      .rows[0]?.document;
  }
  private canonical(target: AgentWorkTarget): AgentWorkTarget {
    return target.kind === "file"
      ? { ...target, id: projectFileWorkPath(this.store.context, target.id) }
      : target;
  }
  private expand(
    target: AgentWorkTarget,
    validate = false,
    incidents = true,
  ): AgentWorkTarget[] {
    const result = new Map<string, AgentWorkTarget>();
    const add = (item: AgentWorkTarget) => result.set(agentWorkKey(item), item);
    target = this.canonical(target);
    add(target);
    if (target.kind === "editor" || target.kind === "query") {
      const editors = this.store.editors();
      const editor =
        target.kind === "editor"
          ? editors.find((item) => item.id === target.id)
          : undefined;
      const queryId = target.kind === "query" ? target.id : editor?.queryId;
      if (validate && target.kind === "editor" && !editor)
        throw failure(404, "Документ редактора не найден", "ENTITY_NOT_FOUND");
      if (queryId) {
        if (
          validate &&
          target.kind === "query" &&
          !this.store.db.query("SELECT id FROM queries WHERE id=?1", [queryId])
            .rowCount
        )
          throw failure(404, "Запрос не найден", "ENTITY_NOT_FOUND");
        add({ kind: "query", id: queryId });
        for (const item of editors)
          if (item.queryId === queryId) add({ kind: "editor", id: item.id });
      }
    } else if (target.kind === "board" || "boardId" in target) {
      const boardId = "boardId" in target ? target.boardId : target.id;
      const document = this.boardDocument(boardId);
      if (
        validate &&
        (!document ||
          (target.kind === "board-node" &&
            !document.nodes.some((n) => n.id === target.id)) ||
          (target.kind === "board-edge" &&
            !document.edges.some((e) => e.id === target.id)) ||
          (target.kind === "board-slide" &&
            !document.slides?.some((slide) => slide.id === target.id)))
      )
        throw failure(404, "Объект доски не найден", "ENTITY_NOT_FOUND");
      if (target.kind === "board-node" && incidents)
        for (const edge of document?.edges || [])
          if (edge.source === target.id || edge.target === target.id)
            add({ kind: "board-edge", boardId, id: edge.id });
    }
    return [...result.values()];
  }
  private ensureAvailable(
    targets: AgentWorkTarget[],
    held: HeldWork[],
    actor?: AgentWorkActor,
  ) {
    const keys = new Set(targets.map(agentWorkKey));
    const lock = held.find(
      (item) =>
        keys.has(agentWorkKey(item.target)) && item.turnId !== actor?.turnId,
    );
    if (lock)
      throw Object.assign(
        failure(
          423,
          "Агент работает с этим объектом. Дождитесь завершения работы",
          "ENTITY_AGENT_LOCKED",
        ),
        { target: lock.target },
      );
  }
  private acquire(targets: AgentWorkTarget[], validate: boolean) {
    const actor = this.assertActor();
    const held = this.held();
    const groups = targets.map((target) => ({
      root: agentWorkKey(this.canonical(target)),
      targets: this.expand(target, validate, Boolean(actor)),
    }));
    this.ensureAvailable(
      groups.flatMap((group) => group.targets),
      held,
      actor,
    );
    if (!actor) return this.snapshot();
    let changed = false;
    for (const group of groups)
      for (const target of group.targets) {
        const existing = held.find(
          (item) => agentWorkKey(item.target) === agentWorkKey(target),
        );
        if (existing) {
          if (validate && !existing.roots?.includes(group.root)) {
            existing.roots = [...(existing.roots || []), group.root];
            changed = true;
          }
        } else {
          held.push({
            target,
            turnId: actor.turnId,
            chatId: actor.chatId,
            startedAt: new Date().toISOString(),
            roots: [group.root],
          });
          changed = true;
        }
      }
    if (changed) this.store.publish("agent.work", undefined, { locks: held });
    return this.snapshot();
  }
  begin(targets: AgentWorkTarget[]) {
    if (!this.assertActor())
      throw failure(401, "Нужна активная задача агента", "AGENT_TASK_ENDED");
    return this.store.atomic(() => this.acquire(targets, true));
  }
  /** Called inside the same transaction as the write, including after awaits. */
  write(targets: AgentWorkTarget[], dependencies: AgentWorkTarget[] = []) {
    const actor = this.assertActor();
    this.ensureAvailable(
      dependencies.map((target) => this.canonical(target)),
      this.held(),
      actor,
    );
    return this.acquire(targets, false);
  }
  check(targets: AgentWorkTarget[]) {
    this.ensureAvailable(
      targets.flatMap((target) => this.expand(target, false, false)),
      this.held(),
      this.assertActor(),
    );
  }
  end(targets: AgentWorkTarget[]) {
    const actor = this.assertActor();
    if (!actor)
      throw failure(401, "Нужна активная задача агента", "AGENT_TASK_ENDED");
    return this.store.atomic(() => {
      const keys = new Set(
        targets
          .flatMap((target) => this.expand(target, false, false))
          .map(agentWorkKey),
      );
      const before = this.held();
      const locks = before.flatMap((lock) => {
        if (lock.turnId !== actor.turnId) return [lock];
        const roots = lock.roots?.filter((root) => !keys.has(root));
        return roots?.length ? [{ ...lock, roots }] : [];
      });
      if (JSON.stringify(locks) !== JSON.stringify(before))
        this.store.publish("agent.work", undefined, { locks });
      return this.snapshot();
    });
  }
  releaseTurn(turnId?: string) {
    return this.store.atomic(() => {
      const before = this.held();
      const locks = turnId
        ? before.filter((lock) => lock.turnId !== turnId)
        : [];
      if (locks.length !== before.length)
        this.store.publish("agent.work", undefined, { locks });
    });
  }
}
