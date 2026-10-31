import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectEvent } from "../src/shared/agents.js";
import type { ProjectStore } from "../src/server/project-store.js";
import { registerProjectRoutes } from "../src/server/project-routes.js";
import { parseEventFrames } from "../src/client/agents/events.js";

// Control the network boundary while retaining Node's real buffering/drain behavior.
class SlowResponse extends Writable {
  chunks: string[] = [];
  pending: Array<() => void> = [];
  constructor() {
    super({ highWaterMark: 1024 });
  }
  writeHead() {}
  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(chunk.toString());
    this.pending.push(callback);
  }
  drainAll() {
    while (this.pending.length) this.pending.shift()!();
  }
  ids() {
    return parseEventFrames(this.chunks.join(""), 0).events.map((e) => e.id);
  }
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});

const event = (id: number): ProjectEvent => ({
  id,
  type: "editor.updated",
  entityId: "editor",
  data: { id: "editor", revision: id, sql: "x".repeat(1200) },
});

async function stream(history: ProjectEvent[], after = 0, authorized = true) {
  type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  const routes = new Map<string, Handler>();
  let preClose: () => Promise<void> = async () => {};
  const app = {
    get: (path: string, handler: Handler) => routes.set(path, handler),
    post() {},
    patch() {},
    delete() {},
    addHook: (_name: string, hook: () => Promise<void>) => (preClose = hook),
  } as unknown as FastifyInstance;
  const events = new EventEmitter();
  const store = {
    events,
    since: (cursor: number, limit = 500) =>
      history.filter((item) => item.id > cursor).slice(0, limit),
  } as unknown as ProjectStore;
  registerProjectRoutes(app, store, () => {
    if (!authorized) throw new Error("Unauthorized");
  });
  const raw = new SlowResponse();
  cleanups.push(() => {
    void preClose();
    raw.destroy();
  });
  const open = () =>
    routes.get("/api/events")!(
      {
        query: { after: String(after) },
        log: { error: vi.fn() },
      } as unknown as FastifyRequest,
      { raw, hijack() {} } as unknown as FastifyReply,
    );
  return { raw, events, open, preClose };
}

it("keeps one stream open through backpressure and delivers replay plus live events once in order", async () => {
  const history = Array.from({ length: 130 }, (_, i) => event(i + 1));
  const s = await stream(history, 2);
  await s.open();
  expect(s.raw.writableEnded).toBe(false);
  expect(s.raw.writableNeedDrain).toBe(true);
  history.push(event(131));
  s.events.emit("event", history.at(-1));
  s.events.emit("event", history[0]);
  s.raw.drainAll();
  expect(s.raw.ids()).toEqual(Array.from({ length: 129 }, (_, i) => i + 3));
  expect(s.raw.writableEnded).toBe(false);
  history.push(event(132));
  s.events.emit("event", history.at(-1));
  s.raw.drainAll();
  expect(s.raw.ids().at(-1)).toBe(132);
  expect(s.raw.ids()).toHaveLength(130);
});

it("does not buffer live traffic or heartbeats behind a blocked writer and releases a stalled client", async () => {
  vi.useFakeTimers();
  const history = [event(1)];
  const s = await stream(history);
  await s.open();
  const buffered = s.raw.writableLength;
  for (let id = 2; id <= 1001; id++) {
    history.push(event(id));
    s.events.emit("event", history.at(-1));
  }
  await vi.advanceTimersByTimeAsync(15000);
  expect(s.raw.writableLength).toBe(buffered);
  expect(s.raw.destroyed).toBe(false);
  expect(s.events.listenerCount("event")).toBe(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(s.raw.destroyed).toBe(true);
  expect(s.events.listenerCount("event")).toBe(0);
});

it("removes stream listeners and timers when a client closes during replay", async () => {
  vi.useFakeTimers();
  const s = await stream([event(1), event(2)]);
  await s.open();
  s.raw.destroy();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.events.listenerCount("event")).toBe(0);
  expect(s.raw.listenerCount("drain")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("releases blocked sockets when the server closes without waiting for their drain", async () => {
  vi.useFakeTimers();
  const s = await stream([event(1), event(2)]);
  await s.open();
  await s.preClose();
  expect(s.raw.destroyed).toBe(true);
  expect(s.events.listenerCount("event")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("authenticates before opening a stream", async () => {
  const s = await stream([event(1)], 0, false);
  await expect(s.open()).rejects.toThrow("Unauthorized");
  expect(s.raw.chunks).toEqual([]);
  expect(s.events.listenerCount("event")).toBe(0);
});
