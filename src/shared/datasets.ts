import type { BoardNodeData, Column, QuerySource } from "./types.js";

export interface DatasetColumn extends Column {
  /** Column label as returned by the source before SQL name disambiguation. */
  sourceName: string;
  duckdbType: string;
}

export interface Dataset {
  id: string;
  name: string;
  revision: number;
  resultSetId: string;
  source: QuerySource;
  columns: DatasetColumn[];
  createdAt: string;
  updatedAt: string;
}

/** Preserve node presentation while replacing its server-managed snapshot. */
export function datasetSnapshot(
  data: BoardNodeData,
  snapshot: BoardNodeData,
): BoardNodeData {
  const { publishDataset: _, ...rest } = data;
  return {
    ...rest,
    datasetId: snapshot.datasetId,
    datasetRevision: snapshot.datasetRevision,
    datasetName: snapshot.datasetName,
    resultSetId: snapshot.resultSetId,
    source: snapshot.source,
    sourceRevision: snapshot.sourceRevision,
  };
}

const maxNameLength = 63;
export const DATASET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function suggestDatasetName(
  title: string,
  occupiedNames: Iterable<string>,
) {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const stem = (/^\d/.test(slug) ? `dataset_${slug}` : slug || "dataset").slice(
    0,
    maxNameLength,
  );
  const used = new Set(Array.from(occupiedNames, (name) => name.toLowerCase()));
  let candidate = stem;
  for (let index = 2; used.has(candidate); index++) {
    const suffix = `_${index}`;
    candidate = stem.slice(0, maxNameLength - suffix.length) + suffix;
  }
  return candidate;
}
