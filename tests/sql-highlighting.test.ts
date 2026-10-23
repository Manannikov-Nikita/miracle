import { describe, expect, it } from "vitest";
import { language as genericSql } from "monaco-editor/languages/definitions/sql/sql.js";
import { compile } from "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
import { MonarchTokenizer } from "monaco-editor/editor/standalone/common/monarch/monarchLexer.js";
import {
  clickhouseSqlLanguage,
  sqlLanguageForEngine,
} from "../src/client/sql-highlighting";

// Run the same Monarch compiler/tokenizer used by Monaco. No DOM, editor or
// worker is needed for lexical tokens; only the line-length setting is supplied.
function tokens(sql: string, language = clickhouseSqlLanguage) {
  const tokenizer = new MonarchTokenizer(
    {},
    {},
    "sql-test",
    compile("sql-test", language),
    {
      getValue: () => 20000,
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
  );
  try {
    let state = tokenizer.getInitialState();
    return sql.split("\n").flatMap((line) => {
      const result = tokenizer.tokenize(line, true, state);
      state = result.endState;
      return result.tokens.map(
        (token: { offset: number; type: string }, index: number) => ({
          text: line.slice(
            token.offset,
            result.tokens[index + 1]?.offset ?? line.length,
          ),
          type: token.type,
        }),
      );
    });
  } finally {
    tokenizer.dispose();
  }
}
const typeAt = (result: ReturnType<typeof tokens>, value: string) =>
  result.find((token) => token.text.includes(value))?.type;

describe("ClickHouse SQL highlighting", () => {
  it.each(["array JOIN", "ARRAY JOIN", "ArRaY jOiN", "LEFT array JOIN"])(
    "highlights the whole %s phrase in the reported multiline query",
    (phrase) => {
      const result = tokens(
        `SELECT\n    *\nFROM\n    demo.sales\n    ${phrase} \nLIMIT\n    100;`,
      );
      expect(typeAt(result, phrase)).toBe("keyword.sql");
    },
  );
  it("recognizes ClickHouse clause words without matching identifier substrings", () => {
    const result = tokens(
      "SELECT array_value FROM events FINAL PREWHERE id > 0 SETTINGS max_threads = 1",
    );
    expect(typeAt(result, "array_value")).toBe("identifier.sql");
    expect(typeAt(result, "FINAL")).toBe("keyword.sql");
    expect(typeAt(result, "PREWHERE")).toBe("keyword.sql");
  });
  it("preserves strings, quoted identifiers and line/multiline comments", () => {
    const result = tokens(
      "SELECT 'ARRAY JOIN', \"ARRAY JOIN\" -- ARRAY JOIN\n/* ARRAY JOIN\nPREWHERE */\nARRAY JOIN tags",
    );
    expect(
      result
        .filter((token) => token.text.includes("ARRAY JOIN"))
        .map((token) => token.type),
    ).toEqual([
      "string.sql",
      "identifier.sql",
      "comment.sql",
      "comment.sql",
      "keyword.sql",
    ]);
  });
  it("keeps ARRAY JOIN inside ClickHouse backtick identifiers", () => {
    const result = tokens(
      "SELECT `ARRAY JOIN`, `a``ARRAY JOIN`, `a\\`ARRAY JOIN` FROM events",
    );
    expect(
      result
        .filter((token) => token.text.includes("ARRAY JOIN"))
        .map((token) => token.type),
    ).toEqual(["identifier.sql", "identifier.sql", "identifier.sql"]);
  });
  it("keeps ARRAY JOIN inside a string containing an escaped quote", () => {
    const result = tokens(
      "SELECT 'it\\'s ARRAY JOIN', 'it''s ARRAY JOIN' FROM events ARRAY JOIN tags",
    );
    expect(
      result
        .filter((token) => token.text.includes("ARRAY JOIN"))
        .map((token) => token.type),
    ).toEqual(["string.sql", "string.sql", "keyword.sql"]);
  });
  it("does not change the generic SQL language used for Trino", () => {
    expect(typeAt(tokens("ARRAY JOIN tags", genericSql), "ARRAY")).toBe(
      "identifier.sql",
    );
    expect(sqlLanguageForEngine("trino")).toBe("sql");
    expect(sqlLanguageForEngine(undefined)).toBe("sql");
    expect(sqlLanguageForEngine("clickhouse")).toBe("clickhouse-sql");
  });
});
