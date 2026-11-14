import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateSql } from "../src/client/sql-diagnostics";

const ch = { engine: "clickhouse" as const };
const trino = { engine: "trino" as const };
const issueText = (sql: string, code: string, options = ch) =>
  validateSql(sql, options)
    .filter((issue) => issue.code === code)
    .map((issue) => sql.slice(issue.start, issue.end));

describe("SQL prevalidation", () => {
  it("pinpoints a conflicting explicit or implicit alias in the same SELECT", () => {
    const sql = "SELECT sum(amount) AS total, count(*) total FROM sales";
    expect(issueText(sql, "duplicate-alias")).toEqual(["total"]);
    expect(validateSql(sql, ch)[0]).toMatchObject({ severity: "error" });
    expect(validateSql(sql, trino)[0]).toMatchObject({ severity: "warning" });
  });

  it("does not mix aliases from CTEs, subqueries, UNION branches or statements", () => {
    const sql =
      "WITH q AS (SELECT count(*) AS n FROM a) SELECT sum(n) AS n FROM q UNION ALL SELECT count(*) AS n FROM b; SELECT 1 AS n";
    expect(issueText(sql, "duplicate-alias")).toEqual([]);
  });

  it("does not report repeated identical expressions as conflicting aliases", () => {
    expect(
      validateSql("SELECT amount AS value, amount AS value FROM t", ch),
    ).toEqual([]);
  });

  it("detects ClickHouse input shadowing and explains the engine setting", () => {
    const sql = "SELECT argMax(name, amount), sum(amount) AS amount FROM sales";
    expect(issueText(sql, "alias-shadowing")).toEqual(["amount"]);
    expect(
      validateSql(sql, ch).find((issue) => issue.code === "alias-shadowing")
        ?.message,
    ).toContain("prefer_column_name_to_alias");
    expect(
      validateSql(sql, trino).filter(
        (issue) => issue.code === "alias-shadowing",
      ),
    ).toEqual([]);
    expect(validateSql("SELECT amount AS amount FROM sales", ch)).toEqual([]);
  });

  it.each(["clickhouse", "trino"] as const)(
    "underlines missing grouping references for %s",
    (engine) => {
      const sql =
        "SELECT country, city, sum(amount) AS total FROM sales GROUP BY country";
      expect(
        validateSql(sql, { engine })
          .filter((issue) => issue.code === "missing-group-by")
          .map((issue) => sql.slice(issue.start, issue.end)),
      ).toEqual(["city"]);
    },
  );

  it("finds ungrouped references inside mixed aggregate/scalar expressions", () => {
    const sql =
      "SELECT country, amount + sum(tax), upper(city) FROM sales GROUP BY country";
    expect(issueText(sql, "missing-group-by")).toEqual(["amount", "city"]);
  });

  it("detects a missing GROUP BY in an aggregate query and keeps UTF-16 ranges", () => {
    const sql = '-- 😀\nSELECT "Город", sum(amount)\nFROM sales';
    expect(issueText(sql, "missing-group-by")).toEqual(['"Город"']);
    expect(validateSql(sql, ch)[0].start).toBe(sql.indexOf('"Город"'));
  });

  it.each([
    "SELECT country, sum(amount) FROM sales GROUP BY country",
    "SELECT upper(country), sum(amount) FROM sales GROUP BY country",
    "SELECT lower(country) || '!', sum(amount) FROM sales GROUP BY lower(country)",
    "SELECT t.country, sum(t.amount) FROM sales t GROUP BY country",
    "SELECT country, sum(amount) FROM sales GROUP BY 1",
    "SELECT country AS place, sum(amount) FROM sales GROUP BY place",
    "SELECT count(*), 10 AS constant FROM sales",
    "SELECT country, sum(amount) OVER (PARTITION BY city) FROM sales",
    "SELECT row_number() OVER (ORDER BY country), country FROM sales",
    "SELECT country, sum(sum(amount)) OVER () FROM sales GROUP BY country",
    "SELECT country, sumIf(amount, paid) FROM sales GROUP BY country",
    "SELECT country, quantile(0.5)(amount) FROM sales GROUP BY country",
    "SELECT country, sum(amount) FROM sales GROUP BY ALL",
    "SELECT CAST(country AS String), sum(amount) FROM sales GROUP BY country",
    "SELECT CASE WHEN country IS NULL THEN 'empty' ELSE country END, sum(amount) FROM sales GROUP BY country",
  ])("does not flag valid grouping/aggregate shapes: %s", (sql) => {
    expect(validateSql(sql, ch)).toEqual([]);
  });

  it("treats grouping by a transformed expression differently from grouping the input", () => {
    const sql = "SELECT country, count(*) FROM sales GROUP BY lower(country)";
    expect(issueText(sql, "missing-group-by")).toEqual(["country"]);
  });

  it("validates inner scopes separately while ignoring aggregate subqueries in the outer scope", () => {
    const sql =
      "SELECT country, (SELECT city, sum(amount) FROM sales) AS nested FROM places";
    expect(issueText(sql, "missing-group-by")).toEqual(["city"]);
  });

  it("ignores comments, quoted keyword names, strings and ClickHouse heredocs", () => {
    const sql =
      "# SELECT city, sum(x) FROM nope\nSELECT $$ SELECT city, sum(x) FROM nope $$ AS text, 'SELECT x AS a, y AS a' AS literal, `FROM` FROM t /* SELECT z, sum(z) */";
    expect(validateSql(sql, ch)).toEqual([]);
  });

  it.each([
    "SELECT city, sum(",
    "SELECT city, sum(amount) FROM",
    "SELECT city, sum(amount) FROM sales GROUP BY",
    "SELECT city, sum(amount) FROM sales GROUP BY city,",
    "SELECT 'unterminated, sum(amount) FROM sales",
    "SELECT city, sum(amount) FROM sales /* unfinished",
  ])(
    "waits for unfinished SQL instead of inventing semantic errors: %s",
    (sql) => {
      expect(validateSql(sql, ch)).toEqual([]);
    },
  );

  it.each([
    "SELECT country, sum(amount) FROM sales GROUP BY AUTO",
    "SELECT country, sum(amount) FROM sales GROUP BY GROUPING SETS ((country), ())",
    "SELECT country, sum(amount) FROM sales GROUP BY ROLLUP(country)",
    "SELECT country, custom_aggregate(amount) FROM sales GROUP BY country",
  ])(
    "does not guess about advanced or unknown grouping semantics: %s",
    (sql) => {
      expect(validateSql(sql, trino)).toEqual([]);
    },
  );

  it("uses a supplied function catalogue for custom ClickHouse aggregates", () => {
    const sql = "SELECT country, customAggregate(amount) FROM sales";
    const diagnostics = validateSql(sql, {
      ...ch,
      functions: {
        functions: [{ name: "customAggregate", isAggregate: true }],
        aggregateCombinators: [],
      },
    });
    expect(
      diagnostics.map((issue) => sql.slice(issue.start, issue.end)),
    ).toEqual(["country"]);
  });

  it("reports a direct aggregate in WHERE with a HAVING hint", () => {
    const sql =
      "SELECT country, sum(amount) FROM sales WHERE sum(amount) > 10 GROUP BY country";
    expect(issueText(sql, "aggregate-in-filter")).toEqual(["sum"]);
    expect(
      validateSql(sql, ch).find((issue) => issue.code === "aggregate-in-filter")
        ?.message,
    ).toContain("HAVING");
  });

  it.each([
    "SELECT city, count(*) FILTER (WHERE amount > 0) FROM sales GROUP BY city",
    "SELECT city, sum(amount) OVER w FROM sales WINDOW w AS (PARTITION BY country)",
    "SELECT date_trunc('day', ts), count(*) FROM sales GROUP BY 1",
    'SELECT "Country", count(*) FROM sales GROUP BY country',
    "SELECT country, custom_aggregate(amount) FROM sales GROUP BY country",
    "SELECT current_user, current_catalog, current_schema, count(*) FROM sales",
    "SELECT DATE '2026-01-01', TIMESTAMP '2026-01-01 00:00:00', count(*) FROM sales",
    "SELECT country, count(*) FROM sales GROUP BY (country)",
    "SELECT lower(country), count(*) FROM sales GROUP BY ((lower(country)))",
  ])("avoids false positives for Trino expressions: %s", (sql) => {
    expect(validateSql(sql, trino)).toEqual([]);
  });

  it("does not treat qualified identity aliases as input substitution", () => {
    const sql =
      "SELECT t.amount AS amount, max(amount) FROM sales t GROUP BY t.amount";
    expect(issueText(sql, "alias-shadowing")).toEqual([]);
  });

  it("keeps case-sensitive ClickHouse identifiers and qualified join columns distinct", () => {
    const caseSql = "SELECT Country, count(*) FROM sales GROUP BY country";
    expect(issueText(caseSql, "missing-group-by")).toEqual(["Country"]);
    const joined =
      "SELECT a.id, b.id, count(*) FROM a JOIN b ON a.id = b.id GROUP BY a.id";
    expect(issueText(joined, "missing-group-by")).toEqual(["b.id"]);
  });

  it("treats quoted and unquoted alias names according to the dialect", () => {
    const sql = 'SELECT 1 AS total, 2 AS "TOTAL"';
    expect(issueText(sql, "duplicate-alias")).toEqual([]);
    expect(validateSql(sql, trino).map((issue) => issue.code)).toEqual([
      "duplicate-alias",
    ]);
  });

  it("does not classify scalar-subquery aggregates as WHERE aggregates", () => {
    expect(
      validateSql(
        "SELECT country FROM sales WHERE amount > (SELECT max(amount) FROM sales)",
        trino,
      ),
    ).toEqual([]);
  });

  it("bounds generated SQL and the number of emitted hints", () => {
    expect(validateSql("SELECT ".repeat(30_000), ch)).toEqual([]);
    const sql = `SELECT ${Array.from({ length: 150 }, (_, i) => `field_${i}`).join(", ")}, count(*) FROM t`;
    expect(validateSql(sql, ch)).toHaveLength(100);
  });

  it("does not guess the grouping semantics of ClickHouse scalar WITH aliases", () => {
    expect(
      validateSql("WITH 1 AS n SELECT n, count(*) FROM sales", ch),
    ).toEqual([]);
    expect(
      validateSql("WITH sum(amount) AS total SELECT total FROM sales", ch),
    ).toEqual([]);
    const sql =
      "WITH 1 AS n SELECT n, count(*) FROM sales; SELECT n, count(*) FROM sales";
    const issues = validateSql(sql, ch);
    expect(issues).toHaveLength(1);
    expect(issues[0].start).toBe(sql.lastIndexOf("n, count"));
  });

  it.each([ch, trino])(
    "matches equivalent qualified GROUP BY expressions for $engine",
    (options) => {
      expect(
        validateSql(
          "SELECT lower(t.country), count(*) FROM sales t GROUP BY lower(country)",
          options,
        ),
      ).toEqual([]);
      expect(
        validateSql(
          "SELECT lower(country), count(*) FROM sales t GROUP BY lower(t.country)",
          options,
        ),
      ).toEqual([]);
      const sql =
        "SELECT lower(b.country), count(*) FROM a JOIN b ON a.id=b.id GROUP BY lower(a.country)";
      expect(
        validateSql(sql, options).map((issue) =>
          sql.slice(issue.start, issue.end),
        ),
      ).toEqual(["b.country"]);
    },
  );

  it("resolves ClickHouse sibling aggregate alias chains with a cycle guard", () => {
    expect(
      validateSql(
        "SELECT sum(amount) AS s, s AS s2, s2 * 2 AS s3 FROM sales",
        ch,
      ),
    ).toEqual([]);
    expect(() =>
      validateSql("SELECT b AS a, a AS b, sum(amount) FROM sales", ch),
    ).not.toThrow();
    expect(
      issueText(
        "SELECT country AS country, count(*) FROM sales",
        "missing-group-by",
      ),
    ).toEqual(["country"]);
  });

  it("bounds nested function and grouping work before recursive inspection", () => {
    const nested = `${"abs(".repeat(4_000)}amount${")".repeat(4_000)}`;
    expect(validateSql(`SELECT ${nested}, count(*) FROM sales`, ch)).toEqual(
      [],
    );
    const grouped = `${"(".repeat(4_000)}country${")".repeat(4_000)}`;
    expect(
      validateSql(
        `SELECT country, count(*) FROM sales GROUP BY ${grouped}`,
        ch,
      ),
    ).toEqual([]);
  });

  it("bounds repeated expansion of a branching alias chain", async () => {
    // A subprocess timeout can interrupt a synchronous regression without
    // hanging the test runner. Thirty aliases must not cause 2^30 inspections.
    const script = `
      import { validateSql } from ${JSON.stringify(new URL("../src/client/sql-diagnostics.ts", import.meta.url).href)};
      const columns = ['sum(amount) AS a0'];
      for (let i = 1; i <= 30; i++) columns.push('a' + (i - 1) + ' + a' + (i - 1) + ' AS a' + i);
      const diagnostics = validateSql('SELECT ' + columns.join(', ') + ' FROM sales', {engine: 'clickhouse'});
      if (diagnostics.length) throw new Error(JSON.stringify(diagnostics));
    `;
    await expect(
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { timeout: 5_000 },
      ),
    ).resolves.toBeDefined();
  }, 10_000);

  it.each([
    "SELECT substring(country FROM 1 FOR 3), count(*) FROM sales GROUP BY country",
    "SELECT trim(BOTH 'x' FROM country), count(*) FROM sales GROUP BY country",
    "SELECT trim(LEADING 'x' FROM country), count(*) FROM sales GROUP BY country",
    "SELECT trim(TRAILING 'x' FROM country), count(*) FROM sales GROUP BY country",
    "SELECT INTERVAL '1' DAY, INTERVAL '2' DAY",
    "SELECT INTERVAL '1' DAY AS first, INTERVAL '2' DAY AS second",
  ])("preserves valid Trino scalar syntax: %s", (sql) => {
    expect(validateSql(sql, trino)).toEqual([]);
  });
});
