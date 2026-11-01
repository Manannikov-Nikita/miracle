import { z } from "zod";
import {
  CUSTOM_CHART_LIMITS as limits,
  type CustomChartReport,
  type CustomChartStatus,
} from "../shared/custom-charts.js";
import { problem } from "./project-store.js";

export interface CustomChartIdentity {
  resultSetId: string;
  specHash: string;
}
const reportSchema = z
  .object({
    browserId: z.uuid(),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    resultSetId: z.uuid(),
    specHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["rendering", "rendered", "error"]),
    stage: z.string().max(100).optional(),
    message: z.string().max(limits.reportMessage).optional(),
  })
  .strict();

type Entry = {
  boardId: string;
  nodeId: string;
  at: number;
  report: CustomChartReport;
};

/** Browser observations are ephemeral and never enter board state or the event log. */
export class CustomChartStatusStore {
  private entries = new Map<string, Entry>();
  constructor(private clock: () => number = Date.now) {}

  private cleanup(now: number) {
    for (const [key, entry] of this.entries)
      if (now - entry.at >= limits.reportTtlMs) this.entries.delete(key);
  }

  report(
    boardId: string,
    nodeId: string,
    current: CustomChartIdentity,
    input: unknown,
  ) {
    const report = reportSchema.parse(input);
    if (
      report.specHash !== current.specHash ||
      report.resultSetId !== current.resultSetId
    )
      throw problem(
        409,
        "Кастомный график или снимок изменён. Перезагрузите блок",
        "CUSTOM_CHART_STALE",
      );
    const now = this.clock();
    this.cleanup(now);
    const key = JSON.stringify([boardId, nodeId, report.browserId]);
    const previous = this.entries.get(key);
    // One monotonically increasing page counter also orders replacement renders.
    if (previous && previous.report.sequence >= report.sequence) return;
    this.entries.delete(key);
    this.entries.set(key, {
      boardId,
      nodeId,
      at: now,
      report: { ...report, observedAt: new Date(now).toISOString() },
    });
    while (this.entries.size > limits.maxReports)
      this.entries.delete(this.entries.keys().next().value!);
  }

  read(
    boardId: string,
    nodeId: string,
    current: CustomChartIdentity,
  ): CustomChartStatus {
    this.cleanup(this.clock());
    const reports = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.boardId === boardId &&
          entry.nodeId === nodeId &&
          entry.report.resultSetId === current.resultSetId &&
          entry.report.specHash === current.specHash,
      )
      .map((entry) => ({ ...entry.report }));
    const status = reports.some((report) => report.status === "error")
      ? "error"
      : reports.some((report) => report.status === "rendering")
        ? "rendering"
        : reports.length
          ? "rendered"
          : "not_observed";
    return { status, reports };
  }
}
