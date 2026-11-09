import { setImmediate } from "node:timers/promises";
import { extname } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Board, QueryDocument } from "../shared/types.js";
import {
  SEARCH_GROUPS,
  normalizeSearchText,
  searchSnippet,
  type SearchGroupKey,
  type SearchResponse,
  type SearchResult,
  type SearchTarget,
} from "../shared/workspace-search.js";
import { scanProjectTextFiles } from "./project-files.js";
import type { ProjectStore } from "./project-store.js";
import {
  findRelevantMatch,
  prepareSearchQuery,
  type PreparedSearchQuery,
} from "./search-relevance.js";

type CanvasTarget = Extract<SearchTarget, { kind: "board" | "presentation" }>;
type Candidate = SearchResult & {
  rank: number;
  coverage: number;
  phrase: boolean;
};
const LIMIT = 20;

function compareRelevance(a: Candidate, b: Candidate) {
  return (
    b.coverage - a.coverage ||
    Number(b.phrase) - Number(a.phrase) ||
    a.rank - b.rank
  );
}
function bestResult(...candidates: (Candidate | undefined)[]) {
  return candidates.reduce<Candidate | undefined>(
    (best, candidate) =>
      candidate && (!best || compareRelevance(candidate, best) < 0)
        ? candidate
        : best,
    undefined,
  );
}
function nameResult(
  base: SearchResult,
  name: string,
  path: string,
  query: PreparedSearchQuery,
) {
  const title = findRelevantMatch(name, query);
  const location = path ? findRelevantMatch(path, query) : undefined;
  const needle = normalizeSearchText(query.query);
  const folded = normalizeSearchText(name);
  return bestResult(
    title && {
      ...base,
      coverage: title.coverage,
      phrase: title.phrase,
      rank: folded === needle ? 0 : folded.startsWith(needle) ? 1 : 2,
    },
    location && {
      ...base,
      coverage: location.coverage,
      phrase: location.phrase,
      rank: normalizeSearchText(path).startsWith(needle) ? 3 : 4,
    },
  );
}
function textResult(
  base: SearchResult,
  text: string,
  query: PreparedSearchQuery,
): Candidate | undefined {
  const found = findRelevantMatch(text, query);
  return found
    ? {
        ...base,
        rank: 5,
        coverage: found.coverage,
        phrase: found.phrase,
        snippet: searchSnippet(text, found.match),
        target: { ...base.target, match: found.match },
      }
    : undefined;
}
function canvasResult(
  board: Board,
  query: PreparedSearchQuery,
): Candidate | undefined {
  const kind =
    board.document.kind === "presentation" ? "presentation" : "board";
  const target: CanvasTarget = { kind, id: board.id, revision: board.revision };
  const base: SearchResult = {
    key: `${kind}:${board.id}`,
    group: kind === "board" ? "boards" : "presentations",
    title: board.name,
    subtitle: kind === "board" ? "Доска" : "Презентация",
    target,
  };
  let best = nameResult(base, board.name, "", query);
  const candidate = (
    text: string | undefined,
    address: Partial<CanvasTarget>,
  ) =>
    typeof text === "string"
      ? textResult({ ...base, target: { ...target, ...address } }, text, query)
      : undefined;
  for (const slide of board.document.slides ?? []) {
    const found = candidate(slide.title, {
      field: "slide.title",
      slideId: slide.id,
    });
    best = bestResult(best, found);
  }
  for (const node of board.document.nodes) {
    const address = { nodeId: node.id, slideId: node.slideId };
    const fields: [string, string | undefined][] = [
      ["node.title", node.data.title],
      ["node.text", node.data.text],
      ["node.source.sql", node.data.source?.sql],
      ["node.chart.xLabel", node.data.chart?.xLabel],
      ["node.chart.yLabel", node.data.chart?.yLabel],
      ["node.customChart.description", node.data.customChart?.description],
    ];
    for (const [field, text] of fields) {
      const found = candidate(text, { ...address, field });
      best = bestResult(best, found);
    }
  }
  for (const edge of board.document.edges) {
    const found = candidate(edge.label, {
      field: "edge.label",
      edgeId: edge.id,
      slideId: edge.slideId,
    });
    best = bestResult(best, found);
  }
  return best;
}
function queryResult(
  document: QueryDocument,
  query: PreparedSearchQuery,
): Candidate | undefined {
  const base: SearchResult = {
    key: `query:${document.id}`,
    group: "sql",
    title: document.name,
    subtitle: "Сохранённый запрос",
    target: { kind: "query", id: document.id, revision: document.revision },
  };
  return bestResult(
    nameResult(base, document.name, "", query),
    textResult(base, document.sql, query),
  );
}
export async function searchWorkspace(
  store: ProjectStore,
  input: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const query = input.trim();
  const prepared = prepareSearchQuery(query);
  const groups = new Map<SearchGroupKey, { total: number; items: Candidate[] }>(
    SEARCH_GROUPS.map((type) => [type, { total: 0, items: [] }]),
  );
  const compare = (a: Candidate, b: Candidate) =>
    compareRelevance(a, b) ||
    a.title.localeCompare(b.title, "ru") ||
    a.key.localeCompare(b.key);
  const add = (result: Candidate | undefined) => {
    if (!result) return;
    const group = groups.get(result.group)!;
    group.total++;
    group.items.push(result);
    group.items.sort(compare);
    if (group.items.length > LIMIT) group.items.pop();
  };
  const response = (incomplete: boolean): SearchResponse => ({
    query,
    groups: SEARCH_GROUPS.map((type) => ({
      type,
      total: groups.get(type)!.total,
      items: groups
        .get(type)!
        .items.map(({ rank, coverage, phrase, ...result }) => ({
          ...result,
          relevance: coverage * 100 + Number(phrase) * 10 + (5 - rank),
        })),
    })),
    incomplete,
  });
  signal?.throwIfAborted();
  if (!query) return response(false);
  // Small batches keep database content bounded and let a superseding request
  // interrupt the scan. Files and database documents are never indexed together.
  for (const table of ["boards", "queries"] as const) {
    let after = "";
    for (;;) {
      signal?.throwIfAborted();
      const rows = store.db.query(
        `SELECT * FROM ${table} WHERE id>?1 ORDER BY id LIMIT 32`,
        [after],
      ).rows;
      if (!rows.length) break;
      for (const row of rows) {
        signal?.throwIfAborted();
        add(
          table === "boards"
            ? canvasResult(
                {
                  id: row.id,
                  name: row.name,
                  revision: row.revision,
                  document: row.document,
                  updatedAt: row.updated_at,
                },
                prepared,
              )
            : queryResult(
                {
                  id: row.id,
                  name: row.name,
                  revision: row.revision,
                  ...row.source,
                  updatedAt: row.updated_at,
                },
                prepared,
              ),
        );
        after = row.id;
      }
      await setImmediate();
    }
  }
  const scan = await scanProjectTextFiles(
    store.context,
    (file) => {
      const extension = extname(file.path).toLowerCase();
      const group: SearchGroupKey =
        extension === ".sql"
          ? "sql"
          : [".md", ".markdown", ".mdx"].includes(extension)
            ? "markdown"
            : "files";
      const base: SearchResult = {
        key: `file:${file.path}`,
        group,
        title: file.name,
        subtitle: file.path,
        target: { kind: "file", path: file.path, revision: file.revision },
      };
      add(
        bestResult(
          nameResult(base, file.name, file.path, prepared),
          textResult(base, file.content, prepared),
        ),
      );
    },
    signal,
  );
  return response(scan.incomplete);
}

export function registerWorkspaceSearchRoutes(
  app: FastifyInstance,
  store: ProjectStore,
  need: (request: FastifyRequest) => void,
) {
  app.get("/api/search", async (request, reply) => {
    need(request);
    const { q } = z
      .object({ q: z.string().max(200).default("") })
      .parse(request.query);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      return await searchWorkspace(store, q, controller.signal);
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  });
}
