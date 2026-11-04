import type { ProjectTextFile } from "../shared/project-files";

export interface ProjectFileDraft extends ProjectTextFile {
  id: string;
  savedContent: string;
}

export const isSqlProjectFile = (path: string) => /\.sql$/i.test(path);

export function fileLanguage(path: string): string {
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile."))
    return "dockerfile";
  if (/^(\.env|\.gitignore|\.dockerignore|\.editorconfig)(\.|$)/.test(name))
    return "ini";
  const extension = name.split(".").pop()!;
  return (
    (
      {
        md: "markdown",
        markdown: "markdown",
        mdx: "mdx",
        json: "json",
        jsonc: "json",
        jsonl: "json",
        ipynb: "json",
        yaml: "yaml",
        yml: "yaml",
        toml: "ini",
        ini: "ini",
        conf: "ini",
        cfg: "ini",
        js: "javascript",
        jsx: "javascript",
        mjs: "javascript",
        cjs: "javascript",
        ts: "typescript",
        tsx: "typescript",
        mts: "typescript",
        cts: "typescript",
        py: "python",
        pyw: "python",
        r: "r",
        sh: "shell",
        bash: "shell",
        zsh: "shell",
        css: "css",
        scss: "scss",
        less: "less",
        html: "html",
        htm: "html",
        xml: "xml",
        svg: "xml",
        graphql: "graphql",
        gql: "graphql",
        go: "go",
        rs: "rust",
        java: "java",
        c: "cpp",
        h: "cpp",
        cpp: "cpp",
        hpp: "cpp",
        cs: "csharp",
        rb: "ruby",
        php: "php",
        sql: "sql",
        proto: "protobuf",
        kt: "kotlin",
        swift: "swift",
        lua: "lua",
        tf: "hcl",
        hcl: "hcl",
      } as Record<string, string>
    )[extension] || "plaintext"
  );
}

export function loadProjectFileDrafts(workspaceId: string): ProjectFileDraft[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`miracle:project-files:${workspaceId}`) || "[]",
    );
    if (!Array.isArray(value)) return [];
    return value.filter(
      (file): file is ProjectFileDraft =>
        file &&
        ["id", "path", "name", "content", "savedContent", "revision"].every(
          (key) => typeof file[key] === "string",
        ),
    );
  } catch {
    return [];
  }
}
