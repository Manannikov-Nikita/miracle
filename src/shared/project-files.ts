export interface ProjectTreeEntry {
  path: string;
  name: string;
  kind: "directory" | "file";
  size?: number;
}

export interface ProjectTree {
  path: string;
  entries: ProjectTreeEntry[];
  truncated: boolean;
}

export interface ProjectTextFile {
  path: string;
  name: string;
  content: string;
  revision: string;
  size: number;
  updatedAt: string;
}

export interface SaveProjectFile {
  content: string;
  baseRevision: string;
}

export interface CreateProjectFile {
  directory: string;
  name: string;
}

export const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024;
