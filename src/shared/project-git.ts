export interface GitFile {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  conflicted: boolean;
}

export interface GitStatus {
  state: "ready" | "not_repository" | "unavailable";
  message?: string;
  projectRoot: string;
  root?: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  unborn: boolean;
  isWorktree: boolean;
  worktrees: {
    path: string;
    branch: string | null;
    head: string | null;
    current: boolean;
    locked?: boolean;
    prunable?: boolean;
  }[];
  branches: { name: string; current: boolean; worktreePath?: string }[];
  files: GitFile[];
  counts: {
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
  };
  revision: string;
  canMutate: boolean;
  mutationBlockedReason?: string;
}

export interface GitDiff {
  path: string;
  patch: string;
  truncated: boolean;
  binary: boolean;
  revision: string;
}
