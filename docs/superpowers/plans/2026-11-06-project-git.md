# Project Git Implementation Plan

> **For agentic workers:** Use isolated file ownership for parallel implementation and independent review.

**Goal:** Add project Git status and local actions next to the connection selector.
**Architecture:** Shared typed HTTP contract, bounded system-Git service, existing authenticated project routes, compact React button and management dialog. Preserve native-file drafts on branch changes.
**Tech Stack:** Node 24, Fastify, TypeScript, React, existing Radix Modal, Vitest.
**Spec:** docs/superpowers/specs/2026-11-06-project-git-design.md

## Global Constraints
- No dependencies, remote Git actions or Git operations on the developer checkout during QA.
- Use current projectRoot, preserve existing index and unrelated changes; no shell interpolation.
- Follow existing session/CSRF and agent locks.

## Review Focus
- Staged unrelated files survive selective commits and failures.
- Stale state, rename paths, untracked and deleted files cannot expand selection.
- Branch switches preserve drafts and refresh clean tabs.
- Linked worktrees, unborn/detached heads and missing Git are represented honestly.
- Nested project roots and runtime data do not grant mutation of unrelated files.

## Tasks
- [x] Backend: shared Git DTOs, status/diff/branch/create/commit service and routes; real temporary-repository tests for selection, stale state, worktree and boundary cases.
- [x] Frontend: compact status trigger, changes/diff/commit, branch actions, worktree list, polling and errors; interaction tests.
- [x] Integration: register routes; mount beside SQL connection and text-file path; gate drafts and refresh after checkout; tests for draft handling.
- [x] Verification: targeted tests, typecheck, full suite, build, diff check, independent review, @Browser QA against a disposable repository.

## Verification results
- Final full suite: 158 files, 2032 tests passed. Targeted Git/native-editor suite: 83 tests passed.
- Production build (including TypeScript checks) passed; existing large-chunk warning remains. `git diff --check` passed.
- Independent review reproduced and verified protections for runtime files, in-progress merges, file-to-directory replacement, renames and copies; no outstanding blocker.
- @Browser: selected SQL-only commit preserved an unrelated staged file; create/switch branch, occupied-worktree branch, worktree list, native editor refresh and dirty-draft guard verified in a temporary repository.
- Main test environment on 3078 refreshed; nested project correctly shows parent repository read-only. Disposable QA server stopped; main environment remains running.
- Boundary: a local branch moved externally is selected by its current name; its target object ID is not pinned by the revision token. Checkout still rereads the target tree for runtime-file protection.
