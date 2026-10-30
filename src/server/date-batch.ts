import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import {
  executeEngine,
  type EngineConnection,
  type EngineResult,
  type QueryLimits,
} from "./connectors.js";
import { assertReadOnly } from "./sql.js";
import {
  dateRangeDates,
  hasDatePlaceholder,
  substituteDate,
  type DateBatchProgress,
} from "../shared/date-batch.js";
import type { QuerySource } from "../shared/types.js";

export interface DateBatchState {
  controller: AbortController;
  cancel?: () => Promise<void>;
}
class BatchStorageError extends Error {}

export function prepareDateBatch(
  source: QuerySource,
  engine: EngineConnection,
): DateBatchProgress | undefined {
  const placeholder = hasDatePlaceholder(source.sql, engine.engine);
  if (placeholder && !source.dateRange)
    throw new Error("Для {{date}} выберите диапазон дат");
  if (source.dateRange && !placeholder)
    throw new Error("Для запуска по датам добавьте {{date}} в SQL");
  if (!source.dateRange) {
    assertReadOnly(source.sql);
    return;
  }
  const dates = dateRangeDates(source.dateRange);
  assertReadOnly(substituteDate(source.sql, dates[0]!, engine.engine));
  return {
    total: dates.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    attempt: 0,
    items: dates.map((date) => ({ date, status: "pending", attempts: 0 })),
  };
}

/** Recovery never replays SQL. Previously committed dates remain available. */
export function interruptQueryRuns(db: Database) {
  db.transaction(() => {
    for (const row of db.query(
      "SELECT id,batch FROM query_runs WHERE status IN ('running','cancelling') AND batch IS NOT NULL",
    ).rows) {
      const batch = row.batch as DateBatchProgress;
      for (const item of batch.items)
        if (["pending", "running", "retrying"].includes(item.status))
          item.status = "interrupted";
      delete batch.currentDate;
      batch.attempt = 0;
      db.query("UPDATE query_runs SET batch=?2 WHERE id=?1", [row.id, batch]);
    }
    db.query(
      "UPDATE result_sets SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (SELECT result_set_id FROM query_runs WHERE batch IS NOT NULL AND status IN ('running','cancelling'))",
    );
    db.query(
      "UPDATE query_runs SET status='interrupted',error='Сервер перезапущен во время выполнения',finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('running','cancelling')",
    );
  });
}

function redacted(error: unknown, engine: EngineConnection) {
  let text = String(
    error instanceof Error ? error.message : error || "Ошибка запроса",
  ).slice(0, 4000);
  if (engine.password) text = text.replaceAll(engine.password, "[скрыто]");
  return text;
}
function delay(milliseconds: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
function appendResult(
  db: Database,
  id: string,
  source: QuerySource,
  output: EngineResult,
  date: string,
  batch: DateBatchProgress,
  elapsed: number,
  quotaBytes: number,
  signal: AbortSignal,
) {
  return db.transaction(() => {
    signal.throwIfAborted();
    const run = db.query(
      "SELECT status,result_set_id FROM query_runs WHERE id=?1",
      [id],
    ).rows[0];
    if (run?.status !== "running")
      throw new DOMException("Запрос отменён", "AbortError");
    let result = run.result_set_id
      ? db.query("SELECT * FROM result_sets WHERE id=?1", [run.result_set_id])
          .rows[0]
      : undefined;
    const columns = output.columns;
    const firstDate = batch.items.find(
      (item) => item.status === "completed",
    )!.date;
    if (
      result &&
      (result.columns.length !== columns.length ||
        columns.some(
          (column, index) =>
            column.type !== result.columns[index].type ||
            // Preserve first-result headers, including fixed aliases containing a date.
            // Only varying unaliased expression names need date-aware comparison.
            (column.name !== result.columns[index].name &&
              column.name.replaceAll(date, "{{date}}") !==
                result.columns[index].name.replaceAll(firstDate, "{{date}}")),
        ))
    )
      throw new BatchStorageError(
        "Структура столбцов изменилась между датами. Пакет остановлен; предыдущие результаты сохранены.",
      );
    const used = Number(
      db.query("SELECT COALESCE(sum(byte_count),0) size FROM result_sets")
        .rows[0].size,
    );
    if (used + output.byteCount > quotaBytes)
      throw new BatchStorageError(
        "Квота хранения результатов исчерпана. Пакет остановлен; предыдущие результаты сохранены.",
      );
    if (!result) {
      result = { id: randomUUID(), row_count: 0, byte_count: 0 };
      db.query(
        "INSERT INTO result_sets(id,columns,row_count,byte_count,source) VALUES(?1,?2,0,0,?3)",
        [result.id, columns, source],
      );
    }
    let offset = 0;
    let chunk = Math.floor(result.row_count / 500);
    const tailSize = result.row_count % 500;
    if (tailSize && output.rows.length) {
      const tail = db.query(
        "SELECT rows FROM result_chunks WHERE result_set_id=?1 AND chunk_index=?2",
        [result.id, chunk],
      ).rows[0]?.rows;
      if (!Array.isArray(tail) || tail.length !== tailSize)
        throw new BatchStorageError(
          "Сохранённый результат неполный. Пакет остановлен.",
        );
      offset = Math.min(500 - tailSize, output.rows.length);
      db.query(
        "UPDATE result_chunks SET rows=?3 WHERE result_set_id=?1 AND chunk_index=?2",
        [result.id, chunk++, [...tail, ...output.rows.slice(0, offset)]],
      );
    }
    while (offset < output.rows.length) {
      db.query(
        "INSERT INTO result_chunks(result_set_id,chunk_index,rows) VALUES(?1,?2,?3)",
        [result.id, chunk++, output.rows.slice(offset, offset + 500)],
      );
      offset += 500;
    }
    const rowCount = result.row_count + output.rows.length;
    db.query(
      "UPDATE result_sets SET row_count=?2,byte_count=byte_count+?3,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
      [result.id, rowCount, output.byteCount],
    );
    db.query(
      "UPDATE query_runs SET result_set_id=?2,row_count=?3,batch=?4,elapsed_ms=?5 WHERE id=?1",
      [id, result.id, rowCount, batch, elapsed],
    );
    return { id: result.id as string, rowCount };
  });
}

export async function performDateBatch(options: {
  db: Database;
  id: string;
  source: QuerySource;
  engine: EngineConnection;
  state: DateBatchState;
  batch: DateBatchProgress;
  limits: QueryLimits & { quotaBytes: number };
}) {
  const { db, id, source, engine, state, limits } = options;
  let batch = options.batch;
  const started = Date.now();
  const persist = () =>
    db.query("UPDATE query_runs SET batch=?2,elapsed_ms=?3 WHERE id=?1", [
      id,
      batch,
      Date.now() - started,
    ]);
  const finish = (status: string, error?: string) => {
    delete batch.currentDate;
    batch.attempt = 0;
    db.transaction(() => {
      // Retention starts when the snapshot stops growing, not at the first date.
      db.query(
        "UPDATE result_sets SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=(SELECT result_set_id FROM query_runs WHERE id=?1)",
        [id],
      );
      db.query(
        "UPDATE query_runs SET status=?2,batch=?3,error=?4,elapsed_ms=?5,finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1",
        [id, status, batch, error, Date.now() - started],
      );
    });
  };
  try {
    for (let index = 0; index < batch.items.length; index++) {
      state.controller.signal.throwIfAborted();
      for (
        let attempt = 1;
        attempt <= source.dateRange!.retries + 1;
        attempt++
      ) {
        state.controller.signal.throwIfAborted();
        const item = batch.items[index]!;
        item.status = "running";
        item.attempts = attempt;
        delete item.error;
        batch.currentDate = item.date;
        batch.attempt = attempt;
        persist();
        const timeout = new AbortController();
        let timedOut = false;
        let cancel: (() => Promise<void>) | undefined;
        let cancelling: Promise<void> | undefined;
        const cancelOnce = () =>
          (cancelling ??= cancel
            ? cancel().catch(() => {})
            : Promise.resolve());
        state.cancel = undefined;
        const timer = setTimeout(() => {
          timedOut = true;
          timeout.abort();
          void cancelOnce();
        }, limits.timeoutMs);
        try {
          const sql = substituteDate(source.sql, item.date, engine.engine);
          assertReadOnly(sql);
          const output = await executeEngine(
            engine,
            { ...source, sql, dateRange: undefined },
            randomUUID(),
            limits,
            AbortSignal.any([state.controller.signal, timeout.signal]),
            (fn) => {
              cancel = fn;
              state.cancel = cancelOnce;
            },
          );
          state.controller.signal.throwIfAborted();
          if (timeout.signal.aborted)
            throw new Error("Превышено время выполнения запроса");
          const next = structuredClone(batch);
          next.items[index]!.status = "completed";
          next.items[index]!.rowCount = output.rows.length;
          next.completed++;
          next.succeeded++;
          appendResult(
            db,
            id,
            source,
            output,
            item.date,
            next,
            Date.now() - started,
            limits.quotaBytes,
            state.controller.signal,
          );
          batch = next;
          break;
        } catch (error) {
          await cancelOnce();
          if (state.controller.signal.aborted) throw error;
          item.error = timedOut
            ? "Превышено время выполнения запроса"
            : redacted(error, engine);
          if (error instanceof BatchStorageError) {
            item.status = "failed";
            batch.completed++;
            batch.failed++;
            throw error;
          }
          if (attempt <= source.dateRange!.retries) {
            item.status = "retrying";
            persist();
            // Retry only this date. The previous committed dates are untouched.
            clearTimeout(timer);
            state.cancel = undefined;
            await delay(
              Math.min(250 * 2 ** (attempt - 1), 2000),
              state.controller.signal,
            );
          } else {
            item.status = "failed";
            batch.completed++;
            batch.failed++;
            persist();
          }
        } finally {
          clearTimeout(timer);
          state.cancel = undefined;
        }
      }
    }
    finish(
      batch.failed ? "failed" : "completed",
      batch.failed
        ? `Не удалось выполнить ${batch.failed} из ${batch.total} дат. Успешные результаты сохранены.`
        : undefined,
    );
  } catch (error) {
    const cancelled = state.controller.signal.aborted;
    for (const item of batch.items)
      if (["pending", "running", "retrying"].includes(item.status))
        item.status = "cancelled";
    finish(
      cancelled ? "cancelled" : "failed",
      cancelled
        ? "Пакет остановлен. Успешные результаты сохранены."
        : redacted(error, engine),
    );
  }
}
