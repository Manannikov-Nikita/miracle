import { describe, expect, it, vi } from "vitest";
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

describe("editor-owned completion metadata", () => {
  it("loads schema and referenced columns without Explorer and deduplicates concurrent completions", async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith("/schema")
        ? [
            { schema: "demo", name: "sales" },
            { schema: "demo", name: "customers" },
          ]
        : [{ name: "amount", type: "Float64" }],
    );
    const loader = createSqlMetadataLoader(
      request as <T>(path: string) => Promise<T>,
    );
    const [first, second] = await Promise.all([
      loader.tables("conn-a", "SELECT s. FROM demo.sales s"),
      loader.tables("conn-a", "SELECT s. FROM demo.sales s"),
    ]);
    expect(first).toBe(second);
    expect(first[0].columns?.[0].name).toBe("amount");
    expect(first[1].columns).toBeUndefined();
    expect(request.mock.calls.map(([path]) => path)).toEqual([
      "/api/connections/conn-a/schema",
      "/api/connections/conn-a/columns?schema=demo&table=sales",
    ]);
  });
  it("keeps identical table names separate across active connections", async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith("/schema")
        ? [{ schema: "demo", name: "sales" }]
        : [
            {
              name: path.includes("conn-a") ? "a_column" : "b_column",
              type: "String",
            },
          ],
    );
    const loader = createSqlMetadataLoader(
      request as <T>(path: string) => Promise<T>,
    );
    const first = await loader.tables("conn-a", "SELECT * FROM sales", {
      database: "demo",
    });
    const second = await loader.tables("conn-b", "SELECT * FROM sales", {
      database: "demo",
    });
    expect(first[0].columns?.[0].name).toBe("a_column");
    expect(second[0].columns?.[0].name).toBe("b_column");
  });
  it("loads columns for a typed table qualifier before a FROM clause exists", async () => {
    const request = vi.fn(async (path: string) =>
      path.endsWith("/schema")
        ? [{ schema: "demo", name: "sales" }]
        : [{ name: "amount", type: "Float64" }],
    );
    const loader = createSqlMetadataLoader(
      request as <T>(path: string) => Promise<T>,
    );
    const metadata = await loader.tables("conn-a", "SELECT demo.sales.");
    expect(
      sqlSuggestions("SELECT demo.sales.", "SELECT demo.sales.", metadata),
    ).toContainEqual(
      expect.objectContaining({ label: "amount", kind: "column" }),
    );
  });
  it("retries failed schema and column requests instead of caching failures", async () => {
    let schemaCalls = 0;
    let columnCalls = 0;
    const request = vi.fn(async (path: string) => {
      if (path.endsWith("/schema")) {
        if (++schemaCalls === 1) throw new Error("temporary schema failure");
        return [{ schema: "demo", name: "sales" }];
      }
      if (++columnCalls === 1) throw new Error("temporary column failure");
      return [{ name: "amount", type: "Float64" }];
    });
    const loader = createSqlMetadataLoader(
      request as <T>(path: string) => Promise<T>,
    );
    await expect(
      loader.tables("conn-a", "SELECT * FROM demo.sales"),
    ).rejects.toThrow("temporary schema failure");
    expect(
      (await loader.tables("conn-a", "SELECT * FROM demo.sales"))[0].columns,
    ).toBeUndefined();
    expect(
      (await loader.tables("conn-a", "SELECT * FROM demo.sales"))[0]
        .columns?.[0].name,
    ).toBe("amount");
    expect(schemaCalls).toBe(2);
    expect(columnCalls).toBe(2);
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
    const loader = createSqlMetadataLoader(request);
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
    const loader = createSqlMetadataLoader(async <T>() => {
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
