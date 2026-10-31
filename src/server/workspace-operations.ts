import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boardDocumentSchema, sourceSchema } from "./validation.js";
import { ProjectStore, problem } from "./project-store.js";
import type {
  Board,
  BoardDocument,
  QueryDocument,
  QuerySource,
} from "../shared/types.js";

const name = z.string().trim().min(1).max(200);
const boardDto = (r: any): Board => ({
  id: r.id,
  name: r.name,
  revision: r.revision,
  document: r.document,
  updatedAt: new Date(r.updated_at).toISOString(),
});
const queryDto = (r: any): QueryDocument => ({
  id: r.id,
  name: r.name,
  revision: r.revision,
  ...r.source,
  updatedAt: new Date(r.updated_at).toISOString(),
});
export class WorkspaceOperations {
  constructor(
    readonly store: ProjectStore,
    private checkConnection: (id: string) => Promise<unknown>,
  ) {}
  private get db() {
    return this.store.db;
  }
  queries() {
    return this.db
      .query("SELECT * FROM queries ORDER BY updated_at DESC")
      .rows.map(queryDto);
  }
  query(id: string) {
    const row = this.db.query("SELECT * FROM queries WHERE id=?1", [id])
      .rows[0];
    if (!row) throw problem(404, "Запрос не найден");
    return queryDto(row);
  }
  async saveQuery(input: unknown, id?: string) {
    const b = sourceSchema
      .extend({
        name,
        baseRevision: z.number().int().nonnegative().optional(),
        mutationId: z.uuid().optional(),
      })
      .parse(input);
    await this.checkConnection(b.connectionId);
    return this.store.once(
      `query:${id || "new"}`,
      b.mutationId || randomUUID(),
      b,
      () => {
        const { name: label, baseRevision, mutationId, ...source } = b;
        const key = id || randomUUID();
        if (id && baseRevision === undefined)
          throw problem(400, "Нужна версия запроса");
        const previous = id
          ? this.db.query("SELECT * FROM queries WHERE id=?1", [id]).rows[0]
          : undefined;
        const row = id
          ? this.db.query(
              "UPDATE queries SET name=?2,source=?3,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND revision=?4 RETURNING *",
              [key, label, source, baseRevision],
            ).rows[0]
          : this.db.query(
              "INSERT INTO queries(id,name,source) VALUES(?1,?2,?3) RETURNING *",
              [key, label, source],
            ).rows[0];
        if (!row)
          throw problem(
            409,
            "Запрос изменён в другой вкладке. Перезагрузите или сохраните копию",
            "REVISION_CONFLICT",
          );
        const value = queryDto(row);
        this.store.publish("queries.changed", key, value);
        if (previous) this.syncQueryEditors(queryDto(previous), value);
        return value;
      },
    );
  }
  private syncQueryEditors(previous: QueryDocument, next: QueryDocument) {
    const connection = this.db.query(
      "SELECT database_name,catalog,schema_name FROM connections WHERE id=?1",
      [previous.connectionId],
    ).rows[0];
    // Saving a query materializes inherited connection defaults. Compare the
    // effective context so an otherwise clean editor still follows that query.
    const sourceKey = (source: QuerySource) =>
      JSON.stringify(
        sourceSchema.parse({
          ...source,
          database: source.database ?? (connection?.database_name || undefined),
          catalog: source.catalog ?? (connection?.catalog || undefined),
          schema: source.schema ?? (connection?.schema_name || undefined),
        }),
      );
    const before = sourceKey(previous);
    const source = sourceSchema.parse(next);
    for (const editor of this.store.editors()) {
      if (
        editor.queryId !== previous.id ||
        editor.queryRevision !== previous.revision
      )
        continue;
      const currentSource = sourceSchema.safeParse(editor);
      if (
        !currentSource.success ||
        sourceKey(currentSource.data) !== before
      )
        continue;
      // Linked clean documents follow their saved query atomically. Divergent
      // drafts keep both their contents and the query revision they were based on.
      this.store.updateEditor(editor.id, {
        ...source,
        database: source.database ?? null,
        catalog: source.catalog ?? null,
        schema: source.schema ?? null,
        dateRange: source.dateRange ?? null,
        name: editor.name === previous.name ? next.name : editor.name,
        queryRevision: next.revision,
        baseRevision: editor.revision,
        mutationId: randomUUID(),
      });
    }
  }
  deleteQuery(id: string, input: unknown) {
    const b = z
      .object({
        baseRevision: z.number().int().nonnegative(),
        mutationId: z.uuid(),
      })
      .parse(input);
    return this.store.once(`query-delete:${id}`, b.mutationId, b, () => {
      this.query(id);
      if (
        !this.db.query("DELETE FROM queries WHERE id=?1 AND revision=?2", [
          id,
          b.baseRevision,
        ]).rowCount
      )
        throw problem(
          409,
          "Запрос изменён. Обновите список перед удалением",
          "REVISION_CONFLICT",
        );
      this.store.publish("queries.changed", id, { id });
      return { ok: true };
    });
  }
  boards() {
    return this.db
      .query(
        "SELECT id,name,revision,updated_at FROM boards ORDER BY updated_at DESC",
      )
      .rows.map((r) => ({
        id: r.id,
        name: r.name,
        revision: r.revision,
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
  }
  board(id: string): Board {
    const row = this.db.query("SELECT * FROM boards WHERE id=?1", [id]).rows[0];
    if (!row) throw problem(404, "Доска не найдена");
    return boardDto(row);
  }
  private refs(id: string, document: BoardDocument) {
    this.db.query("DELETE FROM board_result_refs WHERE board_id=?1", [id]);
    const ids = [
      ...new Set(
        document.nodes.flatMap((n) =>
          n.data.resultSetId ? [n.data.resultSetId] : [],
        ),
      ),
    ];
    for (const resultId of ids) {
      const r = this.db.query(
        "SELECT id,row_count FROM result_sets WHERE id=?1",
        [resultId],
      ).rows[0];
      if (!r) throw problem(400, "Результат блока не найден");
      if (
        this.db.query(
          "SELECT id FROM query_runs WHERE result_set_id=?1 AND status IN ('running','cancelling')",
          [resultId],
        ).rowCount
      )
        throw problem(
          409,
          "Дождитесь завершения или остановите пакет перед добавлением результата на доску",
        );
      if (
        document.nodes.some(
          (n) => n.data.resultSetId === resultId && n.data.view === "chart",
        ) &&
        r.row_count > 5000
      )
        throw problem(422, "График превышает лимит 5000 точек");
      this.db.query(
        "INSERT INTO board_result_refs(board_id,result_set_id) VALUES(?1,?2)",
        [id, resultId],
      );
    }
  }
  createBoard(input: unknown): Board {
    const b = z
      .object({
        name,
        document: boardDocumentSchema.default({
          schemaVersion: 1,
          nodes: [],
          edges: [],
        }),
        mutationId: z.uuid().optional(),
      })
      .parse(input);
    return this.store.once("board:new", b.mutationId || randomUUID(), b, () => {
      const id = randomUUID();
      const row = this.db.query(
        "INSERT INTO boards(id,name,document) VALUES(?1,?2,?3) RETURNING *",
        [id, b.name, b.document],
      ).rows[0];
      this.refs(id, b.document);
      const board = boardDto(row);
      this.store.publish("board.updated", id, board);
      return board;
    });
  }
  updateBoard(id: string, input: unknown): Board {
    const b = z
      .object({
        name: name.optional(),
        baseRevision: z.number().int().nonnegative(),
        document: boardDocumentSchema,
        mutationId: z.uuid().optional(),
      })
      .parse(input);
    return this.store.once(
      `board:${id}`,
      b.mutationId || randomUUID(),
      b,
      () => {
        const current = this.board(id);
        const document = {
          ...b.document,
          nodes: b.document.nodes.map((node) => {
            const old = current.document.nodes.find((n) => n.id === node.id);
            return old &&
              JSON.stringify(old.data.source) !==
                JSON.stringify(node.data.source)
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    sourceRevision: Math.max(
                      (old.data.sourceRevision ?? 0) + 1,
                      node.data.sourceRevision ?? 0,
                    ),
                  },
                }
              : node;
          }),
        };
        const row = this.db.query(
          "UPDATE boards SET name=COALESCE(?2,name),document=?3,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND revision=?4 RETURNING *",
          [id, b.name, document, b.baseRevision],
        ).rows[0];
        if (!row)
          throw problem(
            409,
            "Доска изменена в другой вкладке. Перезагрузите или сохраните копию",
            "REVISION_CONFLICT",
          );
        this.refs(id, document);
        const board = boardDto(row);
        this.store.publish("board.updated", id, board);
        return board;
      },
    );
  }
  deleteBoard(id: string, input: unknown) {
    const b = z
      .object({
        baseRevision: z.number().int().nonnegative(),
        mutationId: z.uuid(),
      })
      .parse(input);
    return this.store.once(`board-delete:${id}`, b.mutationId, b, () => {
      this.board(id);
      if (
        !this.db.query("DELETE FROM boards WHERE id=?1 AND revision=?2", [
          id,
          b.baseRevision,
        ]).rowCount
      )
        throw problem(
          409,
          "Доска изменена. Обновите список перед удалением",
          "REVISION_CONFLICT",
        );
      this.store.publish("board.deleted", id, { id });
      return { ok: true };
    });
  }
  patchBoard(id: string, input: unknown): Board {
    const b = z
      .object({
        baseRevision: z.number().int().nonnegative(),
        mutationId: z.uuid(),
        name: name.optional(),
        operations: z.array(z.record(z.string(), z.unknown())).max(200),
      })
      .parse(input);
    return this.store.once(`board-operations:${id}`, b.mutationId, b, () => {
      const current = this.board(id);
      if (current.revision !== b.baseRevision)
        throw problem(409, "Доска изменена", "REVISION_CONFLICT");
      const document = structuredClone(current.document);
      for (const op of b.operations) {
        const key = typeof op.id === "string" ? op.id : "";
        switch (op.type) {
          case "add_node":
            document.nodes.push(op.node as any);
            break;
          case "update_node": {
            const node = document.nodes.find((n) => n.id === key);
            if (!node) throw problem(404, "Блок не найден");
            const patch = z
              .object({
                position: z.object({ x: z.number(), y: z.number() }).optional(),
                width: z.number().optional(),
                height: z.number().optional(),
                data: z.record(z.string(), z.unknown()).optional(),
              })
              .strict()
              .parse(op.patch);
            Object.assign(node, {
              ...patch,
              data: { ...node.data, ...patch.data },
            });
            break;
          }
          case "remove_node":
            if (!document.nodes.some((n) => n.id === key))
              throw problem(404, "Блок не найден");
            document.nodes = document.nodes.filter((n) => n.id !== key);
            document.edges = document.edges.filter(
              (e) => e.source !== key && e.target !== key,
            );
            break;
          case "add_edge":
            document.edges.push(op.edge as any);
            break;
          case "update_edge": {
            const edge = document.edges.find((e) => e.id === key);
            if (!edge) throw problem(404, "Связь не найдена");
            Object.assign(
              edge,
              z
                .object({
                  label: z.string().max(200).optional(),
                  source: z.string().optional(),
                  target: z.string().optional(),
                  sourceHandle: z.string().optional(),
                  targetHandle: z.string().optional(),
                })
                .strict()
                .parse(op.patch),
            );
            break;
          }
          case "remove_edge":
            document.edges = document.edges.filter((e) => e.id !== key);
            break;
          default:
            throw problem(400, "Неизвестная операция доски");
        }
      }
      return this.updateBoard(id, {
        baseRevision: b.baseRevision,
        mutationId: b.mutationId,
        name: b.name,
        document,
      });
    });
  }
}
