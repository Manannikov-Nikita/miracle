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
    sentAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
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
      // Preserve sequence authority while a payload from a slightly fast client
      // clock could still pass the age gate. Visibility below still ends at 60s.
      if (now - Math.max(entry.at, entry.report.sentAt) >= limits.reportTtlMs)
        this.entries.delete(key);
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
    if (now - report.sentAt >= limits.reportTtlMs)
      throw problem(
        409,
        "Отчёт графика устарел. Повторите наблюдение в браузере",
        "CUSTOM_CHART_REPORT_STALE",
      );
    if (report.sentAt - now > 5000)
      throw problem(
        400,
        "Время отчёта графика опережает сервер более чем на 5 секунд",
        "CUSTOM_CHART_REPORT_TIME",
      );
    const key = JSON.stringify([boardId, nodeId, report.browserId]);
    const previous = this.entries.get(key);
    // One monotonically increasing page counter also orders replacement renders.
    if (previous && previous.report.sequence >= report.sequence) return;
    if (!previous && this.entries.size >= limits.maxReports)
      throw problem(
        429,
        "Достигнут лимит отчётов графиков. Повторите после истечения старых наблюдений",
        "CUSTOM_CHART_REPORT_CAPACITY",
      );
    this.entries.delete(key);
    this.entries.set(key, {
      boardId,
      nodeId,
      at: now,
      report: { ...report, observedAt: new Date(now).toISOString() },
    });
  }

  read(
    boardId: string,
    nodeId: string,
    current: CustomChartIdentity,
  ): CustomChartStatus {
    const now = this.clock();
    this.cleanup(now);
    const reports = [...this.entries.values()]
      .filter(
        (entry) =>
          now - entry.at < limits.reportTtlMs &&
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
