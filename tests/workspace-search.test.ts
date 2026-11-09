import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database, migrate } from "../src/server/db";
import { ProjectStore } from "../src/server/project-store";
import { SecretBox } from "../src/server/secrets";
import { scanProjectTextFiles } from "../src/server/project-files";
import {
  registerWorkspaceSearchRoutes,
  searchWorkspace,
} from "../src/server/workspace-search";
import {
  findRelevantMatch,
  prepareSearchQuery,
} from "../src/server/search-relevance";
import {
  findSearchMatch,
  resolveSearchMatch,
  searchSnippet,
} from "../src/shared/workspace-search";
import { MAX_PROJECT_FILE_BYTES } from "../src/shared/project-files";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

let root: string;
let store: ProjectStore;
let db: Database;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "miracle-search-")));
  const dataDir = join(root, "private-data");
  db = new Database(dataDir);
  migrate(db, () => {});
  store = new ProjectStore(db, new SecretBox(Buffer.alloc(32, 1)), {
    projectRoot: root,
    dataDir,
    workspaceId: randomUUID(),
    instanceId: randomUUID(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.opendir).mockReset();
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const file = (path: string, content: string | Buffer) => {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
};
const board = (name: string, document: unknown) => {
  const id = randomUUID();
  db.query("INSERT INTO boards(id,name,document) VALUES(?1,?2,?3)", [
    id,
    name,
    document,
  ]);
  return id;
};
const items = async (query: string) =>
  (await searchWorkspace(store, query)).groups.flatMap((group) => group.items);

it("searches saved documents in all groups and returns addressable content fragments", async () => {
  const boardId = board("Магазин", {
    schemaVersion: 1,
    nodes: [
      {
        id: "note",
        data: {
          kind: "note",
          title: "Заметка",
          text: "Чистая выручка за месяц",
        },
      },
    ],
    edges: [],
  });
  const deckId = board("Отчёт", {
    schemaVersion: 1,
    kind: "presentation",
    slides: [{ id: "slide", title: "Выручка", background: "white" }],
    nodes: [],
    edges: [],
  });
  const queryId = randomUUID();
  db.query("INSERT INTO queries(id,name,source) VALUES(?1,?2,?3)", [
    queryId,
    "Месяцы",
    { connectionId: randomUUID(), sql: "SELECT 'Выручка';" },
  ]);
  file("sql/summary.sql", "SELECT 'выручка' AS metric");
  file("docs/README.md", "# Выручка\nОписание");
  file("notes.txt", "Выручка магазина");
  const response = await searchWorkspace(store, "ВЫРУЧКА");
  expect(response.incomplete).toBe(false);
  expect(response.groups.map((group) => [group.type, group.total])).toEqual([
    ["boards", 1],
    ["presentations", 1],
    ["sql", 2],
    ["markdown", 1],
    ["files", 1],
  ]);
  const results = response.groups.flatMap((group) => group.items);
  expect(
    results.find((item) => item.key === `board:${boardId}`)?.target,
  ).toMatchObject({
    kind: "board",
    nodeId: "note",
    field: "node.text",
    match: { start: 7, text: "выручка" },
  });
  expect(
    results.find((item) => item.key === `presentation:${deckId}`)?.target,
  ).toMatchObject({ slideId: "slide", field: "slide.title" });
  expect(
    results.find((item) => item.key === `query:${queryId}`)?.target,
  ).toMatchObject({ kind: "query", match: { start: 8, end: 15 } });
  expect(
    results.find((item) => item.key === "file:docs/README.md")?.target,
  ).toMatchObject({
    kind: "file",
    revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    match: { text: "Выручка" },
  });
});

it("ranks names and paths first, deduplicates documents and counts past the result cap", async () => {
  for (let n = 0; n < 44; n++)
    file(`notes/${String(n).padStart(2, "0")}.txt`, "target target target");
  file("target.txt", "unrelated");
  file("target/location.txt", "also unrelated");
  const response = await searchWorkspace(store, "target");
  const group = response.groups.find((group) => group.type === "files")!;
  expect(group.total).toBe(46);
  expect(group.items).toHaveLength(20);
  expect(group.items.slice(0, 2).map((item) => item.title)).toEqual([
    "target.txt",
    "location.txt",
  ]);
  expect(group.items[0].target.match).toBeUndefined();
  expect(response.incomplete).toBe(false);
});

it("ranks meaningful word coverage above partial titles regardless of word order", async () => {
  const empty = { schemaVersion: 1, nodes: [], edges: [] };
  board("Выручка за месяц", empty);
  board("Выручка год", empty);
  board("Год: выручка", empty);
  board("Выручка за год", empty);
  board("Затраты за период", empty);

  const matches = await items("Выручка за год");
  expect(matches.map((item) => item.title)).toHaveLength(4);
  expect(matches[0].title).toBe("Выручка за год");
  expect(matches.at(-1)?.title).toBe("Выручка за месяц");
  expect(matches.map((item) => item.title)).toEqual(
    expect.arrayContaining(["Выручка год", "Год: выручка"]),
  );

  const reordered = await items("ГОД выручка");
  expect(reordered.map((item) => item.key).sort()).toEqual(
    matches.map((item) => item.key).sort(),
  );
  expect(reordered.at(-1)?.title).toBe("Выручка за месяц");
});

it("ranks full path and content matches above partial names while retaining field priority", async () => {
  const queryId = randomUUID();
  db.query("INSERT INTO queries(id,name,source) VALUES(?1,?2,?3)", [
    queryId,
    "Выручка год",
    { connectionId: randomUUID(), sql: "SELECT 1;" },
  ]);
  file("Выручка за месяц.sql", "SELECT 1;");
  file("год/выручка.sql", "SELECT 1;");
  const text = "SELECT 'Выручка год' AS metric;";
  file("summary.sql", text);
  file("costs.sql", "SELECT 'Затраты за период';");

  const matches = await items("Выручка за год");
  expect(matches.map((item) => item.key)).toEqual([
    `query:${queryId}`,
    "file:год/выручка.sql",
    "file:summary.sql",
    "file:Выручка за месяц.sql",
  ]);
  const match = matches[2].target.match!;
  expect(text.slice(match.start, match.end)).toBe(match.text);
  expect(resolveSearchMatch(text, match)).toEqual({
    start: match.start,
    end: match.end,
  });
});

it("matches Russian word endings while ranking the requested period higher", async () => {
  const empty = { schemaVersion: 1, nodes: [], edges: [] };
  board("Выручка за месяц", empty);
  board("Выручка за год", empty);
  board("Затраты за период", empty);

  expect((await items("выручки за год")).map((item) => item.title)).toEqual([
    "Выручка за год",
    "Выручка за месяц",
  ]);
});

it.each(["board", "presentation"] as const)(
  "finds the best later content block in a %s and retains a valid navigation anchor",
  async (kind) => {
    const fullText = "😀 Год: выручка составила 120 000 рублей.";
    const id = board("Выручка за месяц", {
      schemaVersion: 1,
      ...(kind === "presentation"
        ? {
            kind,
            slides: [
              { id: "first", title: "Введение", background: "white" },
              { id: "second", title: "Итоги", background: "white" },
            ],
          }
        : {}),
      nodes: [
        {
          id: "partial",
          slideId: "first",
          data: { kind: "note", title: "Заметка", text: "Выручка за месяц" },
        },
        {
          id: "best",
          slideId: "second",
          data: { kind: "note", title: "Итоги", text: fullText },
        },
      ],
      edges: [],
    });

    const matches = await items("Выручка за год");
    expect(matches).toHaveLength(1);
    const result = matches[0];
    expect(result.target).toMatchObject({
      kind,
      id,
      nodeId: "best",
      slideId: "second",
      field: "node.text",
    });
    const match = result.target.match!;
    expect(fullText.slice(match.start, match.end)).toBe(match.text);
    expect(resolveSearchMatch(fullText, match)).toEqual({
      start: match.start,
      end: match.end,
    });
    expect(
      result.snippet!.text.slice(result.snippet!.start, result.snippet!.end),
    ).toBe(match.text);
  },
);

it("extracts meaningful canvas labels and SQL without searching settings or custom code", async () => {
  const base = {
    schemaVersion: 1,
    nodes: [
      {
        id: "chart",
        data: {
          kind: "result",
          title: "Chart",
          source: { sql: "SELECT special_sql" },
          chart: { xLabel: "Axis phrase", yLabel: "Vertical label" },
          customChart: {
            description: "Chart description",
            javascript: "hidden_secret",
            css: "hidden_secret",
          },
          resultSetId: "hidden_secret",
        },
      },
    ],
    edges: [{ id: "edge", label: "Relationship phrase" }],
    viewport: { x: 987654321, y: 0, zoom: 1 },
  };
  board("Canvas", base);
  for (const [needle, field] of [
    ["special_sql", "node.source.sql"],
    ["Axis phrase", "node.chart.xLabel"],
    ["Chart description", "node.customChart.description"],
    ["Relationship phrase", "edge.label"],
  ]) {
    expect((await items(needle))[0].target).toMatchObject({ field });
  }
  expect(await items("hidden_secret")).toEqual([]);
  expect(await items("987654321")).toEqual([]);
});

it("does not expose internal, linked, binary, invalid UTF8 or oversized files", async () => {
  for (const directory of [
    ".git",
    ".miracle",
    ".codegraph",
    "node_modules",
    "private-data",
  ])
    file(`${directory}/needle.txt`, "needle");
  file("binary.dat", Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  file("encoding.txt", Buffer.from([255, 110, 101, 101, 100, 108, 101]));
  file("large.txt", "needle" + "x".repeat(MAX_PROJECT_FILE_BYTES));
  const outside = join(tmpdir(), `miracle-outside-${randomUUID()}.txt`);
  writeFileSync(outside, "needle");
  try {
    symlinkSync(outside, join(root, "needle-link.txt"));
    file("plain.txt", "needle");
    symlinkSync(join(root, "plain.txt"), join(root, "internal-link.txt"));
    const response = await searchWorkspace(store, "needle");
    expect(
      response.groups.flatMap((group) => group.items).map((item) => item.key),
    ).toEqual(["file:plain.txt"]);
    expect(response.incomplete).toBe(false);
  } finally {
    rmSync(outside, { force: true });
  }
});

it("reports incomplete I/O separately from empty results", async () => {
  file("blocked/readme.md", "needle");
  const original = (await vi.importActual<typeof fs>("node:fs/promises"))
    .opendir;
  vi.mocked(fs.opendir).mockImplementation(((
    path: string,
    ...args: unknown[]
  ) => {
    if (String(path).endsWith("blocked"))
      return Promise.reject(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );
    return (original as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.opendir);
  const response = await searchWorkspace(store, "needle");
  expect(response.incomplete).toBe(true);
  expect(response.groups.every((group) => group.total === 0)).toBe(true);
});

it("cancels an active filesystem scan and skips scanning empty input", async () => {
  for (let n = 0; n < 30; n++) file(`${n}.txt`, "needle");
  const controller = new AbortController();
  let visited = 0;
  await expect(
    scanProjectTextFiles(
      store.context,
      () => {
        visited++;
        controller.abort();
      },
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(visited).toBeLessThanOrEqual(4);
  expect(
    (await searchWorkspace(store, "  ")).groups.every(
      (group) => group.total === 0,
    ),
  ).toBe(true);
  await expect(
    searchWorkspace(store, "needle", controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("registers an authenticated validated search endpoint", async () => {
  file("report.md", "needle");
  const app = Fastify();
  const need = vi.fn();
  registerWorkspaceSearchRoutes(app, store, need);
  try {
    const response = await app.inject({ url: "/api/search?q=needle" });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .groups.find((group: { type: string }) => group.type === "markdown")
        .total,
    ).toBe(1);
    expect(need).toHaveBeenCalledOnce();
    const invalid = await app.inject({
      url: `/api/search?q=${"x".repeat(201)}`,
    });
    expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
  } finally {
    await app.close();
  }
});

describe("text anchors", () => {
  it("keeps a prefix match and its snippet bounded inside a very long token", () => {
    const text = "выручка".repeat(100_000);
    const found = findRelevantMatch(text, prepareSearchQuery("выручка год"))!;
    expect(found.coverage).toBe(1);
    expect(found.match.text).toBe("выручка");
    expect(text.slice(found.match.start, found.match.end)).toBe(
      found.match.text,
    );
    const snippet = searchSnippet(text, found.match);
    expect(snippet.text.length).toBeLessThan(200);
    expect(snippet.text.slice(snippet.start, snippet.end)).toBe("выручка");
  });

  it("returns original UTF16 offsets after canonical composition and expanding case folding", () => {
    const text = "😀 I\u0307 и Cafe\u0301 — ВЫРУЧКА";
    for (const query of ["café", "выручка", "İ"]) {
      const match = findSearchMatch(text, query)!;
      expect(text.slice(match.start, match.end)).toBe(match.text);
      expect(resolveSearchMatch(text, match)).toEqual({
        start: match.start,
        end: match.end,
      });
      const snippet = searchSnippet(text, match);
      expect(snippet.text.slice(snippet.start, snippet.end)).toBe(match.text);
    }
    expect(findSearchMatch(text, "missing")).toBeUndefined();
  });
  it("reanchors shifted matches and refuses ambiguous or deleted text", () => {
    const match = findSearchMatch("Original target phrase", "target")!;
    expect(
      resolveSearchMatch("new line\nOriginal target phrase", match),
    ).toEqual({ start: match.start + 9, end: match.end + 9 });
    expect(resolveSearchMatch("modified target surrounding", match)).toEqual({
      start: 9,
      end: 15,
    });
    expect(resolveSearchMatch("target target", match)).toBeUndefined();
    expect(resolveSearchMatch("deleted", match)).toBeUndefined();
  });
});
