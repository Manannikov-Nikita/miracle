import { useEffect, useMemo, useState } from "react";
import type { Cell, ResultSet, TableSpec } from "../../shared/types";
import { api } from "../api";
import { chartTableData } from "./chartTableModel";
import { acquireTableSnapshot } from "./tableSnapshot";

/** Chart and inspector share immutable source rows, but prepare each card's own table settings. */
export function useChartTableData(
  result: ResultSet,
  table?: TableSpec,
  visibleColumns?: string[],
  loadRows = true,
) {
  const transformed = table !== undefined || visibleColumns !== undefined;
  const needsRows = loadRows || transformed;
  const [snapshot, setSnapshot] = useState<{ id: string; rows: Cell[][] }>();
  const [failure, setFailure] = useState<{ id: string; error: Error }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!needsRows) return;
    let live = true;
    setSnapshot(undefined);
    setFailure(undefined);
    const read = transformed ? acquireTableSnapshot(result.id) : undefined;
    const controller = new AbortController();
    const pending =
      read?.promise ??
      api<{ rows: Cell[][] }>(
        `/api/result-sets/${encodeURIComponent(result.id)}/chart`,
        { signal: controller.signal },
      );
    pending
      .then(({ rows }) => {
        if (live) setSnapshot({ id: result.id, rows });
      })
      .catch((cause: unknown) => {
        if (live)
          setFailure({
            id: result.id,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
      });
    return () => {
      live = false;
      controller.abort();
      read?.release();
    };
  }, [result.id, transformed, needsRows, attempt]);
  const prepared = useMemo(() => {
    if (needsRows && snapshot?.id !== result.id) return null;
    try {
      return {
        data: chartTableData(
          result.columns,
          snapshot?.rows ?? [],
          table,
          visibleColumns,
        ),
      };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [result.id, result.columns, snapshot, needsRows, table, visibleColumns]);
  return {
    data: prepared?.data,
    error: failure?.id === result.id ? failure.error : undefined,
    preparationError: prepared?.error,
    retry: () => setAttempt((value) => value + 1),
  };
}
