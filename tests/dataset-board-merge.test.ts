import { expect, it } from "vitest";
import { mergeDatasetBoardDocuments } from "../src/client/board/dataset-merge";
import type { BoardDocument, BoardNodeData } from "../src/shared/types";

const snapshot: BoardNodeData = {
  title: "Monthly totals",
  kind: "result",
  datasetId: "sales",
  datasetRevision: 3,
  datasetName: "sales",
  resultSetId: "before",
  source: { kind: "local", sql: "select 3" },
  sourceRevision: 3,
};
const document = (data: BoardNodeData): BoardDocument => ({
  schemaVersion: 1,
  nodes: [{ id: "node", type: "artifact", position: { x: 80, y: 90 }, data }],
  edges: [],
});

it("rebases an unsaved board title edit onto the newer linked snapshot", () => {
  const result = mergeDatasetBoardDocuments(
    document(snapshot),
    document({ ...snapshot, title: "Quarterly totals" }),
    document({
      ...snapshot,
      datasetRevision: 4,
      resultSetId: "after",
      source: { kind: "local", sql: "select 4" },
      sourceRevision: 4,
    }),
  );
  expect(result.conflicts).toEqual([]);
  expect(result.document.nodes[0].data).toMatchObject({
    title: "Quarterly totals",
    resultSetId: "after",
    source: { kind: "local", sql: "select 4" },
    datasetRevision: 4,
  });
});

it("preserves a conflict when the linked block title was changed on both sides", () => {
  const result = mergeDatasetBoardDocuments(
    document(snapshot),
    document({ ...snapshot, title: "Local title" }),
    document({
      ...snapshot,
      title: "Remote title",
      datasetRevision: 4,
      resultSetId: "after",
    }),
  );
  expect(result.conflicts).toEqual([{ kind: "node", id: "node" }]);
});
