import { useEffect, useMemo, useState } from "react";
import type { Cell, ResultSet, TableSpec } from "../../shared/types";
import { api } from "../api";
import { chartTableData } from "./chartTableModel";
import { acquireTableSnapshot } from "./tableSnapshot";

/** Chart and inspector share immutable source rows, but prepare each card's own table settings. */
export function useChartTableData(
  result: ResultSet | null,
  table?: TableSpec,
  visibleColumns?: string[],
  mode: "chart" | "histogram" | "metadata" = "chart",
) {
  const transformed = table !== undefined || visibleColumns !== undefined;
  const source = transformed || mode === "histogram" ? "table" : mode;
  const needsRows = source !== "metadata";
  const resultId = result?.id;
  const [snapshot, setSnapshot] = useState<{
    id: string;
    source: typeof source;
    rows: Cell[][];
  }>();
  const [failure, setFailure] = useState<{
    id: string;
    source: typeof source;
    error: Error;
  }>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!needsRows || !resultId) return;
    let live = true;
    setSnapshot(undefined);
    setFailure(undefined);
    const read =
      source === "table" ? acquireTableSnapshot(resultId) : undefined;
    const controller = new AbortController();
    const pending =
      read?.promise ??
      api<{ rows: Cell[][] }>(
        `/api/result-sets/${encodeURIComponent(resultId)}/chart`,
        { signal: controller.signal },
      );
    pending
      .then(({ rows }) => {
        if (live) setSnapshot({ id: resultId, source, rows });
      })
      .catch((cause: unknown) => {
        if (live)
          setFailure({
            id: resultId,
            source,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
      });
    return () => {
      live = false;
      controller.abort();
      read?.release();
    };
  }, [resultId, source, needsRows, attempt]);
  const prepared = useMemo(() => {
    if (
      !result ||
      (needsRows && (snapshot?.id !== result.id || snapshot.source !== source))
    )
      return null;
    try {
      return {
        data: chartTableData(
          result.columns,
          needsRows ? (snapshot?.rows ?? []) : [],
          table,
          visibleColumns,
        ),
      };
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : String(cause) };
    }
  }, [result, snapshot, needsRows, source, table, visibleColumns]);
  return {
    data: prepared?.data,
    error:
      failure && failure.id === resultId && failure.source === source
        ? failure.error
        : undefined,
    preparationError: prepared?.error,
    retry: () => setAttempt((value) => value + 1),
  };
}
