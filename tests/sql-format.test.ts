import { describe, it, expect } from "vitest";
import { formatSql, sqlFileName } from "../src/client/sql-files";
describe("SQL files and dialect formatting", () => {
  it("preserves case-sensitive ClickHouse function names", () => {
    expect(
      formatSql(
        "select toStartOfMonth(sold_at), uniqExact(region) from demo.sales",
        "clickhouse",
      ),
    ).toContain("toStartOfMonth(");
    expect(
      formatSql("select uniqExact(region) from demo.sales", "clickhouse"),
    ).toContain("uniqExact(");
  });
  it("formats ClickHouse without altering literals or comments", () => {
    const r = formatSql(
      "select toStartOfMonth(sold_at) as month,sum(amount) as revenue from demo.sales where comment='select from; -- untouched' group by month",
      "clickhouse",
    );
    expect(r).toContain("SELECT");
    expect(r).toContain("\n");
    expect(r).toContain("'select from; -- untouched'");
    expect(r).toContain("GROUP BY");
  });
  it("supports Trino expressions and preserves semantic tokens", () => {
    const r = formatSql(
      "select date_trunc('month',orderdate) as month, count(*) from tpch.tiny.orders group by 1",
      "trino",
    );
    expect(r).toContain("'month'");
    expect(r).toContain("tpch.tiny.orders");
    expect(r).toContain("COUNT(*)");
  });
  it("normalizes downloaded SQL file names without doubling extensions", () => {
    expect(sqlFileName("revenue.sql")).toBe("revenue.sql");
    expect(sqlFileName("revenue")).toBe("revenue.sql");
    expect(sqlFileName("../my/file")).toBe(".._my_file.sql");
  });
  it("does not silently replace SQL on formatting error", () => {
    expect(() => formatSql("SELECT 'unclosed", "trino")).toThrow();
  });

  describe.each(["clickhouse", "trino"] as const)(
    "%s alias alignment",
    (engine) => {
      const call = (name: string) =>
        engine === "trino" ? name.toUpperCase() : name;

      it("aligns AS and alias starts after the longest SELECT expression", () => {
        const result = formatSql(
          "select id as identifier, sum(amount) as revenue, count(*) as order_count from orders",
          engine,
        );
        expect(result).toBe(
          [
            "SELECT",
            "    id          AS identifier,",
            `    ${call("sum")}(amount) AS revenue,`,
            `    ${call("count")}(*)    AS order_count`,
            "FROM",
            "    orders",
          ].join("\n"),
        );
        expect(formatSql(result, engine)).toBe(result);
      });

      it("keeps each CTE and outer SELECT alignment independent", () => {
        const result = formatSql(
          "with sales as (select id as item, sum(amount) as total from orders group by id) select item as identifier, total * 2 as doubled from sales as src",
          engine,
        );
        expect(result).toContain("    sales AS (");
        expect(result).toContain("            id          AS item,");
        expect(result).toContain(`            ${call("sum")}(amount) AS total`);
        expect(result).toContain("    item      AS identifier,");
        expect(result).toContain("    total * 2 AS doubled");
        expect(result).toContain("    sales AS src");
        expect(formatSql(result, engine)).toBe(result);
      });

      it("preserves AS in CAST, strings, comments and quoted aliases", () => {
        const result = formatSql(
          "select 'AS untouched' as label, cast(amount as decimal(10,2)) as amount_value, id /* AS inner */ as \"alias AS text\" from orders as src -- AS trailing",
          engine,
        );
        expect(result).toContain("'AS untouched'");
        expect(result).toContain(`${call("cast")}(amount AS decimal(10, 2))`);
        expect(result).toContain("/* AS inner */");
        expect(result).toContain('AS "alias AS text"');
        expect(result).toContain("    orders AS src -- AS trailing");
        const columns = [
          "AS label",
          "AS amount_value",
          'AS "alias AS text"',
        ].map((alias) => {
          const line = result
            .split("\n")
            .find((value) => value.includes(alias));
          expect(line).toBeDefined();
          return line!.indexOf(alias);
        });
        expect(new Set(columns).size).toBe(1);
        expect(formatSql(result, engine)).toBe(result);
      });

      it("uses independent alias columns for UNION branches", () => {
        const result = formatSql(
          "select id as identifier, sum(amount) as revenue from orders union all select x as first_value, y + 1 as second_value from other_orders",
          engine,
        );
        expect(result).toContain("    id          AS identifier,");
        expect(result).toContain(`    ${call("sum")}(amount) AS revenue`);
        expect(result).toContain("\nUNION ALL\nSELECT\n");
        expect(result).toContain("    x     AS first_value,");
        expect(result).toContain("    y + 1 AS second_value");
        expect(formatSql(result, engine)).toBe(result);
      });

      it("aligns multiline CASE aliases without changing an inner CAST", () => {
        const result = formatSql(
          "select id as identifier, case when amount > 10 then cast(amount as decimal(10,2)) else 0 end as category, sum(amount) as revenue from orders",
          engine,
        );
        expect(result).toContain("    id          AS identifier,");
        expect(result).toContain("    END         AS category,");
        expect(result).toContain(`    ${call("sum")}(amount) AS revenue`);
        expect(result).toContain(
          `THEN ${call("cast")}(amount AS decimal(10, 2))`,
        );
        expect(formatSql(result, engine)).toBe(result);
      });

      it("does not share an alias column across separate statements", () => {
        const result = formatSql(
          "select id as identifier, sum(amount) as revenue from orders; select x as first_value, y + 1 as second_value from other_orders;",
          engine,
        );
        expect(result).toContain("    id          AS identifier,");
        expect(result).toContain(`    ${call("sum")}(amount) AS revenue`);
        expect(result).toContain("    x     AS first_value,");
        expect(result).toContain("    y + 1 AS second_value");
        expect(formatSql(result, engine)).toBe(result);
      });
    },
  );
});
