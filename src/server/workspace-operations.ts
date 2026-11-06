import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  boardDocumentSchema,
  boardEdgeAppearanceSchema,
  boardEdgePointSchema,
  boardKindSchema,
  presentationSlideSchema,
  sourceSchema,
} from "./validation.js";
import { ProjectStore, problem, hash } from "./project-store.js";
import {
  boardChangedEntities,
  boardValuesEqual,
  mergeBoardDocuments,
} from "../shared/board-merge.js";
import type { AgentWorkTarget } from "../shared/agent-work.js";
import {
  boardKind,
  emptyPresentationDocument,
  PRESENTATION_MAX_SLIDES,
} from "../shared/presentation.js";
import {
  CUSTOM_CHART_LIMITS,
  serializeCustomChartPresentation,
} from "../shared/custom-charts.js";
import { customChartSchema } from "./custom-chart-schema.js";
import { CustomChartStatusStore } from "./custom-chart-status.js";
import {
  checkCustomChartMetadata,
  checkTableSourceMetadata,
} from "./custom-chart-data.js";
import type {
  Board,
  BoardDocument,
  BoardKind,
  BoardSummary,
  QueryDocument,
  QuerySource,
} from "../shared/types.js";

const name = z.string().trim().min(1).max(200);
const slideId = presentationSlideSchema.shape.id;
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
function checkBoardSize(document: BoardDocument) {
  const custom = document.nodes.some(
    (node) => node.data.customChart !== undefined,
  );
  if (!custom && boardKind(document) === "board") return;
  const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (custom && bytes > CUSTOM_CHART_LIMITS.boardBytes)
    throw problem(
      413,
      "Доска превышает 1.5 MiB. Сократите исходники кастомных графиков или разделите доску",
      "BOARD_TOO_LARGE",
    );
  // Leave space for the enclosing revisioned HTTP PATCH request.
  if (bytes > 2 * 1024 * 1024 - 1024)
    throw problem(
      413,
      "Презентация слишком велика. Сократите содержимое или разделите её",
      "BOARD_TOO_LARGE",
    );
}

export class WorkspaceOperations {
  private readonly chartStatuses = new CustomChartStatusStore();
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
        this.store.work.write([{ kind: "query", id: key }]);
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
      if (!currentSource.success || sourceKey(currentSource.data) !== before)
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
      this.store.work.write([{ kind: "query", id }]);
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
  boards(kind?: BoardKind): BoardSummary[] {
    return this.db
      .query(
        "SELECT id,name,revision,updated_at,COALESCE(json_extract(document,'$.kind'),'board') AS kind FROM boards WHERE ?1 IS NULL OR COALESCE(json_extract(document,'$.kind'),'board')=?1 ORDER BY updated_at DESC",
        [kind ?? null],
      )
      .rows.map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        revision: r.revision,
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
  }
  board(id: string): Board {
    const row = this.db.query("SELECT * FROM boards WHERE id=?1", [id]).rows[0];
    if (!row) throw problem(404, "Доска не найдена");
    return boardDto(row);
  }
  boardAtRevision(id: string, revision: number): Board {
    const current = this.board(id);
    if (current.revision === revision) return current;
    const row = this.db.query(
      "SELECT payload FROM project_events WHERE type='board.updated' AND entity_id=?1 AND json_extract(payload,'$.revision')=?2 ORDER BY id DESC LIMIT 1",
      [id, revision],
    ).rows[0];
    if (!row)
      throw problem(
        409,
        "Версия доски недоступна. Прочитайте доску заново",
        "REVISION_CONFLICT",
      );
    return JSON.parse(row.payload) as Board;
  }
  private customChartIdentity(boardId: string, nodeId: string) {
    const node = this.board(boardId).document.nodes.find(
      (node) => node.id === nodeId,
    );
    if (!node) throw problem(404, "Блок не найден");
    if (!node.data.customChart || !node.data.resultSetId)
      throw problem(400, "У блока нет кастомного графика или снимка");
    const spec = customChartSchema.parse(node.data.customChart);
    return {
      resultSetId: node.data.resultSetId,
      specHash: hash(
        serializeCustomChartPresentation(
          spec,
          node.data.table,
          node.data.visibleColumns,
        ),
      ),
    };
  }
  customChartStatus(boardId: string, nodeId: string) {
    return this.chartStatuses.read(
      boardId,
      nodeId,
      this.customChartIdentity(boardId, nodeId),
    );
  }
  reportCustomChartStatus(boardId: string, nodeId: string, input: unknown) {
    this.chartStatuses.report(
      boardId,
      nodeId,
      this.customChartIdentity(boardId, nodeId),
      input,
    );
    return { ok: true as const };
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
        "SELECT id,row_count,columns,byte_count FROM result_sets WHERE id=?1",
        [resultId],
      ).rows[0];
      if (!r) throw problem(400, "Результат блока не найден");
      if (
        this.db.query(
          "SELECT id FROM query_runs WHERE result_set_id=?1 AND status IN ('running','cancelling','paused')",
          [resultId],
        ).rowCount
      )
        throw problem(
          409,
          "Дождитесь завершения или остановите пакет перед добавлением результата на доску",
        );
      for (const node of document.nodes.filter(
        (node) =>
          node.data.resultSetId === resultId && node.data.view === "chart",
      )) {
        if (node.data.table || node.data.visibleColumns)
          checkTableSourceMetadata(r.row_count, r.columns.length, r.byte_count);
        else if (r.row_count > 5000)
          throw problem(422, "График превышает лимит 5000 точек");
      }
      for (const node of document.nodes.filter(
        (node) =>
          node.data.resultSetId === resultId &&
          node.data.customChart !== undefined,
      )) {
        if (node.data.table || node.data.visibleColumns)
          checkTableSourceMetadata(r.row_count, r.columns.length, r.byte_count);
        else checkCustomChartMetadata(r.row_count, r.columns.length);
      }
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
        kind: boardKindSchema.optional(),
        document: boardDocumentSchema.optional(),
        mutationId: z.uuid().optional(),
      })
      .parse(input);
    // The old create endpoint hashed the default empty board with the input.
    // Keep that retry identity while generating default slide IDs only once.
    const request = {
      name: b.name,
      kind: b.kind,
      document:
        b.document ??
        (b.kind === "presentation"
          ? undefined
          : {
              schemaVersion: 1 as const,
              nodes: [],
              edges: [],
            }),
      mutationId: b.mutationId,
    };
    return this.store.once(
      "board:new",
      b.mutationId || randomUUID(),
      request,
      () => {
        const document = request.document ?? emptyPresentationDocument();
        if (b.kind !== undefined && b.kind !== boardKind(document))
          throw problem(
            400,
            "Вид документа не соответствует запросу",
            "INVALID_BOARD_KIND",
          );
        checkBoardSize(document);
        const id = randomUUID();
        this.store.work.write([
          { kind: "board", id },
          ...document.nodes.map((node) => ({
            kind: "board-node" as const,
            boardId: id,
            id: node.id,
          })),
          ...document.edges.map((edge) => ({
            kind: "board-edge" as const,
            boardId: id,
            id: edge.id,
          })),
        ]);
        const row = this.db.query(
          "INSERT INTO boards(id,name,document) VALUES(?1,?2,?3) RETURNING *",
          [id, b.name, document],
        ).rows[0];
        this.refs(id, document);
        const board = boardDto(row);
        this.store.publish("board.updated", id, board);
        return board;
      },
    );
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
        if (boardKind(current.document) !== boardKind(b.document))
          throw problem(
            400,
            "Вид документа нельзя изменить",
            "INVALID_BOARD_KIND",
          );
        const base = this.boardAtRevision(id, b.baseRevision);
        const changed = boardChangedEntities(base.document, b.document);
        const merged = mergeBoardDocuments(
          base.document,
          b.document,
          current.document,
        );
        const targets: AgentWorkTarget[] = [
          ...changed.nodeIds.map((nodeId) => ({
            kind: "board-node" as const,
            boardId: id,
            id: nodeId,
          })),
          ...changed.edgeIds.map((edgeId) => ({
            kind: "board-edge" as const,
            boardId: id,
            id: edgeId,
          })),
          ...(changed.slideIds ?? []).map((slideId) => ({
            kind: "board-slide" as const,
            boardId: id,
            id: slideId,
          })),
          ...(changed.slidesStructureChanged ||
          (b.name !== undefined && b.name !== base.name)
            ? [{ kind: "board" as const, id }]
            : []),
        ];
        const dependencies: AgentWorkTarget[] = [];
        for (const edgeId of changed.edgeIds)
          for (const document of [
            base.document,
            b.document,
            current.document,
          ]) {
            const edge = document.edges.find((edge) => edge.id === edgeId);
            for (const nodeId of [edge?.source, edge?.target])
              if (nodeId)
                dependencies.push({
                  kind: "board-node",
                  boardId: id,
                  id: nodeId,
                });
          }
        this.store.work.write(targets, dependencies);
        if (
          merged.conflicts.length ||
          (b.name !== undefined &&
            b.name !== base.name &&
            current.name !== base.name &&
            current.name !== b.name)
        )
          throw problem(
            409,
            "Затронутый объект доски изменён. Прочитайте его заново",
            "REVISION_CONFLICT",
          );
        const document = boardDocumentSchema.parse({
          ...merged.document,
          nodes: merged.document.nodes.map((node) => {
            const old = current.document.nodes.find((n) => n.id === node.id);
            return old && !boardValuesEqual(old.data.source, node.data.source)
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
        });
        checkBoardSize(document);
        const nextName =
          b.name !== undefined && b.name !== base.name ? b.name : current.name;
        const row = this.db.query(
          "UPDATE boards SET name=?2,document=?3,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?1 AND revision=?4 RETURNING *",
          [id, nextName, document, current.revision],
        ).rows[0];
        if (!row) throw problem(409, "Доска изменена", "REVISION_CONFLICT");
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
      const current = this.board(id);
      this.store.work.write([
        { kind: "board", id },
        ...(current.document.slides ?? []).map((slide) => ({
          kind: "board-slide" as const,
          boardId: id,
          id: slide.id,
        })),
        ...current.document.nodes.map((node) => ({
          kind: "board-node" as const,
          boardId: id,
          id: node.id,
        })),
        ...current.document.edges.map((edge) => ({
          kind: "board-edge" as const,
          boardId: id,
          id: edge.id,
        })),
      ]);
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
      const base = this.boardAtRevision(id, b.baseRevision);
      const document = structuredClone(base.document);
      const slides = () => {
        if (!document.slides)
          throw problem(
            400,
            "Операции со слайдами доступны только в презентациях",
          );
        return document.slides;
      };
      for (const op of b.operations) {
        const key = typeof op.id === "string" ? op.id : "";
        switch (op.type) {
          case "add_slide": {
            const list = slides();
            const slide = presentationSlideSchema.parse(op.slide);
            if (list.some((item) => item.id === slide.id))
              throw problem(400, "Слайд с таким id уже существует");
            list.push(slide);
            break;
          }
          case "update_slide": {
            const slide = slides().find((item) => item.id === key);
            if (!slide) throw problem(404, "Слайд не найден");
            const patch = presentationSlideSchema
              .omit({ id: true })
              .partial()
              .parse(op.patch);
            Object.assign(slide, patch);
            break;
          }
          case "remove_slide": {
            const existing = slides();
            if (!existing.some((item) => item.id === key))
              throw problem(404, "Слайд не найден");
            document.slides = existing.filter((item) => item.id !== key);
            document.nodes = document.nodes.filter(
              (node) => node.slideId !== key,
            );
            document.edges = document.edges.filter(
              (edge) => edge.slideId !== key,
            );
            break;
          }
          case "reorder_slides": {
            const existing = new Map(
              slides().map((slide) => [slide.id, slide]),
            );
            const order = z
              .array(slideId)
              .max(PRESENTATION_MAX_SLIDES)
              .parse(op.slideIds);
            if (
              order.length !== existing.size ||
              new Set(order).size !== order.length ||
              order.some((id) => !existing.has(id))
            )
              throw problem(400, "Укажите каждый слайд ровно один раз");
            document.slides = order.map((id) => existing.get(id)!);
            break;
          }
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
            const patch = z
              .object({
                label: z.string().max(500).optional(),
                labelPosition: z
                  .number()
                  .finite()
                  .min(0)
                  .max(1)
                  .nullable()
                  .optional(),
                appearance: boardEdgeAppearanceSchema.optional(),
                source: z.string().min(1).max(200).nullable().optional(),
                target: z.string().min(1).max(200).nullable().optional(),
                sourcePoint: boardEdgePointSchema.nullable().optional(),
                targetPoint: boardEdgePointSchema.nullable().optional(),
                bend: boardEdgePointSchema.nullable().optional(),
                sourceHandle: z
                  .enum(["top", "right", "bottom", "left"])
                  .nullable()
                  .optional(),
                targetHandle: z
                  .enum(["top", "right", "bottom", "left"])
                  .nullable()
                  .optional(),
              })
              .strict()
              .parse(op.patch);
            // Null clears optional geometry fields. The complete document
            // validates both ends before any write commits.
            Object.assign(
              edge,
              Object.fromEntries(
                Object.entries(patch).map(([key, value]) => [
                  key,
                  value === null ? undefined : value,
                ]),
              ),
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
