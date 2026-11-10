import {
  boardValuesEqual,
  mergeBoardDocuments,
} from "../../shared/board-merge";
import { datasetSnapshot } from "../../shared/datasets";
import type { BoardDocument, BoardNodeData } from "../../shared/types";

export function mergeDatasetBoardDocuments(
  base: BoardDocument,
  local: BoardDocument,
  remote: BoardDocument,
) {
  const before = new Map(base.nodes.map((node) => [node.id, node.data]));
  const wanted = new Map(local.nodes.map((node) => [node.id, node.data]));
  const snapshots = new Map<string, BoardNodeData>();
  for (const { id, data } of remote.nodes) {
    const original = before.get(id);
    const draft = wanted.get(id);
    if (
      data.kind !== "result" ||
      original?.kind !== "result" ||
      draft?.kind !== "result" ||
      (!data.datasetId && !original.datasetId) ||
      boardValuesEqual(
        datasetSnapshot(original, data),
        datasetSnapshot(original, original),
      ) ||
      !boardValuesEqual(
        datasetSnapshot(draft, original),
        datasetSnapshot(draft, draft),
      )
    )
      continue;
    snapshots.set(id, data);
  }
  if (!snapshots.size) return mergeBoardDocuments(base, local, remote);
  // Apply server-owned snapshot changes to both sides of the local edit. The
  // ordinary merge can then detect conflicts in the node's layout and style.
  const align = (document: BoardDocument): BoardDocument => ({
    ...document,
    nodes: document.nodes.map((node) => {
      const snapshot = snapshots.get(node.id);
      return snapshot
        ? { ...node, data: datasetSnapshot(node.data, snapshot) }
        : node;
    }),
  });
  return mergeBoardDocuments(align(base), align(local), remote);
}
