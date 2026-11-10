import { useDatasetCatalog } from "../dataset-catalog";
import DateBatchProgress from "./DateBatchProgress";
import { ErrorBox, Spinner } from "./UI";

export default function DatasetRefreshStatus({ id }: { id: string }) {
  const catalog = useDatasetCatalog();
  const state = catalog?.refreshes[id];
  if (!catalog || !state) return null;
  const run = state.run;
  return (
    <div className="dataset-refresh-status">
      {run?.batch ? (
        <DateBatchProgress
          run={run}
          onResume={() => void catalog.act(id, "resume")}
          onCancel={() => void catalog.act(id, "cancel")}
          action={state.action === "track" ? undefined : state.action}
        />
      ) : state.busy ? (
        <div className="dataset-refresh-line" role="status">
          <Spinner /> Обновление датасета…
        </div>
      ) : null}
      {run?.status === "running" && !state.action && (
        <button
          type="button"
          className="text-button"
          onClick={() => void catalog.act(id, "cancel")}
        >
          Остановить
        </button>
      )}
      {state.error && <ErrorBox error={state.error} />}
      {state.error && run && (
        <button
          type="button"
          className="text-button"
          disabled={state.busy}
          onClick={() => void catalog.act(id, "track")}
        >
          Проверить статус
        </button>
      )}
    </div>
  );
}
