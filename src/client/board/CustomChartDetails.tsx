import { useEffect, useState } from "react";
import type { BoardNode } from "../../shared/types";
import type { CustomChartStatus } from "../../shared/custom-charts";
import { api } from "../api";

const labels: Record<CustomChartStatus["status"], string> = {
  not_observed: "Ожидает отрисовки в открытой доске",
  rendering: "График строится…",
  rendered: "Отрисован в браузере",
  error: "Ошибка отрисовки — агент может её исправить",
};

export default function CustomChartDetails({
  boardId,
  node,
}: {
  boardId?: string;
  node: BoardNode;
}) {
  const [status, setStatus] =
    useState<CustomChartStatus["status"]>("not_observed");
  const [unavailable, setUnavailable] = useState(false);
  const spec = node.data.customChart;
  useEffect(() => {
    setStatus("not_observed");
    setUnavailable(false);
    if (!boardId) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<CustomChartStatus>(
          `/api/boards/${encodeURIComponent(boardId)}/nodes/${encodeURIComponent(node.id)}/custom-chart-status`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setStatus(next.status);
        setUnavailable(false);
      } catch {
        if (controller.signal.aborted) return;
        setUnavailable(true);
      }
      timeout = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [boardId, node.id, node.data.resultSetId, spec]);

  return (
    <section className="board-custom-details" aria-label="Кастомный график">
      <p>{spec?.description || "Визуализация создана агентом."}</p>
      <p className="board-source-note" role="status">
        {unavailable ? "Не удалось получить состояние графика" : labels[status]}
      </p>
      <p className="board-source-note">
        Выберите блок и опишите изменения в чате агента.
      </p>
    </section>
  );
}
