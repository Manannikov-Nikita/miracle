# Project explorer file actions Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans for the scoped tasks below.

**Goal:** Rename, move and delete project files/folders from an accessible right-click menu.
**Architecture:** Extend safe filesystem operations, coordinate changes through the existing editor registry, and add Radix menu/dialog components to the tree.
**Tech Stack:** React, TypeScript, Radix, Fastify, Node.js 24.22.2, Vitest.
**Spec:** docs/superpowers/specs/2026-11-12-project-file-actions-design.md

## Global Constraints

- Use Node.js 24.22.2 from .local/node24/bin; test desktop only.
- Preserve user files, existing style and dirty editor content; test only synthetic fixtures.
- Reject filesystem overwrites, internal paths and conflicting Git/agent work.
- Deletion requires confirmation; preserve open drafts and block Save recreating deleted files.

## Review Focus

- Folder prefix boundaries and locked descendants, including not-yet-created files.
- Directory contents containing hidden/internal data or symlinks.
- SQL/text extension changes while a tab has unsaved edits.
- Stale async open/refresh responses after file mutations.
- Menu/dialog focus return and failed operation recovery.

### Task 1: Safe filesystem operations
**Files:** src/server/project-files.ts, src/server/project-routes.ts, src/server/agents/entity-work.ts, src/shared/project-files.ts, tests/project-explorer.test.ts.
**Interfaces:** MoveProjectFile adds optional name; POST /api/project/file/move supports files/folders and returns existing ProjectFileMove. DELETE /api/project/entry?path= returns ProjectFileDeletion { path }.
- [x] Write and run failing filesystem/API tests for rename, folder moves, recursive delete, collision/private-path/lock rejections.
- [x] Implement with full preflight and no-overwrite behavior; preserve existing file-move contract.
- [x] Run focused backend tests and review the diff.

### Task 2: Editor synchronization
**Files:** src/client/project-file-drafts.ts, src/client/components/SqlWorkspace.tsx, src/client/App.tsx, src/client/components/Explorer.tsx, tests/sql-source-tabs.test.ts.
**Interfaces:** Keep ProjectFileMover; add ProjectFileDeleter(input: DeleteProjectFile): Promise<ProjectFileDeletion>, onDeleteFile prop to Explorer/tree and onFileDeleterChange registration to SqlWorkspace.
- [x] Write failing tests for subtree rebinds, dirty extension changes and deleted drafts.
- [x] Rebind all descendant paths, invalidate stale reads, coordinate busy state; retain deleted drafts and disable saving/refreshing them.
- [x] Wire deletion callbacks through App/Explorer and run focused editor tests.

### Task 3: Explorer interaction
**Files:** src/client/components/ProjectFileTree.tsx, new ProjectFileContextMenu.tsx / ProjectFileActionDialog.tsx, project-files.css, tests/project-file-tree.test.ts, package.json/package-lock.json/THIRD_PARTY_NOTICES.md.
**Interfaces:** onMoveFile accepts name for rename; onDeleteFile performs confirmed deletion; existing creation callback gains explicit parent parameter.
- [x] Add @radix-ui/react-context-menu, matching current primitives.
- [x] Write failing right-click/action/keyboard tests; implement menu, inline rename (Enter/Escape, no modal), lazy folder picker, confirmation dialog and refresh/reselection.
- [x] Extend drag/drop to folders, preventing self/descendant moves; test failed actions retain dialog/tree state.
- [x] Run focused tests and desktop browser checks with synthetic files.

### Task 4: Integration verification
- [x] Independent review of backend/editor/UI integration; resolve actionable findings.
- [x] Run full npm test and npm run build using pinned Node24; regenerate dependency notices.
- [x] Inspect desktop UI and preserve a screenshot of inline renaming; leave test environment running.
