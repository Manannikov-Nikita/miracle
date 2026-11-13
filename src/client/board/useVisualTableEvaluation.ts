import { useEffect, useRef, useState } from "react";
import type {
  VisualTableResult,
  VisualTableSpec,
} from "../../shared/visual-table";
import { evaluateVisualTable } from "../api";

/** Every mounted table owns its request; late completions never cross revisions. */
export function useVisualTableEvaluation(
  table: VisualTableSpec,
  offset: number,
) {
  const key = JSON.stringify([table, offset]);
  const scope = table.sourceResultSetId ?? "manual";
  const sequence = useRef(0);
  const latest = useRef(table);
  latest.current = table;
  const [last, setLast] = useState<{
    key: string;
    scope: string;
    data: VisualTableResult;
  }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const own = ++sequence.current;
    setBusy(true);
    setFailure(undefined);
    evaluateVisualTable(
      {
        table: latest.current,
        resultSetId: latest.current.sourceResultSetId,
        offset,
        limit: 500,
      },
      controller.signal,
    )
      .then((data) => {
        if (own === sequence.current && !controller.signal.aborted)
          setLast({ key, scope, data });
      })
      .catch((error) => {
        if (own === sequence.current && !controller.signal.aborted)
          setFailure({
            key,
            message: error instanceof Error ? error.message : String(error),
          });
      })
      .finally(() => {
        if (own === sequence.current && !controller.signal.aborted)
          setBusy(false);
      });
    return () => {
      controller.abort();
    };
  }, [key, scope, offset, attempt]);
  const data = last?.scope === scope ? last.data : undefined;
  return {
    data,
    error: failure?.key === key ? failure.message : undefined,
    busy,
    stale: Boolean(data && last?.key !== key),
    retry: () => setAttempt((value) => value + 1),
  };
}
