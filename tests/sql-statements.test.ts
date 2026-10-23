import { describe, expect, it } from "vitest";
import { sqlStatementAt } from "../src/client/sql-statements";

describe("sqlStatementAt", () => {
  it("selects the statement containing the caret, including its delimiter", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    expect(sqlStatementAt(sql, 0, "clickhouse")).toBe("SELECT 1;");
    expect(sqlStatementAt(sql, 8, "clickhouse")).toBe("SELECT 1;");
    expect(sqlStatementAt(sql, 9, "clickhouse")).toBe("SELECT 1;");
    expect(sqlStatementAt(sql, 10, "clickhouse")).toBe("SELECT 2;");
    expect(sqlStatementAt(sql, 13, "clickhouse")).toBe("SELECT 2;");
  });

  it("runs the preceding statement immediately after its delimiter at line end", () => {
    expect(sqlStatementAt("SELECT 1;\nSELECT 2;", 9, "trino")).toBe(
      "SELECT 1;",
    );
    expect(sqlStatementAt("SELECT 1;\nSELECT 2;", 10, "trino")).toBe(
      "SELECT 2;",
    );
    expect(sqlStatementAt("SELECT 1;\r\nSELECT 2;", 9, "trino")).toBe(
      "SELECT 1;",
    );
  });

  it("runs the preceding statement immediately after its delimiter before inline whitespace", () => {
    expect(sqlStatementAt("SELECT 1; SELECT 2;", 9, "trino")).toBe("SELECT 1;");
    expect(sqlStatementAt("SELECT 1; SELECT 2;", 10, "trino")).toBe(
      "SELECT 2;",
    );
  });

  it("runs the final statement immediately after its delimiter at EOF", () => {
    expect(sqlStatementAt("SELECT 1; SELECT 2;", 19, "trino")).toBe(
      "SELECT 2;",
    );
    expect(sqlStatementAt("SELECT 1;", 9, "trino")).toBe("SELECT 1;");
  });

  it("selects an adjacent statement when its first character directly follows the delimiter", () => {
    expect(sqlStatementAt("SELECT 1;SELECT 2;", 9, "trino")).toBe("SELECT 2;");
  });

  it("keeps multiline CTEs and quoted semicolons together", () => {
    const statement =
      "WITH rows AS (\n SELECT ';' AS value\n)\nSELECT value, \"a;\"\"b\", `c;``d`, 'e;''f' FROM rows;";
    expect(sqlStatementAt(statement + "\nSELECT 2", 60, "clickhouse")).toBe(
      statement,
    );
  });

  it("attaches leading comments to the following query", () => {
    const sql =
      "SELECT 1;\n-- Query two;\n/* outer; /* inner; */ comment */\nSELECT 2;";
    expect(sqlStatementAt(sql, 16, "trino")).toBe(
      "-- Query two;\n/* outer; /* inner; */ comment */\nSELECT 2;",
    );
  });

  it("treats ClickHouse hash comments as trivia", () => {
    const sql = "# comment;\nSELECT 1;\nSELECT 2";
    expect(sqlStatementAt(sql, 4, "clickhouse")).toBe("# comment;\nSELECT 1;");
    expect(sqlStatementAt(sql, 4, "trino")).toBe("# comment;");
  });

  it("does not offer comments, whitespace or empty delimiter segments for execution", () => {
    for (const sql of [
      "",
      " \r\n\t ",
      "-- SELECT 1;",
      "/* SELECT 1; */",
      "# SELECT 1;",
      ";;;",
    ])
      expect(sqlStatementAt(sql, 0, "clickhouse")).toBeNull();
    expect(sqlStatementAt("SELECT 1; ; SELECT 2", 10, "trino")).toBeNull();
    expect(
      sqlStatementAt("SELECT 1; /* comment */; SELECT 2", 14, "trino"),
    ).toBeNull();
  });

  it("uses the final query when the caret is in trailing trivia", () => {
    const sql = "SELECT 1;\nSELECT 2;\n-- trailing;\n/* comment */\n";
    expect(sqlStatementAt(sql, sql.length, "trino")).toBe("SELECT 2;");
    expect(sqlStatementAt(sql, sql.indexOf("trailing"), "trino")).toBe(
      "SELECT 2;",
    );
  });

  it("honors backslash escapes only in ClickHouse strings", () => {
    const sql = "SELECT 'a\\'; SELECT 2; --'\nSELECT 3;";
    expect(sqlStatementAt(sql, sql.indexOf("2"), "clickhouse")).toBe(
      "SELECT 'a\\'; SELECT 2; --'\nSELECT 3;",
    );
    expect(sqlStatementAt(sql, sql.indexOf("2"), "trino")).toBe("SELECT 2;");
  });

  it("keeps ClickHouse dollar strings whole using the server delimiter grammar", () => {
    const sql =
      "SELECT $$first; 'quoted'$$, $tag_1$second; --comment$tag_1$; SELECT 2;";
    expect(sqlStatementAt(sql, sql.indexOf("second"), "clickhouse")).toBe(
      "SELECT $$first; 'quoted'$$, $tag_1$second; --comment$tag_1$;",
    );
    expect(sqlStatementAt("SELECT $1$one; SELECT 2", 15, "clickhouse")).toBe(
      "SELECT 2",
    );
    expect(sqlStatementAt("SELECT $$one; SELECT 2", 15, "trino")).toBe(
      "SELECT 2",
    );
  });

  it.each([
    "SELECT 'unclosed; SELECT 3",
    'SELECT "unclosed; SELECT 3',
    "SELECT `unclosed; SELECT 3",
    "SELECT /* unclosed; SELECT 3",
    "SELECT $tag$unclosed; SELECT 3",
  ])("retains the malformed query containing the caret: %s", (malformed) => {
    const sql = "SELECT 1;\n" + malformed;
    expect(sqlStatementAt(sql, sql.length, "clickhouse")).toBe(malformed);
  });

  it("does not fall back to a previous query from an unterminated comment", () => {
    expect(
      sqlStatementAt("SELECT 1; /* unclosed; SELECT 2", 28, "trino"),
    ).toBeNull();
  });

  it("uses Monaco UTF-16 offsets and preserves CRLF and Unicode", () => {
    const sql = "SELECT '😀';\r\n-- Второй\r\nSELECT 'ёж';";
    expect(sqlStatementAt(sql, 11, "trino")).toBe("SELECT '😀';");
    expect(sqlStatementAt(sql, 13, "trino")).toBe("-- Второй\r\nSELECT 'ёж';");
  });

  it("clamps offsets outside the document and handles invalid numeric offsets", () => {
    const sql = "SELECT 1; SELECT 2";
    expect(sqlStatementAt(sql, -1, "trino")).toBe("SELECT 1;");
    expect(sqlStatementAt(sql, Infinity, "trino")).toBe("SELECT 2");
    expect(sqlStatementAt(sql, 1000, "trino")).toBe("SELECT 2");
    expect(sqlStatementAt(sql, NaN, "trino")).toBe("SELECT 1;");
  });
});
