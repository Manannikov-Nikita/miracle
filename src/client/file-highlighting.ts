import * as monaco from "monaco-editor/editor/editor.api.js";

let loaded: Promise<unknown> | undefined;
/** Register Monaco's lazy tokenizers without loading language-service workers. */
export function ensureFileLanguage() {
  return (loaded ??=
    import("monaco-editor/languages/definitions/register.all.js").then(() => {
      monaco.languages.register({
        id: "json",
        extensions: [".json", ".jsonc", ".jsonl"],
      });
      monaco.languages.setMonarchTokensProvider("json", {
        tokenizer: {
          root: [
            [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "key"],
            [/"(?:[^"\\]|\\.)*"/, "string"],
            [/\b(?:true|false|null)\b/, "keyword"],
            [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
            [/\/\/.*$/, "comment"],
            [/[{}\[\],:]/, "delimiter"],
          ],
        },
      });
    }));
}
