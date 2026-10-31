import { describe, expect, it, vi } from "vitest";
import { EditorSync, documentToTab } from "../src/client/agents/editor-sync";
import type { EditorDocument } from "../src/shared/agents";
const doc = (revision = 1, sql = "select 1"): EditorDocument => ({
  id: "doc",
  name: "query.sql",
  sql,
  connectionId: "connection",
  revision,
  updatedAt: "now",
});
describe("revisioned editor synchronization", () => {
  it("ignores duplicate events, accepts clean changes and preserves concurrent drafts", () => {
    const sync = new EditorSync([doc()], vi.fn(), vi.fn());
    sync.receive(doc(2, "select 2"));
    sync.receive(doc(2, "stale duplicate"));
    expect(sync.tabs[0].sql).toBe("select 2");
    sync.local([{ ...sync.tabs[0], sql: "my draft" }]);
    sync.receive(doc(3, "agent change"));
    expect(sync.tabs[0].sql).toBe("my draft");
    expect(sync.conflicts.has("doc")).toBe(true);
  });
  it("preserves edits typed during a save and advances the next base revision", async () => {
    let complete!: (value: EditorDocument) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(() => new Promise((r) => (complete = r)))
      .mockResolvedValueOnce(doc(3, "latest draft"));
    const sync = new EditorSync([doc()], request, vi.fn());
    sync.local([{ ...sync.tabs[0], sql: "first draft" }]);
    const pending = sync.flush();
    sync.local([{ ...sync.tabs[0], sql: "latest draft" }]);
    sync.receive(doc(2, "first draft"));
    complete(doc(2, "first draft"));
    await pending;
    expect(sync.tabs[0].sql).toBe("latest draft");
    expect(JSON.parse(request.mock.calls[1][1].body).baseRevision).toBe(2);
  });
  it("rehydrates reconnect state without deleting a local dirty document", () => {
    const sync = new EditorSync([doc()], vi.fn(), vi.fn());
    sync.local([{ ...sync.tabs[0], sql: "recover me" }]);
    sync.reconcile([]);
    expect(sync.tabs[0].sql).toBe("recover me");
    expect(sync.conflicts.has("doc")).toBe(true);
  });
  it("separates query revision from document revision", () => {
    expect(documentToTab({ ...doc(7), queryRevision: 3 })).toMatchObject({
      revision: 3,
      documentRevision: 7,
    });
  });
});

describe("editor recovery and acknowledgement races", () => {
  it("treats a stale browser recovery as a conflict rather than rebasing it onto newer SQL", () => {
    const sync = new EditorSync([doc(5, "new server SQL")], vi.fn(), vi.fn());
    sync.restore([{ ...documentToTab(doc(2, "offline draft")) }]);
    expect(sync.tabs[0].sql).toBe("offline draft");
    expect(sync.conflicts.has("doc")).toBe(true);
  });
  it("does not delete a newly streamed document on a stale reconnect list", () => {
    const sync = new EditorSync([doc()], vi.fn(), vi.fn());
    const before = sync.revisions();
    sync.receive({ ...doc(), id: "new" });
    sync.reconcile([doc()], before);
    expect(sync.tabs.map((t) => t.id)).toEqual(["doc", "new"]);
  });
  it("does not regress an accepted newer event when the previous save response arrives late", async () => {
    let complete!: (value: EditorDocument) => void;
    const request = vi.fn(
      () => new Promise<EditorDocument>((resolve) => (complete = resolve)),
    );
    const sync = new EditorSync([doc()], request as never, vi.fn());
    sync.local([{ ...sync.tabs[0], sql: "my change" }]);
    const save = sync.flush();
    sync.receive(doc(2, "my change"));
    sync.receive(doc(3, "newer agent SQL"));
    complete(doc(2, "my change"));
    await save;
    expect(sync.tabs[0]).toMatchObject({
      sql: "newer agent SQL",
      documentRevision: 3,
    });
    expect(request).toHaveBeenCalledOnce();
  });
  it("retries an ambiguous mutation using the same mutation id and explicitly clears stale optional context", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection dropped"))
      .mockResolvedValueOnce(doc(2, "new SQL"));
    const sync = new EditorSync(
      [{ ...doc(), runId: "old-run" }],
      request,
      vi.fn(),
    );
    sync.local([{ ...sync.tabs[0], sql: "new SQL", runId: undefined }]);
    await expect(sync.flush()).rejects.toThrow("connection dropped");
    await sync.flush();
    const first = JSON.parse(request.mock.calls[0][1].body),
      second = JSON.parse(request.mock.calls[1][1].body);
    expect(first.mutationId).toBe(second.mutationId);
    expect(first.runId).toBeNull();
  });
});

it("removes server-cleared optional fields while preserving only local Monaco view state", () => {
  const sync = new EditorSync(
    [
      {
        ...doc(),
        database: "old",
        queryId: "query",
        queryRevision: 3,
        resultSetId: "result",
        runId: "run",
      },
    ],
    vi.fn(),
    vi.fn(),
  );
  sync.local([
    { ...sync.tabs[0], cursor: { lineNumber: 2, column: 4 }, scrollTop: 50 },
  ]);
  sync.receive(doc(2));
  expect(sync.tabs[0]).toMatchObject({
    cursor: { lineNumber: 2, column: 4 },
    scrollTop: 50,
    documentRevision: 2,
  });
  for (const field of [
    "database",
    "queryId",
    "revision",
    "resultSetId",
    "runId",
  ])
    expect(sync.tabs[0][field as keyof (typeof sync.tabs)[0]]).toBeUndefined();
  expect(sync.dirty(sync.tabs[0])).toBe(false);
});

it("marks remote replacements separately from local keystrokes and save acknowledgements", async () => {
  const request = vi.fn().mockResolvedValueOnce(doc(2, "local typing"));
  const sync = new EditorSync([doc()], request, vi.fn());
  const initialStamp = sync.tabs[0].externalSqlRevision;
  sync.local([{ ...sync.tabs[0], sql: "local typing" }]);
  await sync.flush();
  expect(sync.tabs[0].externalSqlRevision).toBe(initialStamp);
  sync.receive(doc(3, "agent SQL"));
  expect(sync.tabs[0].externalSqlRevision).not.toBe(initialStamp);
});

describe("agent edits alongside independent local changes", () => {
  it("applies agent SQL immediately while retaining a local document rename", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ ...doc(3, "select 42"), name: "My analysis.sql" });
    const sync = new EditorSync([doc()], request, vi.fn());
    sync.local([
      {
        ...sync.tabs[0],
        name: "My analysis.sql",
        cursor: { lineNumber: 1, column: 3 },
      },
    ]);
    sync.receive(doc(2, "select 42"));
    expect(sync.conflicts.size).toBe(0);
    expect(sync.tabs[0]).toMatchObject({
      sql: "select 42",
      name: "My analysis.sql",
      documentRevision: 2,
      cursor: { lineNumber: 1, column: 3 },
    });
    await sync.flush();
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
      baseRevision: 2,
      sql: "select 42",
      name: "My analysis.sql",
    });
  });

  it("does not treat reordered date-range fields as unsaved edits", () => {
    const range = {
      startDate: "2026-10-01",
      endDate: "2026-10-02",
      granularity: "day" as const,
      retries: 0,
    };
    const sync = new EditorSync(
      [{ ...doc(), dateRange: range }],
      vi.fn(),
      vi.fn(),
    );
    sync.local([
      {
        ...sync.tabs[0],
        dateRange: {
          retries: 0,
          granularity: "day",
          endDate: range.endDate,
          startDate: range.startDate,
        },
      },
    ]);
    expect(sync.dirty(sync.tabs[0])).toBe(false);
    sync.receive({ ...doc(2, "agent SQL"), dateRange: range });
    expect(sync.conflicts.size).toBe(0);
    expect(sync.tabs[0].sql).toBe("agent SQL");
  });

  it("rebases an independent local change when HTTP sees the agent revision before SSE", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("revision conflict"), {
          status: 409,
          code: "REVISION_CONFLICT",
        }),
      )
      .mockResolvedValueOnce([doc(2, "agent SQL")])
      .mockResolvedValueOnce({
        ...doc(3, "agent SQL"),
        name: "Local name.sql",
      });
    const sync = new EditorSync([doc()], request, vi.fn());
    sync.local([{ ...sync.tabs[0], name: "Local name.sql" }]);
    await sync.flush();
    expect(sync.conflicts.size).toBe(0);
    expect(sync.tabs[0]).toMatchObject({
      sql: "agent SQL",
      name: "Local name.sql",
      documentRevision: 3,
    });
    expect(JSON.parse(request.mock.calls[2][1].body)).toMatchObject({
      baseRevision: 2,
      sql: "agent SQL",
    });
  });
});

it("never silently combines agent SQL with a local change of its source context", () => {
  const sync = new EditorSync([doc()], vi.fn(), vi.fn());
  sync.local([{ ...sync.tabs[0], connectionId: "other-connection" }]);
  sync.receive(doc(2, "SQL for original connection"));
  expect(sync.conflicts.has("doc")).toBe(true);
  expect(sync.tabs[0]).toMatchObject({
    sql: "select 1",
    connectionId: "other-connection",
  });
});
