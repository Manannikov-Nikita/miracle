import type { EditorDocument } from "../../shared/agents";
import type { DateRangeOptions } from "../../shared/types";
export interface EditorTab {
  id: string;
  name: string;
  sql: string;
  connectionId: string;
  database?: string;
  catalog?: string;
  schema?: string;
  queryId?: string;
  revision?: number;
  documentRevision?: number;
  externalSqlRevision?: number;
  resultSetId?: string;
  runId?: string;
  dateRange?: DateRangeOptions;
  cursor?: { lineNumber: number; column: number };
  scrollTop?: number;
}
export function documentToTab(doc: EditorDocument): EditorTab {
  const { revision, queryRevision, updatedAt: _, ...fields } = doc;
  return {
    ...fields,
    revision: queryRevision,
    documentRevision: revision,
    externalSqlRevision: revision,
  };
}
export function tabFields(tab: EditorTab) {
  return {
    name: tab.name,
    sql: tab.sql,
    connectionId: tab.connectionId,
    database: tab.database,
    catalog: tab.catalog,
    schema: tab.schema,
    queryId: tab.queryId,
    queryRevision: tab.revision,
    resultSetId: tab.resultSetId,
    runId: tab.runId,
    dateRange: tab.dateRange
      ? {
          startDate: tab.dateRange.startDate,
          endDate: tab.dateRange.endDate,
          granularity: tab.dateRange.granularity,
          retries: tab.dateRange.retries,
        }
      : undefined,
  };
}
const fingerprint = (tab: EditorTab) => JSON.stringify(tabFields(tab));
/** Rebase independent fields; two different edits of the same field require a choice. */
function mergeRemote(
  base: EditorDocument,
  local: EditorTab,
  remote: EditorDocument,
): EditorTab | null {
  const before = tabFields(documentToTab(base));
  const mine = tabFields(local);
  const theirs = tabFields(documentToTab(remote));
  // SQL and its execution context are one edit: never retarget an agent's SQL
  // to a connection/database that the user changed concurrently.
  const source = ({
    sql,
    connectionId,
    database,
    catalog,
    schema,
    dateRange,
  }: typeof mine) =>
    JSON.stringify({ sql, connectionId, database, catalog, schema, dateRange });
  if (
    source(mine) !== source(before) &&
    source(theirs) !== source(before) &&
    source(mine) !== source(theirs)
  )
    return null;
  const merged = { ...theirs };
  for (const key of Object.keys(mine) as (keyof typeof mine)[]) {
    const value = JSON.stringify(mine[key]);
    if (value === JSON.stringify(before[key])) continue;
    if (
      JSON.stringify(theirs[key]) !== JSON.stringify(before[key]) &&
      JSON.stringify(theirs[key]) !== value
    )
      return null;
    Object.assign(merged, { [key]: mine[key] });
  }
  const { queryRevision, ...fields } = merged;
  return {
    ...documentToTab(remote),
    ...fields,
    revision: queryRevision,
    cursor: local.cursor,
    scrollTop: local.scrollTop,
    externalSqlRevision:
      merged.sql === local.sql ? local.externalSqlRevision : remote.revision,
  };
}
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
/** Owns server revisions independently from saved-query revisions and Monaco view state. */
export class EditorSync {
  tabs: EditorTab[];
  readonly conflicts = new Map<string, EditorDocument | null>();
  private base = new Map<string, EditorDocument>();
  private inFlight = new Map<string, string>();
  private retries = new Map<
    string,
    { fingerprint: string; mutationId: string }
  >();
  private pending?: Promise<void>;
  constructor(
    documents: EditorDocument[],
    private request: Request,
    private changed: (tabs: EditorTab[]) => void,
  ) {
    this.tabs = documents.map(documentToTab);
    for (const doc of documents) this.base.set(doc.id, doc);
  }
  local(tabs: EditorTab[]) {
    this.tabs = tabs;
  }
  restore(tabs: EditorTab[]) {
    this.tabs = tabs;
    for (const tab of tabs) {
      const base = this.base.get(tab.id);
      if (!base && tab.documentRevision !== undefined)
        this.conflicts.set(tab.id, null);
      if (
        base &&
        tab.documentRevision !== undefined &&
        tab.documentRevision !== base.revision &&
        this.dirty(tab)
      )
        this.conflicts.set(tab.id, base);
    }
  }
  dirty(tab: EditorTab) {
    const base = this.base.get(tab.id);
    return !base || fingerprint(tab) !== fingerprint(documentToTab(base));
  }
  private publish() {
    this.changed([...this.tabs]);
  }
  receive(doc: EditorDocument) {
    const base = this.base.get(doc.id);
    const conflicting = this.conflicts.get(doc.id);
    if (
      doc.revision <= Math.max(base?.revision ?? 0, conflicting?.revision ?? 0)
    )
      return;
    const local = this.tabs.find((t) => t.id === doc.id);
    const replacement = documentToTab(doc);
    const mark = fingerprint(replacement);
    const acknowledged =
      this.inFlight.get(doc.id) === mark ||
      this.retries.get(doc.id)?.fingerprint === mark;
    const next = !local
      ? replacement
      : acknowledged
        ? { ...local, documentRevision: doc.revision }
        : base
          ? mergeRemote(base, local, doc)
          : fingerprint(local) === mark
            ? {
                ...replacement,
                cursor: local.cursor,
                scrollTop: local.scrollTop,
              }
            : null;
    if (!next) {
      this.conflicts.set(doc.id, doc);
      this.publish();
      return;
    }
    this.base.set(doc.id, doc);
    this.conflicts.delete(doc.id);
    this.tabs = local
      ? this.tabs.map((t) => (t.id === doc.id ? next : t))
      : [...this.tabs, next];
    this.publish();
  }
  deleted(id: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (tab && this.dirty(tab)) {
      this.conflicts.set(id, null);
      this.publish();
      return;
    }
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.base.delete(id);
    this.publish();
  }
  revisions() {
    return new Map([...this.base].map(([id, doc]) => [id, doc.revision]));
  }
  reconcile(documents: EditorDocument[], expected?: Map<string, number>) {
    for (const doc of documents) this.receive(doc);
    const ids = new Set(documents.map((d) => d.id));
    for (const [id, doc] of this.base)
      if (!ids.has(id) && (!expected || expected.get(id) === doc.revision))
        this.deleted(id);
  }
  useServer(id: string) {
    const remote = this.conflicts.get(id);
    if (remote === undefined) return;
    this.conflicts.delete(id);
    this.base.delete(id);
    if (remote) {
      this.tabs = this.tabs.filter((t) => t.id !== id);
      this.receive(remote);
    } else {
      this.tabs = this.tabs.filter((t) => t.id !== id);
      this.publish();
    }
  }
  keepAsCopy(id: string) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const copy = {
      ...tab,
      id: crypto.randomUUID(),
      name: `${tab.name} (копия)`,
      documentRevision: undefined,
      queryId: undefined,
      revision: undefined,
    };
    this.useServer(id);
    this.tabs = [...this.tabs, copy];
    this.publish();
  }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.save().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async save() {
    if (this.conflicts.size)
      throw new Error(
        "Разрешите конфликт SQL перед отправкой сообщения. Локальные изменения сохранены в браузере.",
      );
    // Repeat only for edits made while a request was in flight.
    for (let pass = 0; pass < 20; pass++) {
      if (this.conflicts.size)
        throw new Error("Разрешите конфликт SQL перед отправкой сообщения.");
      const snapshot = this.tabs.find((t) => this.dirty(t));
      if (!snapshot) return;
      const fields = tabFields(snapshot),
        mark = fingerprint(snapshot),
        base = this.base.get(snapshot.id);
      const previous = this.retries.get(snapshot.id);
      const mutationId =
        previous?.fingerprint === mark
          ? previous.mutationId
          : crypto.randomUUID();
      this.retries.set(snapshot.id, { fingerprint: mark, mutationId });
      this.inFlight.set(snapshot.id, mark);
      try {
        const saved = await this.request<EditorDocument>(
          base
            ? `/api/editor-documents/${snapshot.id}`
            : "/api/editor-documents",
          {
            method: base ? "PATCH" : "POST",
            body: JSON.stringify({
              ...Object.fromEntries(
                Object.entries(fields).map(([key, value]) => [
                  key,
                  base && value === undefined ? null : value,
                ]),
              ),
              ...(base
                ? { baseRevision: base.revision, mutationId }
                : { id: snapshot.id }),
            }),
          },
        );
        const latest = this.base.get(saved.id);
        if (!latest || latest.revision <= saved.revision) {
          this.base.set(saved.id, saved);
          this.tabs = this.tabs.map((t) =>
            t.id === saved.id ? { ...t, documentRevision: saved.revision } : t,
          );
        }
        this.retries.delete(saved.id);
        this.publish();
      } catch (error) {
        const failure = error as { status?: number; code?: string };
        if (
          failure.status === 409 &&
          (!failure.code || failure.code === "REVISION_CONFLICT")
        ) {
          const docs = await this.request<EditorDocument[]>(
            "/api/editor-documents",
          );
          const remote = docs.find((d) => d.id === snapshot.id);
          if (base && remote && remote.revision > base.revision) {
            this.receive(remote);
            if (!this.conflicts.has(snapshot.id)) {
              this.retries.delete(snapshot.id);
              continue;
            }
          }
          this.conflicts.set(snapshot.id, remote ?? null);
          this.publish();
        }
        throw error;
      } finally {
        this.inFlight.delete(snapshot.id);
      }
    }
    throw new Error(
      "SQL продолжает меняться. Повторите отправку после сохранения.",
    );
  }
  async remove(id: string) {
    if (this.pending) await this.pending;
    const base = this.base.get(id);
    if (base)
      await this.request(`/api/editor-documents/${id}`, {
        method: "DELETE",
        body: JSON.stringify({
          baseRevision: base.revision,
          mutationId: crypto.randomUUID(),
        }),
      });
    this.base.delete(id);
    this.conflicts.delete(id);
    this.tabs = this.tabs.filter((t) => t.id !== id);
    this.publish();
  }
}
