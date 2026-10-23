import { api } from "../api";
import type { Cell, ResultSet } from "../../shared/types";

type Snapshot = { result: ResultSet; rows: Cell[][] };
type Entry = {
  promise: Promise<Snapshot>;
  controller: AbortController;
  refs: number;
  done: boolean;
  used: number;
};
const cache = new Map<string, Entry>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
function drain() {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      drain();
    });
  }
}
function trim() {
  const idle = [...cache.entries()]
    .filter(([, entry]) => entry.done && entry.refs === 0)
    .sort((a, b) => b[1].used - a[1].used);
  for (const [key] of idle.slice(2)) cache.delete(key);
}
/** Immutable snapshots are shared by cards. Only two reads run concurrently. */
export function acquireTableSnapshot(id: string) {
  let entry = cache.get(id);
  if (!entry) {
    const controller = new AbortController();
    let resolve!: (snapshot: Snapshot) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Snapshot>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    entry = { promise, controller, refs: 0, done: false, used: Date.now() };
    const own = entry;
    cache.set(id, own);
    queue.push(async () => {
      try {
        controller.signal.throwIfAborted();
        const data = await api<Snapshot>(
          `/api/result-sets/${encodeURIComponent(id)}/table`,
          { signal: controller.signal },
        );
        own.done = true;
        resolve(data);
      } catch (error) {
        if (cache.get(id) === own) cache.delete(id);
        reject(error);
      } finally {
        trim();
      }
    });
    drain();
  }
  entry.refs++;
  entry.used = Date.now();
  const own = entry;
  let released = false;
  return {
    promise: own.promise,
    release() {
      if (released) return;
      released = true;
      own.refs--;
      if (!own.refs && !own.done) {
        own.controller.abort();
        if (cache.get(id) === own) cache.delete(id);
      }
      trim();
    },
  };
}
