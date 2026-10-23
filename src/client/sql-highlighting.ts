import type { Engine } from "../shared/types";
import type { languages } from "monaco-editor/editor/editor.api.js";
import {
  conf as sqlConfiguration,
  language as sqlLanguage,
} from "monaco-editor/languages/definitions/sql/sql.js";
import { clickhouseKeywords } from "./clickhouse-completion";

export const clickhouseSqlLanguageId = "clickhouse-sql";
export const clickhouseSqlConfiguration = sqlConfiguration;

// Extend Monaco's SQL lexer in its own language, so connection switches do not
// alter Trino tokenization. Keep its comment/string states and theme token names.
export const clickhouseSqlLanguage: languages.IMonarchLanguage = {
  ...sqlLanguage,
  ignoreCase: true,
  keywords: [
    ...sqlLanguage.keywords,
    ...new Set(clickhouseKeywords.flatMap((phrase) => phrase.split(" "))),
  ],
  tokenizer: {
    ...sqlLanguage.tokenizer,
    root: [
      // JOIN is an operator in the generic lexer. Color only the ClickHouse
      // ARRAY JOIN phrase together; ordinary joins retain their existing style.
      [/`/, { token: "identifier.quote", next: "@backtickIdentifier" }],
      [/\b(?:LEFT\s+)?ARRAY\s+JOIN\b/, "keyword"],
      ...sqlLanguage.tokenizer.root,
    ],
    backtickIdentifier: [
      [/[^`\\]+/, "identifier"],
      [/\\./, "identifier"],
      [/``/, "identifier"],
      [/`/, { token: "identifier.quote", next: "@pop" }],
      [/\\/, "identifier"],
    ],
    // ClickHouse accepts backslash escapes as well as doubled single quotes.
    string: [
      [/[^'\\]+/, "string"],
      [/\\./, "string"],
      [/''/, "string"],
      [/'/, { token: "string", next: "@pop" }],
      [/\\/, "string"],
    ],
  },
};

export const sqlLanguageForEngine = (engine?: Engine) =>
  engine === "clickhouse" ? clickhouseSqlLanguageId : "sql";
