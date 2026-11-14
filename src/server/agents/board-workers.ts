import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentWorkKey,
  type AgentWorkTarget,
  type AgentWorkWorker,
} from "../../shared/agent-work.js";
import { problem, type ProjectStore } from "../project-store.js";
import type { AgentProcess } from "./adapter.js";
import type { BoardWorkerScope } from "./entity-work.js";
import type { ActiveAgent } from "./manager.js";

const entityIds = z.array(z.string().min(1).max(200)).max(100).default([]);
const assignment = z
  .object({
    id: z.uuid(),
    mutationId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    task: z.string().trim().min(1).max(4000),
    nodeIds: entityIds,
    edgeIds: entityIds,
  })
  .strict()
  .refine(
    ({ nodeIds, edgeIds }) => nodeIds.length + edgeIds.length > 0,
    "Укажите область работы",
  );
const statusInput = z
  .object({
    taskId: z.uuid().optional(),
    waitMs: z.number().int().min(0).max(10_000).default(0),
  })
  .strict();
const cancelInput = z.object({ taskId: z.uuid() }).strict();

const maxRunning = 2;
const maxTasks = 16;
const workerTimeout = 180_000;
const summaryLimit = 800;
const selectionBudget = 8_000;

function summaryTail(text: string, limit: number) {
  const tail = text.slice(-limit);
  return /^[\uDC00-\uDFFF]/u.test(tail) ? tail.slice(1) : tail;
}
type Status =
  | "queued"
  | "running"
  | "waiting"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";
type Outcome = Extract<Status, "completed" | "failed" | "cancelled">;

export function workerIdentity({
  id,
  name,
  color,
}: BoardWorkerScope): AgentWorkWorker {
  return { id, name, color };
}

interface Task {
  active: ActiveAgent;
  scope: BoardWorkerScope;
  signature: string;
  instruction: string;
  targets: AgentWorkTarget[];
  keys: string[];
  status: Status;
  summary?: string;
  completion: Promise<void>;
  resolve: () => void;
  calls: Set<Promise<unknown>>;
  stop?: Promise<void>;
}

const pending = (task: Task) =>
  task.status === "queued" ||
  task.status === "stopping" ||
  task.status === "running" ||
  task.status === "waiting";

export class BoardWorkers {
  private readonly tasks = new Map<string, Task>();
  private readonly requests = new Map<string, Task>();
  private readonly changes = new Set<(task: Task) => void>();
  private closing = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly root: ActiveAgent,
    private readonly launch: (
      active: ActiveAgent,
      instruction: string,
    ) => AgentProcess,
    private readonly revoke: (active: ActiveAgent) => void,
  ) {
    store.events.on("event", this.onEvent);
  }

  private readonly onEvent = ({ type }: { type: string }) => {
    if (type === "agent.work") this.pump();
  };

  private result(task: Task, summaryLimitForList = summaryLimit) {
    return {
      ...workerIdentity(task.scope),
      boardId: task.scope.boardId,
      status: task.status,
      ...(task.summary
        ? {
            summary:
              task.status === "completed"
                ? summaryTail(task.summary, summaryLimitForList)
                : task.summary.slice(0, summaryLimitForList),
          }
        : {}),
    };
  }

  private notify(task: Task, status: Status, summary?: string) {
    task.status = status;
    task.summary = summary;
    const worker = workerIdentity(task.scope);
    this.store.message(
      this.root.turn.chatId,
      this.root.turn.id,
      "action",
      worker.name,
      {
        worker,
        subagent: {
          id: worker.id,
          name: worker.name,
          status:
            status === "queued"
              ? "pending"
              : status === "stopping"
                ? "cancelled"
                : status,
          ...(summary ? { message: summary } : {}),
        },
      },
    );
    for (const change of this.changes) change(task);
  }

  start(input: unknown) {
    const parsed = assignment.parse(input);
    const nodeIds = [...new Set(parsed.nodeIds)].sort();
    const edgeIds = [...new Set(parsed.edgeIds)].sort();
    if (Buffer.byteLength(JSON.stringify([nodeIds, edgeIds])) > selectionBudget)
      throw problem(
        400,
        "Список назначенных объектов слишком длинный",
        "BOARD_TASK_SCOPE_LIMIT",
      );
    const signature = JSON.stringify({ ...parsed, nodeIds, edgeIds });
    const previous = this.requests.get(parsed.mutationId);
    if (previous) {
      if (previous.signature !== signature)
        throw problem(
          409,
          "Идентификатор делегирования уже использован",
          "MUTATION_CONFLICT",
        );
      return this.result(previous);
    }
    if (this.tasks.size >= maxTasks)
      throw problem(
        409,
        "Лимит задач исполнителей на этот ход исчерпан",
        "BOARD_TASK_LIMIT",
      );
    const targets: AgentWorkTarget[] = [
      ...nodeIds.map((id) => ({
        kind: "board-node" as const,
        id,
        boardId: parsed.id,
      })),
      ...edgeIds.map((id) => ({
        kind: "board-edge" as const,
        id,
        boardId: parsed.id,
      })),
    ];
    const expanded = this.store.work.boardReservation(targets);
    const scope: BoardWorkerScope = Object.freeze({
      id: randomUUID(),
      name: parsed.name,
      color: this.tasks.size,
      boardId: parsed.id,
      nodeIds: Object.freeze(nodeIds),
      edgeIds: Object.freeze([
        ...new Set([
          ...edgeIds,
          ...expanded.flatMap((target) =>
            target.kind === "board-edge" ? [target.id] : [],
          ),
        ]),
      ]),
    });
    let resolve!: () => void;
    const completion = new Promise<void>((done) => {
      resolve = done;
    });
    const active: ActiveAgent = {
      turn: this.root.turn,
      worker: scope,
      token: randomBytes(32).toString("base64url"),
      completion,
      cancelled: false,
      approvals: new Map(),
      questions: new Map(),
      steers: new Map(),
      runIds: new Set(),
      images: [],
      buffer: "",
    };
    const task: Task = {
      active,
      scope,
      signature,
      instruction: parsed.task,
      targets: expanded,
      keys: expanded.map(agentWorkKey),
      status: "queued",
      completion,
      resolve,
      calls: new Set(),
    };
    this.tasks.set(scope.id, task);
    this.requests.set(parsed.mutationId, task);
    this.notify(task, "queued");
    this.pump();
    return this.result(task);
  }

  private task(id: string) {
    const found = this.tasks.get(id);
    if (!found)
      throw problem(
        404,
        "Задача исполнителя не найдена",
        "BOARD_TASK_NOT_FOUND",
      );
    return found;
  }

  private async wait(waitMs: number, forTask?: Task) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.changes.delete(changed);
        resolve();
      };
      const changed = (task: Task) => {
        if (!forTask || task === forTask) done();
      };
      const timer = setTimeout(done, waitMs);
      this.changes.add(changed);
    });
  }

  async status(input: unknown) {
    const { taskId, waitMs } = statusInput.parse(input);
    if (!taskId) {
      if (waitMs && [...this.tasks.values()].some(pending))
        await this.wait(waitMs);
      return {
        tasks: [...this.tasks.values()].map((task) => this.result(task, 320)),
      };
    }
    const task = this.task(taskId);
    if (waitMs && pending(task)) await this.wait(waitMs, task);
    return this.result(task);
  }

  async cancel(input: unknown) {
    const task = this.task(cancelInput.parse(input).taskId);
    await this.stopTask(task, "cancelled", "Задача отменена");
    return this.result(task);
  }

  activeAgents() {
    return [...this.tasks.values()]
      .filter(({ status }) => status === "running" || status === "waiting")
      .map(({ active }) => active);
  }

  owns(active: ActiveAgent) {
    return Boolean(
      active.worker && this.tasks.get(active.worker.id)?.active === active,
    );
  }

  async track<T>(active: ActiveAgent, run: () => T | Promise<T>): Promise<T> {
    const task = this.task(active.worker!.id);
    const call = Promise.resolve().then(run);
    task.calls.add(call);
    try {
      return await call;
    } finally {
      task.calls.delete(call);
    }
  }

  interactionChanged(active: ActiveAgent) {
    const task = this.task(active.worker!.id);
    const status =
      active.questions.size || active.approvals.size ? "waiting" : "running";
    if (
      (task.status === "running" || task.status === "waiting") &&
      task.status !== status
    )
      this.notify(task, status);
  }

  private pump() {
    if (this.closing || this.root.cancelled || this.root.ending) return;
    let slots =
      maxRunning -
      [...this.tasks.values()].filter(
        (task) => pending(task) && task.status !== "queued",
      ).length;
    if (!slots) return;
    const blocked = new Set(
      this.store.work
        .snapshot()
        .locks.map(({ target }) => agentWorkKey(target)),
    );
    for (const task of this.tasks.values()) {
      if (!slots) break;
      if (task.status !== "queued") continue;
      if (task.keys.some((key) => blocked.has(key))) {
        for (const key of task.keys) blocked.add(key);
        continue;
      }
      const { active, scope } = task;
      try {
        this.store.work.runAs(
          {
            turnId: this.root.turn.id,
            chatId: this.root.turn.chatId,
            worker: scope,
            isActive: () =>
              !this.closing && !this.root.cancelled && !this.root.ending,
          },
          () => this.store.work.begin(task.targets),
        );
        this.notify(task, "running");
        active.process = this.launch(active, task.instruction);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "ENTITY_AGENT_LOCKED") continue;
        this.settle(task, "failed", this.errorText(task, error));
        continue;
      }
      slots--;
      for (const key of task.keys) blocked.add(key);
      const timer = setTimeout(() => {
        void this.stopTask(
          task,
          "failed",
          "Исполнитель превысил лимит времени",
        );
      }, workerTimeout);
      void active.process.completion
        .then(
          () => this.complete(task, "completed", active.buffer.trim()),
          (error) => this.complete(task, "failed", this.errorText(task, error)),
        )
        .finally(() => clearTimeout(timer));
    }
  }

  private errorText(task: Task, error: unknown) {
    const message =
      error instanceof Error ? error.message : "Ошибка исполнителя";
    return message
      .replaceAll(task.active.token, "[redacted]")
      .slice(0, summaryLimit);
  }

  private complete(task: Task, outcome: Outcome, summary: string) {
    if (task.stop) return;
    task.active.ending = true;
    task.stop = Promise.resolve().then(async () => {
      this.revoke(task.active);
      await Promise.allSettled(task.calls);
      this.settle(task, outcome, summary);
    });
    return task.stop;
  }

  private stopTask(
    task: Task,
    outcome: Outcome,
    summary: string,
  ): Promise<void> {
    if (task.stop) return task.stop;
    if (!pending(task)) return task.completion;
    task.active.cancelled = true;
    if (task.status === "queued") {
      this.settle(task, outcome, summary);
      return task.completion;
    }
    this.notify(task, "stopping");
    task.stop = Promise.resolve().then(async () => {
      this.revoke(task.active);
      if (task.active.process)
        await Promise.allSettled([
          task.active.process.cancel(),
          task.active.process.completion,
        ]);
      await Promise.allSettled(task.calls);
      this.settle(task, outcome, summary);
    });
    return task.stop;
  }

  private settle(task: Task, outcome: Outcome, summary: string) {
    task.active.token = "";
    this.store.work.releaseOwner(task.scope.id);
    this.notify(task, outcome, summary.slice(0, summaryLimit) || undefined);
    task.active.buffer = "";
    task.resolve();
  }

  hasPending() {
    return [...this.tasks.values()].some(pending);
  }

  async stopAll() {
    this.closing = true;
    this.store.events.off("event", this.onEvent);
    await Promise.all(
      [...this.tasks.values()].map((task) =>
        this.stopTask(task, "cancelled", "Родительская задача завершена"),
      ),
    );
  }
}

export function appendWorkerSummary(
  active: ActiveAgent,
  text: string,
  messageStart = false,
) {
  active.buffer = summaryTail(
    messageStart ? text : active.buffer + text.slice(-summaryLimit),
    summaryLimit,
  );
}
