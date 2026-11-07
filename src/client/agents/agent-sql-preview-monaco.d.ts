// Monaco exposes the Monarch runtime as JS modules but only ships declarations
// for its editor API. These are the lexical-only members used by SQL previews.
declare module "monaco-editor/editor/standalone/common/monarch/monarchCompile.js" {
  import type { languages } from "monaco-editor/editor/editor.api.js";
  export function compile(
    languageId: string,
    language: languages.IMonarchLanguage,
  ): unknown;
}
declare module "monaco-editor/editor/standalone/common/monarch/monarchLexer.js" {
  import type {
    IDisposable,
    languages,
  } from "monaco-editor/editor/editor.api.js";
  export class MonarchTokenizer {
    constructor(
      languageService: object,
      themeService: object,
      languageId: string,
      lexer: unknown,
      configurationService: {
        getValue: () => number;
        onDidChangeConfiguration: () => IDisposable;
      },
    );
    getInitialState(): languages.IState;
    tokenize(
      line: string,
      hasEOL: boolean,
      state: languages.IState,
    ): {
      tokens: { offset: number; type: string }[];
      endState: languages.IState;
    };
    dispose(): void;
  }
}
