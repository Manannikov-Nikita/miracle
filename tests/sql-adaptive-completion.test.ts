import { describe, expect, it } from "vitest";
import { sqlSuggestions } from "../src/client/sql-completion";
import type {
  Engine,
  SchemaTable,
  SqlFunctionCatalog,
} from "../src/shared/types";

const tables: SchemaTable[] = [
  {
    schema: "demo",
    name: "sales",
    columns: [
      { name: "amount", type: "Float64" },
      { name: "city", type: "String" },
      { name: "country", type: "String" },
      { name: "created_at", type: "DateTime" },
    ],
  },
  {
    schema: "demo",
    name: "customers",
    columns: [{ name: "customer_id", type: "UInt64" }],
  },
];
function complete(
  marked: string,
  engine: Engine = "clickhouse",
  catalog?: SqlFunctionCatalog,
  limit = 200,
) {
  const cursor = marked.indexOf("|");
  const sql = marked.replace("|", "");
  const before = sql.slice(0, cursor);
  return sqlSuggestions(
    sql,
    before,
    tables,
    { engine, database: "demo" },
    catalog,
    {
      prefix: before.match(/[\p{L}\p{N}_$]*$/u)?.[0] || "",
      limit,
    },
  );
}
const selected = (items: ReturnType<typeof complete>) =>
  items.filter((item) => item.detail === "Из SELECT");
const inserts = (items: ReturnType<typeof complete>) =>
  items.map((item) => item.insertText);

describe("context-aware SQL completion", () => {
  it("offers selected grouping dimensions ahead of unrelated schema columns", () => {
    const items = complete(
      "SELECT country, city, sum(amount) AS total FROM sales GROUP BY |",
    );
    expect(inserts(items).slice(0, 2)).toEqual(["country", "city"]);
    expect(inserts(selected(items))).toEqual(["country", "city"]);
    expect(items.filter((item) => item.insertText === "city")).toHaveLength(1);
    expect(inserts(items)).not.toContain("total");
  });
  it("uses ClickHouse scalar aliases while excluding nested aggregates, windows and aggregate alias dependencies", () => {
    const items = complete(
      "SELECT toStartOfDay(created_at) AS day, round(sum(amount)) AS total, total + 1 AS next, row_number() OVER () AS rn FROM sales GROUP BY |",
    );
    expect(inserts(selected(items))).toEqual(["day"]);
  });
  it("inserts Trino's original expression in GROUP BY and output alias in ORDER BY", () => {
    const query =
      "SELECT date_trunc('day', created_at) AS day, sum(amount) AS total FROM sales";
    expect(inserts(selected(complete(`${query} GROUP BY |`, "trino")))).toEqual(
      ["date_trunc('day', created_at)"],
    );
    expect(inserts(selected(complete(`${query} ORDER BY |`, "trino")))).toEqual(
      ["day", "total"],
    );
  });
  it("keeps selected expressions available before metadata is loaded", () => {
    const sql = "SELECT city, lower(country) FROM unavailable GROUP BY ";
    expect(
      inserts(selected(sqlSuggestions(sql, sql, [], { engine: "trino" }))),
    ).toEqual(["city", "lower(country)"]);
  });
  it("skips completed grouping keys written as aliases, expressions or ordinals", () => {
    const query =
      "SELECT city, toStartOfDay(created_at) AS day, country FROM sales";
    expect(inserts(selected(complete(`${query} GROUP BY 1, day, |`)))).toEqual([
      "country",
    ]);
    const items = complete(
      `${query} GROUP BY city, toStartOfDay(created_at), |`,
    );
    expect(inserts(selected(items))).toEqual(["country"]);
    expect(items.filter((item) => item.insertText === "city")).toHaveLength(0);
  });
  it("keeps the current partially typed key, filters prefixes and reserves the bounded list for SELECT items", () => {
    const items = complete(
      "SELECT city, country FROM sales GROUP BY co|",
      "clickhouse",
      undefined,
      1,
    );
    expect(inserts(items)).toEqual(["country"]);
  });
  it("completes only the column after an already typed SELECT qualifier", () => {
    const items = complete(
      "SELECT s.city, s.country, sum(s.amount) FROM sales s GROUP BY s.c|",
    );
    expect(inserts(selected(items))).toEqual(["city", "country"]);
    expect(inserts(items).some((item) => item.startsWith("s."))).toBe(false);
  });
  it("preserves quoted and implicit aliases", () => {
    const items = complete(
      'SELECT city AS "City name", lower(country) country_code FROM sales GROUP BY |',
    );
    expect(inserts(selected(items))).toEqual(['"City name"', "country_code"]);
  });
  it("does not leak projected aliases or table columns across SELECT scopes and statements", () => {
    const items = complete(
      "SELECT customer_id FROM customers; SELECT outer_q.city FROM (SELECT city, sum(amount) AS inner_total FROM sales GROUP BY |) outer_q ORDER BY outer_q.city",
    );
    expect(inserts(selected(items))).toEqual(["city"]);
    expect(inserts(items)).not.toContain("customer_id");
    expect(inserts(items)).not.toContain("inner_total");
  });
  it("resolves explicit correlated aliases while the nearest query alias takes precedence", () => {
    expect(
      inserts(
        complete(
          "SELECT s.city FROM sales s WHERE EXISTS (SELECT 1 FROM customers c WHERE s.c|)",
        ),
      ),
    ).toEqual(["city", "country", "created_at"]);
    expect(
      inserts(
        complete(
          "SELECT s.city FROM sales s WHERE EXISTS (SELECT 1 FROM customers s WHERE s.c|)",
        ),
      ),
    ).toEqual(["customer_id"]);
  });
  it("preserves Trino expression operators when recommending a grouping key", () => {
    expect(
      inserts(
        selected(
          complete(
            "SELECT amount IS DISTINCT FROM country AS differs FROM sales GROUP BY |",
            "trino",
          ),
        ),
      ),
    ).toEqual(["amount IS DISTINCT FROM country"]);
    expect(
      inserts(
        selected(
          complete(
            "SELECT created_at AT TIME ZONE zone FROM sales GROUP BY |",
            "trino",
          ),
        ),
      ),
    ).toEqual(["created_at AT TIME ZONE zone"]);
  });
  it("leaves nested grouping constructs and window ORDER BY to ordinary column completion", () => {
    expect(
      selected(
        complete(
          "SELECT lower(city) AS name FROM sales GROUP BY ROLLUP(|)",
          "trino",
        ),
      ),
    ).toEqual([]);
    expect(
      selected(
        complete(
          "SELECT city AS name, row_number() OVER (ORDER BY |) FROM sales",
        ),
      ),
    ).toEqual([]);
  });
  it("does not repeat completed sorting outputs, including aggregate aliases", () => {
    const items = complete(
      "SELECT city, sum(amount) AS total FROM sales ORDER BY total DESC, |",
    );
    expect(inserts(selected(items))).toEqual(["city"]);
  });
  it("uses server aggregate metadata and ClickHouse combinators", () => {
    const catalog: SqlFunctionCatalog = {
      functions: [
        { name: "customAgg", isAggregate: true },
        { name: "sum", isAggregate: true },
      ],
      aggregateCombinators: ["If", "State"],
    };
    expect(
      inserts(
        selected(
          complete(
            "SELECT city, customAgg(amount) AS custom, sumIfState(amount, amount > 0) AS state FROM sales GROUP BY |",
            "clickhouse",
            catalog,
          ),
        ),
      ),
    ).toEqual(["city"]);
  });
  it("prioritizes table sources after FROM and referenced columns in WHERE", () => {
    const sources = complete("SELECT city FROM |");
    const table = sources.find((item) => item.label === "sales")!;
    expect(table.sortText).toBeDefined();
    expect(table.sortText! < "SELECT").toBe(true);
    const columns = complete("SELECT city FROM sales WHERE |");
    expect(
      columns.find((item) => item.label === "city")?.sortText,
    ).toBeDefined();
    expect(selected(columns)).toEqual([]);
  });
  it("does not recommend aggregate functions where only per-row expressions are allowed", () => {
    for (const clause of ["GROUP BY", "WHERE", "ON"]) {
      const items = complete(`SELECT city FROM sales ${clause} |`);
      expect(
        items.some((item) => item.kind === "function" && item.label === "sum"),
      ).toBe(false);
      expect(
        items.some(
          (item) => item.kind === "function" && item.label === "toStartOfDay",
        ),
      ).toBe(true);
    }
  });
  it("keeps unrelated source and join keywords out of grouping and sorting", () => {
    for (const clause of ["GROUP BY", "ORDER BY"]) {
      const names = complete(`SELECT city FROM sales ${clause} |`)
        .filter((item) => item.kind === "keyword")
        .map((item) => item.label);
      expect(names).not.toContain("CROSS JOIN");
      expect(names).not.toContain("FROM");
      expect(names).not.toContain("SELECT");
      expect(names).toContain("CASE");
    }
  });
  it("uses the original grouping expression when a ClickHouse alias shadows an input column", () => {
    expect(
      inserts(
        selected(
          complete("SELECT lower(city) AS country FROM sales GROUP BY |"),
        ),
      ),
    ).toEqual(["lower(city)"]);
  });
  it("does not confuse string literal case when skipping completed expressions", () => {
    const items = complete(
      "SELECT concat(city, 'A'), concat(city, 'a') FROM sales GROUP BY concat(city, 'A'), |",
      "trino",
    );
    expect(inserts(selected(items))).toEqual(["concat(city, 'a')"]);
  });
  it("filters projected aliases with the user's typed case for Monaco ranking", () => {
    const item = selected(
      complete("SELECT lower(city) AS CityName FROM sales GROUP BY ci|"),
    )[0];
    expect(item).toMatchObject({
      insertText: "CityName",
      filterText: "ci",
    });
  });
});
