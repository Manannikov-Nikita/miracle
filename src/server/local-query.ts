import { fork } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cell } from "../shared/types.js";
import type { DatasetColumn } from "../shared/datasets.js";
import type { EngineResult, QueryLimits } from "./connectors.js";

export type LocalQueryColumn = DatasetColumn;

export interface LocalQueryDataset {
  name: string;
  columns: readonly LocalQueryColumn[];
  chunks: () => Iterable<readonly Cell[][]> | AsyncIterable<readonly Cell[][]>;
}

export interface LocalQueryResult extends EngineResult {
  columns: LocalQueryColumn[];
}

interface LocalQueryInput {
  sql: string;
  project: { projectRoot: string; dataDir: string };
  datasets?: readonly LocalQueryDataset[];
  limits: QueryLimits;
  signal: AbortSignal;
  onCancel?: (cancel: () => Promise<void>) => void;
}

export type LocalQueryJob = Pick<
  LocalQueryInput,
  "sql" | "project" | "limits"
> & {
  scratch: string;
  datasets: Omit<LocalQueryDataset, "chunks">[];
};

export type LocalQueryWorkerInput =
  | { kind: "start"; job: LocalQueryJob }
  | { kind: "chunk"; rows: readonly Cell[][] | null };

export type LocalQueryWorkerOutput =
  | { kind: "chunk"; index: number }
  | { kind: "result"; result: LocalQueryResult }
  | { kind: "error"; message: string };

type ChunkIterator =
  Iterator<readonly Cell[][]> | AsyncIterator<readonly Cell[][]>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function executeLocalQuery(
  input: LocalQueryInput,
): Promise<LocalQueryResult> {
  const { sql, project, limits, signal, datasets = [] } = input;
  signal.throwIfAborted();
  if (!sql.trim() || sql.length > 1_000_000 || sql.includes("\0"))
    throw new Error("SQL пустой или слишком большой");

  const cancel = new AbortController();
  const active = AbortSignal.any([signal, cancel.signal]);
  const finished = deferred<void>();
  const timer = setTimeout(() => {
    cancel.abort(new Error("Превышено время выполнения запроса"));
  }, limits.timeoutMs);
  const iterators = new Map<number, ChunkIterator>();
  let scratch: string | undefined;
  try {
    input.onCancel?.(async () => {
      cancel.abort(new Error("Запрос отменён"));
      await finished.promise;
    });
    scratch = await mkdtemp(join(await realpath(tmpdir()), "miracle-duckdb-"));
    active.throwIfAborted();
    const source = import.meta.filename.endsWith(".ts");
    const child = fork(
      new URL(`./local-query-worker.${source ? "ts" : "js"}`, import.meta.url),
      [],
      {
        cwd: scratch,
        env: {},
        execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    const result = deferred<LocalQueryResult>();
    let stderr = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length);
    });
    const fail = (error: unknown) => {
      result.reject(error);
      child.kill("SIGKILL");
    };
    const abort = () => fail(active.reason);
    active.addEventListener("abort", abort, { once: true });
    child.once("error", fail);
    child.once("close", (code, exitSignal) => {
      const detail = stderr.replaceAll(scratch!, "<локальный файл>").trim();
      result.reject(
        new Error(
          `Локальный движок DuckDB завершился (${exitSignal ?? code})${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
    const send = (message: LocalQueryWorkerInput) => {
      child.send(message, (error) => {
        if (error) fail(error);
      });
    };
    child.on("message", async (message: LocalQueryWorkerOutput) => {
      if (active.aborted) return;
      if (message.kind === "result") {
        result.resolve(message.result);
        return;
      }
      if (message.kind === "error") {
        result.reject(new Error(message.message));
        return;
      }
      const { index } = message;
      try {
        let iterator = iterators.get(index);
        if (!iterator) {
          const chunks = datasets[index]!.chunks();
          iterator =
            Symbol.asyncIterator in chunks
              ? chunks[Symbol.asyncIterator]()
              : chunks[Symbol.iterator]();
          iterators.set(index, iterator);
        }
        const chunk = await iterator.next();
        if (!active.aborted && child.connected)
          send({ kind: "chunk", rows: chunk.done ? null : chunk.value });
      } catch (error) {
        fail(error);
      }
    });
    try {
      send({
        kind: "start",
        job: {
          sql,
          project,
          limits,
          scratch,
          datasets: datasets.map(({ name, columns }) => ({ name, columns })),
        },
      });
      const output = await result.promise;
      active.throwIfAborted();
      return output;
    } finally {
      active.removeEventListener("abort", abort);
      // Kill the dedicated process on every path, including an unfinished native fetch.
      child.kill("SIGKILL");
      await closed;
    }
  } finally {
    clearTimeout(timer);
    for (const iterator of iterators.values()) {
      // An external async producer may still be unwinding after cancellation.
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {}
    }
    try {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    } finally {
      finished.resolve();
    }
  }
}
