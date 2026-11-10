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

export interface MoveProjectFile {
  path: string;
  directory: string;
}

export interface ProjectFileMove {
  from: string;
  path: string;
  name: string;
}

export const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SQL_FILE_CHARACTERS = 1_000_000;
