import type { DateBatchItem } from "./date-batch.js";
import type { RunStatus } from "./types.js";

/** Server-owned SQL runs for one chat, independent of the agent process. */
export interface AgentSqlRunActivity {
  id: string;
  chatId: string;
  turnId: string;
  status: RunStatus;
  sql: string;
  startedAt: string;
  finishedAt?: string;
  /** Persisted execution time; excludes pauses for date batches. */
  durationMs?: number;
  resultSetId?: string;
  error?: string;
  dateBatch?: {
    total: number;
    completed: number;
    succeeded: number;
    failed: number;
    currentDate?: string;
    attempt: number;
    maxAttempts: number;
    currentStatus?: DateBatchItem["status"];
  };
}

export interface AgentSqlActivity {
  /** All unfinished runs, followed by at most 20 recent terminal runs. */
  runs: AgentSqlRunActivity[];
  /** Running and cancelling runs; paused batches occupy no execution slot. */
  activeCount: number;
}
