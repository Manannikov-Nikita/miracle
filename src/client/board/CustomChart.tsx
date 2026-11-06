import { useEffect, useId, useRef, useState } from "react";
import {
  serializeCustomChartPresentation,
  type CustomChartSpec,
} from "../../shared/custom-charts";
import type { TableSpec } from "../../shared/tableTypes";
import { ErrorBox } from "../components/UI";
import type { ChartRuntimeStatus } from "./custom-chart-runtime";
import { startCustomChartRun } from "./custom-chart-session";
import "./custom-chart.css";

export default function CustomChart({
  boardId,
  nodeId,
  resultSetId,
  spec,
  table,
  visibleColumns,
  onShowTable,
  reportStatus,
}: {
  boardId: string;
  nodeId: string;
  resultSetId: string;
  spec: CustomChartSpec;
  table?: TableSpec;
  visibleColumns?: string[];
  reportStatus?: boolean;
  onShowTable?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [status, setStatus] = useState<ChartRuntimeStatus>({
    status: "rendering",
  });
  const [connected, setConnected] = useState<boolean | null>(null);
  const [retry, setRetry] = useState(0);
  const specKey = serializeCustomChartPresentation(spec, table, visibleColumns);

  useEffect(() => {
    const element = container.current!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = {
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        };
        setSize((previous) =>
          previous.width === next.width && previous.height === next.height
            ? previous
            : next,
        );
      }, 120);
    });
    observer.observe(element);
    const updateTheme = () =>
      setTheme(
        document.documentElement.dataset.theme === "light" ? "light" : "dark",
      );
    updateTheme();
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!host.current || size.width <= 0 || size.height <= 0) return;
    return startCustomChartRun({
      host: host.current,
      boardId,
      nodeId,
      resultSetId,
      spec,
      table,
      visibleColumns,
      ...size,
      theme,
      reportStatus,
      onStatus: setStatus,
      onDiagnosticConnection: setConnected,
    });
  }, [
    boardId,
    nodeId,
    resultSetId,
    specKey,
    size.width,
    size.height,
    theme,
    reportStatus,
    retry,
  ]);

  return (
    <div
      ref={container}
      className="board-chart custom-chart nodrag nowheel"
      aria-describedby={descriptionId}
      aria-busy={status.status === "rendering"}
    >
      <p id={descriptionId} className="custom-chart-description">
        {spec.description || "Кастомный график по сохранённому снимку данных."}
      </p>
      <div ref={host} className="custom-chart-host" />
      {status.status === "rendering" && (
        <div className="board-loading custom-chart-overlay" role="status">
          Загрузка и построение графика…
        </div>
      )}
      {status.status === "error" && (
        <div className="custom-chart-overlay">
          <ErrorBox
            className="board-error nowheel"
            error={status.message}
            title="Не удалось отобразить кастомный график."
            hint={
              status.stage === "data"
                ? status.message
                : "Повторите отображение или попросите агента исправить график."
            }
            actions={
              <>
                <button
                  type="button"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Повторить
                </button>
                {onShowTable && (
                  <button type="button" onClick={onShowTable}>
                    Показать таблицу
                  </button>
                )}
              </>
            }
          />
        </div>
      )}
      {connected === false && (
        <p className="custom-chart-diagnostic" role="status">
          Нет связи с диагностикой. Агент пока не получил подтверждение
          отображения.
        </p>
      )}
    </div>
  );
}
