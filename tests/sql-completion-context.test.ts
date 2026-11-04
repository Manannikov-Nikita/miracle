import { describe, expect, it } from "vitest";
import {
  sqlCompletionContext,
  sqlExpressionKey,
} from "../src/client/sql-completion-context";

function context(source: string, engine?: "clickhouse" | "trino") {
  const cursor = source.indexOf("|");
  return sqlCompletionContext(source.replace("|", ""), cursor, engine);
}

describe("SQL completion query context", () => {
  it.each(["ILIKE", "RLIKE", "REGEXP"])(
    "does not turn the operand of %s into an alias",
    (operator) => {
      const result = context(
        `SELECT city ${operator} country, city ${operator} country matches FROM sales GROUP BY |`,
        "clickhouse",
      );
      expect(result.projections[0].expression).toBe(`city ${operator} country`);
      expect(result.projections[0].alias).toBeUndefined();
      expect(result.projections[1].expression).toBe(`city ${operator} country`);
      expect(result.projections[1].alias).toBe("matches");
    },
  );

  it.each([
    "IS DISTINCT FROM",
    "IS NOT DISTINCT FROM",
    "IS /* test */ DISTINCT FROM",
  ])("keeps the comparison operator %s inside the projection", (operator) => {
    const result = context(
      `SELECT amount ${operator} country AS differs, region FROM sales GROUP BY |`,
      "trino",
    );
    expect(result.projections[0].expression.replace(/\s+/g, " ")).toBe(
      `amount ${operator.replace("/* test */ ", "")} country`,
    );
    expect(result.projections[0].alias).toBe("differs");
    expect(result.projections[1].expression).toBe("region");
    expect(result.scopeSql).not.toContain("FROM country");
  });

  it("does not turn the right operand of a null-safe comparison into an alias", () => {
    const result = context(
      "SELECT amount IS DISTINCT FROM country FROM sales GROUP BY |",
      "trino",
    );
    expect(result.projections[0].expression).toBe(
      "amount IS DISTINCT FROM country",
    );
    expect(result.projections[0].alias).toBeUndefined();
  });

  it.each([
    ["created_at AT TIME ZONE zone", undefined, "created_at AT TIME ZONE zone"],
    [
      "created_at AT TIME ZONE zone local_time",
      "local_time",
      "created_at AT TIME ZONE zone",
    ],
    [
      "created_at AT TIME ZONE 'UTC' local_time",
      "local_time",
      "created_at AT TIME ZONE 'UTC'",
    ],
    ["zone zone_name", "zone_name", "zone"],
  ])(
    "keeps timezone operands separate from aliases: %s",
    (projection, alias, expression) => {
      const result = context(
        `SELECT ${projection} FROM sales GROUP BY |`,
        "trino",
      );
      expect(result.projections[0].expression).toBe(expression);
      expect(result.projections[0].alias).toBe(alias);
    },
  );

  it("returns only enclosing SELECT scopes, nearest first, for correlated aliases", () => {
    const result = context(
      "SELECT old FROM previous; WITH cte AS (SELECT secret FROM hidden) SELECT s.city FROM sales s WHERE EXISTS (SELECT c.id FROM customers c WHERE EXISTS (SELECT 1 FROM invoices i WHERE s.|))",
    );
    expect(result.outerScopes).toHaveLength(2);
    expect(result.outerScopes[0]).toContain("FROM customers c");
    expect(result.outerScopes[0]).not.toMatch(
      /FROM (sales|invoices|previous|hidden)/,
    );
    expect(result.outerScopes[1]).toContain("FROM sales s");
    expect(result.outerScopes[1]).not.toMatch(
      /FROM (customers|invoices|previous|hidden)/,
    );
    expect(result.projections.map((item) => item.expression)).toEqual(["1"]);
  });

  it("does not expose sibling subqueries or CTEs as enclosing scopes", () => {
    const result = context(
      "WITH cte AS (SELECT secret FROM hidden) SELECT city FROM customers WHERE EXISTS (SELECT x FROM unrelated) AND EXISTS (SELECT 1 FROM invoices WHERE c.|)",
    );
    expect(result.outerScopes).toHaveLength(1);
    expect(result.outerScopes[0]).toContain("FROM customers");
    expect(result.outerScopes[0]).not.toMatch(
      /FROM (hidden|unrelated|invoices)/,
    );
    expect(
      context(
        "WITH cte AS (SELECT secret FROM hidden WHERE |) SELECT city FROM customers",
      ).outerScopes,
    ).toEqual([]);
  });

  it("normalizes harmless expression formatting without changing literals or quoted names", () => {
    expect(sqlExpressionKey("LOWER ( /* case */ region )")).toBe(
      sqlExpressionKey("lower(region)"),
    );
    expect(sqlExpressionKey("concat('A B', region)")).not.toBe(
      sqlExpressionKey("concat('a b', region)"),
    );
    expect(sqlExpressionKey('"Region"')).not.toBe(sqlExpressionKey('"region"'));
    expect(sqlExpressionKey("'a b'")).not.toBe(sqlExpressionKey("'ab'"));
  });

  it("does not inherit a query that appears only after the cursor", () => {
    expect(context("| SELECT region FROM sales").projections).toEqual([]);
    expect(
      context("SELECT region FROM sales; | SELECT city FROM customers")
        .projections,
    ).toEqual([]);
  });

  it("keeps an unfinished inner query isolated from the outer projection", () => {
    const result = context(
      "SELECT region FROM sales WHERE EXISTS (SELECT city FROM customers GROUP BY |",
    );
    expect(result.projections.map((item) => item.expression)).toEqual(["city"]);
    expect(result.scopeSql).not.toContain("FROM sales");
  });

  it("keeps keyword-looking literals inert and numeric punctuation inside expressions", () => {
    const result = context(
      "SELECT 'OVER SELECT FROM' label, .5 fraction, 1.25e2 value FROM sales GROUP BY |",
    );
    expect(result.projections.map((item) => item.expression)).toEqual([
      "'OVER SELECT FROM'",
      ".5",
      "1.25e2",
    ]);
    expect(result.projections[0]).toMatchObject({
      hasWindow: false,
      hasSubquery: false,
      functionNames: [],
    });
  });
  it("finds the current clause and SELECT columns even before metadata exists", () => {
    const result = context("SELECT region, city FROM sales GROUP BY |");
    expect(result.clause).toBe("groupBy");
    expect(result.projections.map((item) => item.expression)).toEqual([
      "region",
      "city",
    ]);
    expect(result.projections[0].reference).toEqual({
      qualifier: [],
      name: "region",
    });
  });

  it("keeps aliases, qualified columns, scalar calls and aggregate calls distinct", () => {
    const result = context(
      "SELECT s.region AS area, toStartOfMonth(date) month, sum(amount) AS total FROM sales s GROUP BY |",
      "clickhouse",
    );
    expect(result.projections).toEqual([
      {
        expression: "s.region",
        alias: "area",
        reference: { qualifier: ["s"], name: "region" },
        functionNames: [],
        hasWindow: false,
        hasSubquery: false,
      },
      {
        expression: "toStartOfMonth(date)",
        alias: "month",
        functionNames: ["toStartOfMonth"],
        hasWindow: false,
        hasSubquery: false,
      },
      {
        expression: "sum(amount)",
        alias: "total",
        functionNames: ["sum"],
        hasWindow: false,
        hasSubquery: false,
      },
    ]);
  });

  it("preserves quoted identifiers and aliases while unquoting reference names", () => {
    const result = context(
      'SELECT "s"."Order Date" AS "Month", `s`.`odd``name` `Name` FROM sales s GROUP BY |',
    );
    expect(result.projections[0]).toMatchObject({
      expression: '"s"."Order Date"',
      alias: '"Month"',
      reference: { qualifier: ["s"], name: "Order Date" },
    });
    expect(result.projections[1]).toMatchObject({
      expression: "`s`.`odd``name`",
      alias: "`Name`",
      reference: { qualifier: ["s"], name: "odd`name" },
    });
  });

  it("does not mistake operators and CASE endings for implicit aliases", () => {
    const result = context(
      "SELECT DISTINCT price + tax, amount IS NULL, CASE WHEN flag THEN city ELSE region END, price + tax gross FROM sales GROUP BY |",
    );
    expect(
      result.projections.map(({ expression, alias }) => ({
        expression,
        alias,
      })),
    ).toEqual([
      { expression: "price + tax", alias: undefined },
      { expression: "amount IS NULL", alias: undefined },
      {
        expression: "CASE WHEN flag THEN city ELSE region END",
        alias: undefined,
      },
      { expression: "price + tax", alias: "gross" },
    ]);
  });

  it("splits projection and grouping lists only at their own depth", () => {
    const result = context(
      "SELECT concat(city, ', ', region) place, [x, y] pair, region FROM sales GROUP BY concat(city, ', ', region), [x, y], re|",
      "clickhouse",
    );
    expect(result.projections.map((item) => item.expression)).toEqual([
      "concat(city, ', ', region)",
      "[x, y]",
      "region",
    ]);
    expect(result.groupBy).toEqual(["concat(city, ', ', region)", "[x, y]"]);
  });

  it("counts completed items and not the current partially typed grouping", () => {
    expect(context("SELECT a, b FROM sales GROUP BY a, b|").groupBy).toEqual([
      "a",
    ]);
    expect(
      context("SELECT a, b FROM sales GROUP BY a, | HAVING count(*) > 1")
        .groupBy,
    ).toEqual(["a"]);
    expect(
      context(
        "SELECT a, b FROM sales GROUP BY a, b ORDER BY a DESC, b NULLS LAST, |",
      ).orderBy,
    ).toEqual(["a", "b"]);
  });

  it("ignores keywords and commas inside comments and literals", () => {
    const result = context(
      "SELECT 'GROUP BY, FROM' AS label, /* FROM hidden */ region FROM sales -- GROUP BY bogus\nGROUP /* split */ BY re|",
    );
    expect(result.clause).toBe("groupBy");
    expect(result.projections.map((item) => item.expression)).toEqual([
      "'GROUP BY, FROM'",
      "region",
    ]);
  });

  it("handles ClickHouse backslash escapes without inventing clauses", () => {
    const result = context(
      "SELECT 'it\\'s FROM secret, GROUP BY' label, region FROM sales GROUP BY |",
      "clickhouse",
    );
    expect(result.projections).toHaveLength(2);
    expect(result.clause).toBe("groupBy");
  });

  it("isolates neighboring statements and UNION branches", () => {
    const result = context(
      "SELECT old FROM previous; SELECT region FROM sales UNION ALL SELECT city FROM customers GROUP BY |",
    );
    expect(result.projections.map((item) => item.expression)).toEqual(["city"]);
    expect(result.scopeSql).toContain("FROM customers");
    expect(result.scopeSql).not.toContain("FROM sales");
    expect(result.scopeSql).not.toContain("FROM previous");
    expect(context("SELECT old FROM previous; |").projections).toEqual([]);
  });

  it("uses the inner query when completing inside it", () => {
    const result = context(
      "SELECT outer_col FROM sales WHERE id IN (SELECT inner_col FROM customers GROUP BY |) ORDER BY outer_col",
    );
    expect(result.projections.map((item) => item.expression)).toEqual([
      "inner_col",
    ]);
    expect(result.clause).toBe("groupBy");
    expect(result.scopeSql).toContain("FROM customers");
    expect(result.scopeSql).not.toContain("FROM sales");
  });

  it("masks nested query sources while retaining outer sources and aliases", () => {
    const result = context(
      "WITH cte AS (SELECT secret FROM hidden) SELECT a.region, (SELECT count(*) FROM private) total FROM sales a JOIN (SELECT city FROM internal) nested ON a.id = nested.id GROUP BY |",
    );
    expect(result.projections[1].hasSubquery).toBe(true);
    expect(result.scopeSql).toContain("FROM sales a");
    expect(result.scopeSql).not.toMatch(/FROM (hidden|private|internal)/);
    expect(result.projections[0].expression).toBe("a.region");
  });

  it("reads FROM after the cursor without adopting the later clause", () => {
    const result = context(
      "SELECT re| FROM sales GROUP BY region ORDER BY region",
    );
    expect(result.clause).toBe("select");
    expect(result.scopeSql).toContain("FROM sales");
    expect(result.groupBy).toEqual([]);
    expect(result.orderBy).toEqual([]);
  });

  it("flags windows and nested function calls without treating CAST AS as an alias", () => {
    const result = context(
      "SELECT coalesce(sum(amount), 0) total, cast(region AS varchar), row_number() OVER (PARTITION BY region ORDER BY amount) rn FROM sales GROUP BY |",
    );
    expect(result.projections[0].functionNames).toEqual(["coalesce", "sum"]);
    expect(result.projections[1].alias).toBeUndefined();
    expect(result.projections[2].hasWindow).toBe(true);
  });

  it.each([
    "SELECT region FROM sales GROUP BY coalesce(re|)",
    "SELECT region FROM sales GROUP BY GROUPING SETS ((re|))",
    "SELECT region FROM sales GROUP BY ROLLUP(re|)",
    "SELECT sum(amount) OVER (ORDER BY re|) total FROM sales",
  ])(
    "does not reuse outer projection suggestions inside an expression: %s",
    (sql) => {
      expect(context(sql).clause).toBeUndefined();
    },
  );

  it.each([
    ["SELECT region FROM |", "from"],
    ["SELECT region FROM sales LEFT JOIN |", "join"],
    ["SELECT region FROM sales JOIN customers ON |", "on"],
    ["SELECT region FROM sales WHERE |", "where"],
    ["SELECT region FROM sales GROUP BY region HAVING |", "having"],
    ["SELECT region FROM sales ORDER BY |", "orderBy"],
  ])("recognizes the clause at the cursor: %s", (sql, clause) => {
    expect(context(sql).clause).toBe(clause);
  });

  it("does not interpret quoted keywords as query boundaries", () => {
    const result = context(
      'SELECT "FROM", "GROUP", "ORDER" FROM "SELECT" GROUP BY |',
    );
    expect(result.projections.map((item) => item.expression)).toEqual([
      '"FROM"',
      '"GROUP"',
      '"ORDER"',
    ]);
    expect(result.clause).toBe("groupBy");
  });
});
