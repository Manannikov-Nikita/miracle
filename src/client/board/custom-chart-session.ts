import { api } from "../api";
import {
  serializeCustomChart,
  type CustomChartData,
  type CustomChartReportInput,
  type CustomChartSpec,
} from "../../shared/custom-charts";
import {
  mountCustomChartFrame,
  type ChartRuntimeStatus,
} from "./custom-chart-runtime";

// Shared by every mounted chart, unique to this page load (never persisted).
let browserId: string | undefined;
let sequence = 0;

export function startCustomChartRun(options: {
  host: HTMLElement;
  boardId: string;
  nodeId: string;
  resultSetId: string;
  spec: CustomChartSpec;
  width: number;
  height: number;
  theme: "dark" | "light";
  onStatus: (status: ChartRuntimeStatus) => void;
  onDiagnosticConnection: (connected: boolean | null) => void;
}): () => void {
  const controller = new AbortController();
  let upload: AbortController | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let destroyFrame: (() => void) | undefined;
  let hash = "";
  let current: ChartRuntimeStatus = { status: "rendering" };
  let lastUpload = 0;
  const live = () => !controller.signal.aborted;
  const report = () => {
    if (!live() || !hash) return;
    upload?.abort();
    upload = new AbortController();
    const reportSequence = ++sequence;
    lastUpload = reportSequence;
    const body: CustomChartReportInput = {
      browserId: (browserId ??= crypto.randomUUID()),
      sequence: reportSequence,
      sentAt: Date.now(),
      resultSetId: options.resultSetId,
      specHash: hash,
      ...current,
    };
    api<{ ok: true }>(
      `/api/boards/${encodeURIComponent(options.boardId)}/nodes/${encodeURIComponent(options.nodeId)}/custom-chart-status`,
      {
        method: "POST",
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          controller.signal,
          upload.signal,
          AbortSignal.timeout(10000),
        ]),
      },
    )
      .then((result) => {
        if (live() && lastUpload === reportSequence)
          options.onDiagnosticConnection(result?.ok === true);
      })
      .catch(() => {
        if (live() && lastUpload === reportSequence)
          options.onDiagnosticConnection(false);
      });
  };
  const onStatus = (status: ChartRuntimeStatus) => {
    if (!live()) return;
    current = status;
    options.onStatus(status);
    report();
  };
  options.onDiagnosticConnection(null);
  options.onStatus(current);
  void (async () => {
    let stage = "hash";
    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(serializeCustomChart(options.spec)),
      );
      if (!live()) return;
      hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      report();
      heartbeat = setInterval(report, 20000);
      stage = "data";
      const data = await api<CustomChartData>(
        `/api/result-sets/${encodeURIComponent(options.resultSetId)}/custom-chart`,
        { signal: controller.signal },
      );
      if (!live()) return;
      stage = "frame";
      destroyFrame = mountCustomChartFrame({
        ...options,
        data: { columns: data.columns, rows: data.rows },
        onStatus,
      });
    } catch (error) {
      if (live())
        onStatus({
          status: "error",
          stage,
          message: (error instanceof Error
            ? error.message
            : String(error)
          ).slice(0, 4000),
        });
    }
  })();
  return () => {
    controller.abort();
    upload?.abort();
    clearInterval(heartbeat);
    destroyFrame?.();
  };
}
