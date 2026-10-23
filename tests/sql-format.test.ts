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
});
