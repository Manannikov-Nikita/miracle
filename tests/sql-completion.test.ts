import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMetadataStore,
  type MetadataStore,
} from "../src/client/metadata-store";
import type { SchemaTable, SqlFunctionCatalog } from "../src/shared/types";
import {
  createSqlMetadataLoader,
  referencedSqlTables,
  sqlSuggestions,
} from "../src/client/sql-completion";

const tables: SchemaTable[] = [
  {
    schema: "demo",
    name: "sales",
    columns: [{ name: "amount", type: "Float64" }],
  },
  {
    schema: "other",
    name: "sales",
    columns: [{ name: "private_value", type: "String" }],
  },
  {
    schema: "demo",
    name: "customers",
    columns: [{ name: "customer_id", type: "UInt64" }],
  },
];

describe("SQL suggestions", () => {
  it("offers SQL keywords without a connection or metadata", () => {
    expect(sqlSuggestions("SEL", "SEL", [])).toContainEqual({
      label: "SELECT",
      insertText: "SELECT",
      kind: "keyword",
    });
  });
  it("inserts only the remaining table name after a schema qualifier", () => {
    const suggestions = sqlSuggestions(
      "SELECT * FROM demo.sa",
      "SELECT * FROM demo.sa",
      tables,
    );
    expect(suggestions.find((item) => item.label === "sales")).toMatchObject({
      insertText: "sales",
      kind: "table",
    });
    expect(suggestions.filter((item) => item.label === "sales")).toHaveLength(
      1,
    );
  });
  it("offers columns for an alias and uses the active database to resolve duplicate table names", () => {
    const sql = "SELECT s.am FROM sales AS s";
    const suggestions = sqlSuggestions(sql, "SELECT s.am", tables, {
      database: "demo",
    });
    expect(suggestions.map((item) => item.label)).toEqual(["amount"]);
  });
  it("resolves fully qualified Trino tables and completes schema names after a catalog", () => {
    const metadata: SchemaTable[] = [
      {
        catalog: "tpch",
        schema: "tiny",
        name: "orders",
        columns: [{ name: "orderkey", type: "bigint" }],
      },
    ];
    expect(
      sqlSuggestions(
        "SELECT o. FROM tpch.tiny.orders o",
        "SELECT o.",
        metadata,
      ),
    ).toContainEqual(
      expect.objectContaining({ label: "orderkey", insertText: "orderkey" }),
    );
    expect(
      sqlSuggestions("SELECT * FROM tpch.", "SELECT * FROM tpch.", metadata),
    ).toContainEqual({ label: "tiny", insertText: "tiny", kind: "schema" });
  });
  it("finds adjacent FROM/JOIN references without treating clause keywords as aliases", () => {
    expect(
      referencedSqlTables(
        "SELECT * FROM demo.sales JOIN demo.customers ON 1 = 1",
        tables,
      ).map((table) => table.name),
    ).toEqual(["sales", "customers"]);
  });
  it("ignores table references in comments and string literals", () => {
    expect(
      referencedSqlTables(
        "SELECT 'FROM other.sales' FROM demo.sales -- JOIN demo.customers\n/* FROM other.sales */",
        tables,
      ),
    ).toEqual([tables[0]]);
  });
  it("quotes identifiers that cannot be inserted as bare SQL names", () => {
    const metadata: SchemaTable[] = [
      {
        schema: "demo",
        name: "sales log",
        columns: [{ name: "order total", type: "Float64" }],
      },
    ];
    expect(
      sqlSuggestions("SELECT * FROM demo.", "SELECT * FROM demo.", metadata),
    ).toContainEqual(expect.objectContaining({ insertText: '"sales log"' }));
    expect(
      sqlSuggestions(
        'SELECT s. FROM demo."sales log" s',
        "SELECT s.",
        metadata,
      ),
    ).toContainEqual(expect.objectContaining({ insertText: '"order total"' }));
  });
});

describe("lazy schema suggestions", () => {
  it("suggests an unopened or empty schema before any table is available", () => {
    expect(
      sqlSuggestions(
        "SELECT * FROM lake.",
        "SELECT * FROM lake.",
        [],
        {},
        undefined,
        {
          schemas: [{ catalog: "lake", schema: "analytics" }],
        },
      ),
    ).toContainEqual({
      label: "analytics",
      insertText: "analytics",
      kind: "schema",
    });
  });
  it("filters a large schema by the typed prefix before bounding suggestions", () => {
    const metadata = Array.from({ length: 4000 }, (_, index) => ({
      schema: "large",
      name: `table_${String(index).padStart(4, "0")}`,
    }));
    const sql = "SELECT * FROM large.table_39";
    const suggestions = sqlSuggestions(sql, sql, metadata, {}, undefined, {
      prefix: "table_39",
      limit: 200,
    });
    expect(suggestions).toHaveLength(100);
    expect(suggestions[0].label).toBe("table_3900");
    expect(suggestions[99].label).toBe("table_3999");
    expect(
      sqlSuggestions(
        "SELECT * FROM large.",
        "SELECT * FROM large.",
        metadata,
        {},
        undefined,
        { prefix: "", limit: 200 },
      ),
    ).toHaveLength(200);
  });
  it("matches a schema prefix without requiring the catalog prefix", () => {
    const sql = "SELECT * FROM anal";
    expect(
      sqlSuggestions(sql, sql, [], {}, undefined, {
        schemas: [{ catalog: "lake", schema: "analytics" }],
        prefix: "anal",
        limit: 200,
      }),
    ).toContainEqual({
      label: "lake.analytics",
      insertText: "lake.analytics",
      kind: "schema",
    });
  });
  it("keeps schemas and SQL keywords when hundreds of tables share their prefix", () => {
    const metadata = Array.from({ length: 500 }, (_, index) => ({
      schema: "select_schema",
      name: `select_table_${index}`,
    }));
    const sql = "SELECT sel";
    const suggestions = sqlSuggestions(sql, sql, metadata, {}, undefined, {
      schemas: [{ schema: "select_schema" }],
      prefix: "sel",
      limit: 200,
    });
    expect(suggestions).toHaveLength(200);
    expect(suggestions).toContainEqual(
      expect.objectContaining({ label: "SELECT", kind: "keyword" }),
    );
    expect(suggestions).toContainEqual(
      expect.objectContaining({ label: "select_schema", kind: "schema" }),
    );
    expect(suggestions.some((suggestion) => suggestion.kind === "table")).toBe(
      true,
    );
  });
  it("keeps ClickHouse function completions beside a large set of matching tables", () => {
    const metadata = Array.from({ length: 500 }, (_, index) => ({
      schema: "summary",
      name: `sum_table_${index}`,
    }));
    const sql = "SELECT sum";
    const suggestions = sqlSuggestions(
      sql,
      sql,
      metadata,
      { engine: "clickhouse" },
      undefined,
      {
        schemas: [{ schema: "summary" }],
        prefix: "sum",
        limit: 200,
      },
    );
    expect(suggestions).toHaveLength(200);
    expect(suggestions).toContainEqual(
      expect.objectContaining({ label: "sum", kind: "function" }),
    );
    expect(suggestions).toContainEqual(
      expect.objectContaining({ label: "summary", kind: "schema" }),
    );
    expect(suggestions.some((suggestion) => suggestion.kind === "table")).toBe(
      true,
    );
  });
});

const metadataStores: MetadataStore[] = [];
function completionLoader(request: <T>(path: string) => Promise<T>) {
  const store = createMetadataStore(request);
  metadataStores.push(store);
  return { store, loader: createSqlMetadataLoader(store) };
}
afterEach(() => {
  for (const store of metadataStores.splice(0)) store.dispose();
});

function metadataRequest(
  paths: string[],
  columnFor = (id: string) => "amount",
) {
  return async <T>(path: string): Promise<T> => {
    paths.push(path);
    const url = new URL(path, "http://local");
    const id = url.pathname.split("/")[3];
    const schema = url.searchParams.get("schema") || "demo";
    const catalog = url.searchParams.get("catalog") || undefined;
    if (url.pathname.endsWith("/metadata/schemas"))
      return { items: [{ schema: "demo" }, { schema: "archive" }] } as T;
    if (url.pathname.endsWith("/metadata/tables"))
      return {
        items: [
          { schema, catalog, name: url.searchParams.get("table") || "sales" },
        ],
      } as T;
    if (url.pathname.endsWith("/metadata/columns"))
      return {
        items: [
          { table: "sales", name: columnFor(id), type: "Float64", position: 1 },
        ],
      } as T;
    throw new Error(`Unexpected metadata endpoint: ${path}`);
  };
}

describe("shared lazy completion metadata", () => {
  it.each([
    ["SELECT * FROM archive.existing", "SELECT * FROM archive.exi"],
    [
      'SELECT * FROM "archive"."sales table"',
      'SELECT * FROM "archive"."sales ta',
    ],
    [
      "SELECT 'FROM ignored.table' /* JOIN ignored.more */ FROM archive.existing",
      "SELECT 'FROM ignored.table' /* JOIN ignored.more */ FROM archive.exi",
    ],
  ])(
    "skips exact lookups while the cursor edits a relation identifier in %s",
    async (sql, beforeCursor) => {
      const paths: string[] = [];
      const { loader } = completionLoader(metadataRequest(paths));
      await loader.tables("conn-a", sql, {}, beforeCursor);
      expect(
        paths.some(
          (path) =>
            path.includes("/metadata/tables?") &&
            new URL(path, "http://local").searchParams.has("table"),
        ),
      ).toBe(false);
      expect(
        paths.some(
          (path) =>
            path.includes("/metadata/tables?") &&
            path.includes("schema=archive"),
        ),
      ).toBe(true);
    },
  );
  it("looks up a completed relation after the cursor passes its trailing space", async () => {
    const paths: string[] = [];
    const { loader } = completionLoader(metadataRequest(paths));
    await loader.tables("conn-a", "SELECT * FROM archive.sales ");
    expect(
      paths.some(
        (path) =>
          path.includes("/metadata/tables?") && path.includes("table=sales"),
      ),
    ).toBe(true);
  });
  it("does not queue obsolete exact lookups while typing FROM or JOIN before useful alias columns", async () => {
    const paths: string[] = [];
    const releases: (() => void)[] = [];
    let releaseSlowRequests = false;
    const { loader, store } = completionLoader(async <T>(path: string) => {
      paths.push(path);
      const url = new URL(path, "http://local");
      const table = url.searchParams.get("table");
      if (url.pathname.endsWith("/metadata/schemas"))
        return { items: [{ schema: "demo" }] } as T;
      if (url.pathname.endsWith("/metadata/tables")) {
        if (table && table !== "sales") {
          if (!releaseSlowRequests)
            await new Promise<void>((resolve) => releases.push(resolve));
          return { items: [] } as T;
        }
        return { items: [{ schema: "demo", name: "sales" }] } as T;
      }
      if (url.pathname.endsWith("/metadata/columns")) {
        if (!table && !releaseSlowRequests)
          await new Promise<void>((resolve) => releases.push(resolve));
        return {
          items: [
            { table: "sales", name: "amount", type: "Float64", position: 1 },
          ],
        } as T;
      }
      throw new Error(path);
    });
    await store.loadTable("conn-a", { schema: "demo", name: "sales" });
    const requests = [
      "e",
      "ex",
      "exi",
      "exis",
      "exist",
      "existi",
      "existing",
    ].map((prefix, index) =>
      loader.tables(
        "conn-a",
        index % 2
          ? `SELECT * FROM demo.sales s JOIN demo.${prefix}`
          : `SELECT * FROM demo.${prefix}`,
      ),
    );
    const useful = loader.tables(
      "conn-a",
      "SELECT s.am FROM demo.sales s",
      {},
      "SELECT s.am",
    );
    try {
      await vi.waitFor(
        () =>
          expect(store.getTables("conn-a")[0]?.columns?.[0].name).toBe(
            "amount",
          ),
        { timeout: 500 },
      );
      expect(paths.some((path) => /[?&]table=e[^&]*(?:&|$)/.test(path))).toBe(
        false,
      );
    } finally {
      releaseSlowRequests = true;
      for (const release of releases) release();
      await Promise.allSettled([...requests, useful]);
    }
  });
  it("does not invent a table from a partially typed FROM reference", async () => {
    const paths: string[] = [];
    const request = metadataRequest(paths);
    const { loader, store } = completionLoader(async <T>(path: string) => {
      if (path.includes("/metadata/tables?") && path.includes("table=sal")) {
        paths.push(path);
        return { items: [] } as T;
      }
      return request<T>(path);
    });
    await loader.tables("conn-a", "SELECT * FROM demo.sal");
    expect(
      store.getTables("conn-a").some((table) => table.name === "sal"),
    ).toBe(false);
    expect(
      paths.some(
        (path) =>
          path.includes("/metadata/columns?") &&
          /[?&]table=sal(?:&|$)/.test(path),
      ),
    ).toBe(false);
    expect(paths.some((path) => /[?&]table=sal(?:&|$)/.test(path))).toBe(false);
  });
  it("resolves unopened qualified tables without the legacy whole-source schema endpoint", async () => {
    const paths: string[] = [];
    const { loader } = completionLoader(metadataRequest(paths));
    const metadata = await loader.tables(
      "conn-a",
      "SELECT s. FROM archive.sales s",
      {},
      "SELECT s.",
    );
    expect(
      sqlSuggestions("SELECT s. FROM archive.sales s", "SELECT s.", metadata),
    ).toContainEqual(
      expect.objectContaining({ label: "amount", kind: "column" }),
    );
    expect(paths.some((path) => path.endsWith("/schema"))).toBe(false);
    expect(
      paths.some(
        (path) =>
          path.includes("/metadata/tables?") && path.includes("schema=archive"),
      ),
    ).toBe(true);
  });
  it("retains and isolates cached columns while switching sources", async () => {
    const paths: string[] = [];
    const { loader, store } = completionLoader(
      metadataRequest(paths, (id) =>
        id === "conn-a" ? "a_column" : "b_column",
      ),
    );
    const first = await loader.tables("conn-a", "SELECT * FROM sales", {
      database: "demo",
    });
    const second = await loader.tables("conn-b", "SELECT * FROM sales", {
      database: "demo",
    });
    expect(
      first.find((table) => table.schema === "demo")?.columns?.[0].name,
    ).toBe("a_column");
    expect(
      second.find((table) => table.schema === "demo")?.columns?.[0].name,
    ).toBe("b_column");
    const before = paths.filter((path) => path.includes("table=sales")).length;
    await loader.tables("conn-a", "SELECT * FROM sales", { database: "demo" });
    expect(paths.filter((path) => path.includes("table=sales"))).toHaveLength(
      before,
    );
    expect(
      store.getTables("conn-b").find((table) => table.schema === "demo")
        ?.columns?.[0].name,
    ).toBe("b_column");
  });
  it("loads columns for a typed table qualifier before a FROM clause exists", async () => {
    const paths: string[] = [];
    const { loader } = completionLoader(metadataRequest(paths));
    const metadata = await loader.tables("conn-a", "SELECT demo.sales.");
    expect(
      sqlSuggestions("SELECT demo.sales.", "SELECT demo.sales.", metadata),
    ).toContainEqual(
      expect.objectContaining({ label: "amount", kind: "column" }),
    );
  });
  it("prioritizes the fully qualified Trino table from the SQL tab context", async () => {
    const paths: string[] = [];
    const { loader } = completionLoader(metadataRequest(paths));
    const metadata = await loader.tables(
      "conn-a",
      "SELECT s. FROM lake.archive.sales s",
      { engine: "trino", catalog: "other", schema: "public" },
      "SELECT s.",
    );
    expect(
      metadata.find(
        (table) => table.catalog === "lake" && table.schema === "archive",
      )?.columns?.[0].name,
    ).toBe("amount");
    expect(
      paths.some(
        (path) =>
          path.includes("catalog=lake") && path.includes("schema=archive"),
      ),
    ).toBe(true);
  });
});

describe("ClickHouse SQL completion", () => {
  const ch = { engine: "clickhouse" as const };
  const names = (sql: string, catalog?: SqlFunctionCatalog) =>
    sqlSuggestions(sql, sql, [], ch, catalog).map((item) => item.label);

  it("offers ClickHouse array, distinct, date and aggregate functions with documentation", () => {
    const suggestions = sqlSuggestions("SELECT array", "SELECT array", [], ch);
    for (const name of [
      "arrayMap",
      "arrayFilter",
      "arrayJoin",
      "arrayReduce",
      "arrayZip",
      "uniq",
      "uniqExact",
      "uniqCombined64",
      "toStartOfMonth",
      "argMax",
      "groupArray",
    ]) {
      expect(suggestions.find((item) => item.label === name)).toMatchObject({
        insertText: name,
        kind: "function",
        documentation: expect.any(String),
      });
    }
  });
  it("keeps ClickHouse keywords and functions out of Trino and unspecified dialects", () => {
    for (const context of [{}, { engine: "trino" as const }]) {
      const suggestions = sqlSuggestions(
        "SELECT uniq",
        "SELECT uniq",
        [],
        context,
      );
      expect(
        suggestions.some((item) =>
          [
            "uniq",
            "arrayMap",
            "ARRAY JOIN",
            "PREWHERE",
            "FINAL",
            "LIMIT BY",
          ].includes(item.label),
        ),
      ).toBe(false);
    }
    for (const keyword of [
      "ARRAY JOIN",
      "LEFT ARRAY JOIN",
      "PREWHERE",
      "FINAL",
      "LIMIT BY",
      "SETTINGS",
      "FORMAT",
    ]) {
      expect(names("SELECT ")).toContain(keyword);
    }
  });
  it.each([
    ["SELECT * FROM demo.sales ARRAY ", "ARRAY JOIN", "JOIN"],
    ["SELECT * FROM demo.sales ARRAY J", "ARRAY JOIN", "JOIN"],
    ["SELECT * FROM demo.sales LEFT ARRAY ", "LEFT ARRAY JOIN", "JOIN"],
    ["SELECT * FROM demo.sales LEFT AR", "LEFT ARRAY JOIN", "ARRAY JOIN"],
    ["SELECT * FROM demo.sales LIMIT ", "LIMIT BY", "BY"],
  ])(
    "inserts a remaining keyword phrase after %s",
    (sql, label, insertText) => {
      expect(sqlSuggestions(sql, sql, tables, ch)).toContainEqual(
        expect.objectContaining({ label, insertText, filterText: insertText }),
      );
    },
  );
  it.each([
    ["SELECT * FROM demo.sales ARRAY j", "ARRAY JOIN"],
    ["SELECT * FROM demo.sales LEFT ARRAY j", "LEFT ARRAY JOIN"],
  ])("prioritizes the remaining phrase after %s", (sql, label) => {
    const suggestions = sqlSuggestions(sql, sql, tables, ch);
    const phrase = suggestions.find((item) => item.label === label)!;
    const fn = suggestions.find((item) => item.label === "JSONExtract")!;
    expect(phrase.sortText).toBeDefined();
    expect(phrase.sortText! < (fn.sortText || fn.label)).toBe(true);
    expect(phrase.insertText).toBe("JOIN");
  });
  it.each([
    ["j", "jOIN"],
    ["jo", "joIN"],
    ["JO", "JOIN"],
    ["Jo", "JoIN"],
  ])(
    "matches the typed case of %s when ranking phrase continuations",
    (typed, filterText) => {
      const sql = `SELECT * FROM demo.sales ARRAY ${typed}`;
      expect(
        sqlSuggestions(sql, sql, tables, ch).find(
          (item) => item.label === "ARRAY JOIN",
        ),
      ).toMatchObject({
        insertText: "JOIN",
        filterText,
        sortText: expect.any(String),
      });
    },
  );
  it("keeps default ranking outside a matching unfinished phrase", () => {
    for (const sql of ["SELECT j", "SELECT * FROM demo.sales ARRAY amount"]) {
      const suggestions = sqlSuggestions(sql, sql, tables, ch);
      expect(
        suggestions.find((item) => item.label === "ARRAY JOIN")?.sortText,
      ).toBeUndefined();
      expect(
        suggestions.find((item) => item.label === "JSONExtract")?.sortText,
      ).toBeUndefined();
    }
  });
  it("does not turn ARRAY JOIN into an alias or a table reference", () => {
    const sql = "SELECT ARRAY. FROM demo.sales ARRAY JOIN customers AS item";
    expect(referencedSqlTables(sql, tables, ch)).toEqual([tables[0]]);
    expect(
      sqlSuggestions(sql, "SELECT ARRAY.", tables, ch).some(
        (item) => item.kind === "column",
      ),
    ).toBe(false);
    expect(sqlSuggestions(sql, "SELECT ", tables, ch)).toContainEqual(
      expect.objectContaining({ label: "amount", kind: "column" }),
    );
  });
  it.each([
    "SELECT 'array",
    "SELECT 'escaped\\' array",
    "SELECT 1 -- array",
    "SELECT /* array",
    "SELECT 'array''uniq",
  ])("does not complete inside literals or comments: %s", (sql) => {
    expect(sqlSuggestions(sql, sql, tables, ch)).toEqual([]);
  });
  it("resumes completion after a closed comment or string", () => {
    expect(names("SELECT 'x' /* closed */ array")).toContain("arrayMap");
    expect(names("SELECT 1 -- comment\narray")).toContain("arrayMap");
  });
  it("uses the server function catalog as authority and enriches known function documentation", () => {
    const catalog: SqlFunctionCatalog = {
      functions: [
        { name: "arrayMap", isAggregate: false },
        {
          name: "my_custom",
          isAggregate: false,
          syntax: "my_custom(x)",
          description: "Custom server function",
        },
        { name: "sum", isAggregate: true },
      ],
      aggregateCombinators: ["If"],
    };
    const suggestions = sqlSuggestions(
      "SELECT my",
      "SELECT my",
      [],
      ch,
      catalog,
    );
    expect(
      suggestions.find((item) => item.label === "my_custom"),
    ).toMatchObject({
      documentation: expect.stringContaining("Custom server function"),
    });
    expect(
      suggestions.find((item) => item.label === "arrayMap")?.documentation,
    ).toContain("arrayMap");
    expect(names("SELECT ", catalog)).not.toContain("uniqExact");
    expect(
      names("SELECT ", { functions: [], aggregateCombinators: [] }),
    ).not.toContain("arrayMap");
  });
  it.each([
    ["uniqIf", "uniqIf"],
    ["uniqAr", "uniqArrayIf"],
    ["sumIfS", "sumIfState"],
    ["sumMergeS", "sumMergeState"],
    ["avgOrNullI", "avgOrNullIf"],
  ])("completes valid composed aggregate suffixes for %s", (prefix, wanted) => {
    expect(names(`SELECT ${prefix}`)).toContain(wanted);
  });
  it("respects available combinators and never creates scalar function variants", () => {
    const catalog: SqlFunctionCatalog = {
      functions: [
        { name: "sum", isAggregate: true },
        { name: "arrayMap", isAggregate: false },
      ],
      aggregateCombinators: ["If", "State"],
    };
    expect(names("SELECT sum", catalog)).toContain("sumIfState");
    expect(names("SELECT sum", catalog)).not.toContain("sumArrayIf");
    expect(names("SELECT arrayMapI", catalog)).not.toContain("arrayMapIf");
    expect(names("SELECT sumIfAr")).not.toContain("sumIfArray");
    expect(names("SELECT sumStateI")).not.toContain("sumStateIf");
  });
  it("does not generate unsupported SimpleState or window-function variants", () => {
    const catalog: SqlFunctionCatalog = {
      functions: [
        { name: "sum", isAggregate: true },
        { name: "uniq", isAggregate: true },
        { name: "avg", isAggregate: true },
        { name: "rank", isAggregate: true },
      ],
      aggregateCombinators: ["If", "SimpleState", "State", "Merge"],
    };
    expect(names("SELECT sum", catalog)).toContain("sumSimpleState");
    expect(names("SELECT uniq", catalog)).not.toContain("uniqSimpleState");
    expect(names("SELECT avg", catalog)).not.toContain("avgSimpleState");
    expect(names("SELECT rank", catalog)).not.toContain("rankIf");
    expect(names("SELECT rank", catalog)).toContain("rank");
    expect(
      names("SELECT sumMerge", { ...catalog, aggregateCombinators: ["Merge"] }),
    ).not.toContain("sumMergeState");
  });
  it("preserves distinct case-sensitive function names from the server", () => {
    const catalog: SqlFunctionCatalog = {
      functions: [
        { name: "Custom", isAggregate: false },
        { name: "custom", isAggregate: false },
      ],
      aggregateCombinators: [],
    };
    expect(names("SELECT ", catalog)).toEqual(
      expect.arrayContaining(["Custom", "custom"]),
    );
  });
  it("preserves Trino aliases that coincide with ClickHouse clause names", () => {
    const sql = "SELECT final.am FROM demo.sales final";
    expect(
      sqlSuggestions(sql, "SELECT final.am", tables, { engine: "trino" }),
    ).toEqual([expect.objectContaining({ label: "amount", kind: "column" })]);
  });
  it("uses ClickHouse backslash escapes without changing Trino string boundaries", () => {
    const sql = "SELECT '\\' AS slash, ";
    expect(sqlSuggestions(sql, sql, [], { engine: "trino" })).toContainEqual(
      expect.objectContaining({ label: "SELECT" }),
    );
    expect(sqlSuggestions(sql, sql, [], ch)).toEqual([]);
  });
  it("does not eagerly expand aggregate combinators for a blank or broad prefix", () => {
    expect(names("SELECT ")).not.toContain("sumArrayIfState");
    expect(names("SELECT u")).not.toContain("uniqArrayIfState");
    expect(names("SELECT uniq").length).toBeLessThan(500);
  });
});

describe("function catalog metadata", () => {
  it("shares in-flight and cached catalogs per connection and encodes the endpoint", async () => {
    const paths: string[] = [];
    const request = async <T>(path: string): Promise<T> => {
      paths.push(path);
      return {
        functions: [
          { name: path.includes("a%2Fb") ? "uniq" : "sum", isAggregate: true },
        ],
        aggregateCombinators: ["If"],
      } as T;
    };
    const { loader } = completionLoader(request);
    const [first, second] = await Promise.all([
      loader.functionCatalog("a/b"),
      loader.functionCatalog("a/b"),
    ]);
    expect(first).toBe(second);
    expect(await loader.functionCatalog("a/b")).toBe(first);
    expect((await loader.functionCatalog("other")).functions[0].name).toBe(
      "sum",
    );
    expect(paths).toEqual([
      "/api/connections/a%2Fb/functions",
      "/api/connections/other/functions",
    ]);
  });
  it("removes a failed catalog request so the next completion retries", async () => {
    let attempts = 0;
    const { loader } = completionLoader(async <T>() => {
      if (++attempts === 1) throw new Error("temporary catalog failure");
      return {
        functions: [{ name: "uniq", isAggregate: true }],
        aggregateCombinators: ["If"],
      } as T;
    });
    await expect(loader.functionCatalog("conn")).rejects.toThrow(
      "temporary catalog failure",
    );
    expect((await loader.functionCatalog("conn")).functions[0].name).toBe(
      "uniq",
    );
    expect(attempts).toBe(2);
  });
});
