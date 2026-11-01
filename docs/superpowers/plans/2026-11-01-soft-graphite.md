# Soft Graphite Implementation Plan

**Goal:** Apply the approved soft graphite visual language to Miracle while preserving its working layout and data behavior.
**Architecture:** Existing React/Radix/Phosphor components and CSS. Global semantic tokens feed shell and board; Monaco uses matching editor colors. No new dependencies or server changes.
**Spec:** ../specs/2026-11-01-soft-graphite-design.md

## Constraints and review focus

- Preserve SQL editor models, imports, saved queries, connection fields, shortcuts and query execution.
- Preserve board geometry, data snapshots, permissions and deletion confirmations.
- Keep the existing chat layout and interactions.
- Keep controls usable in 340–500 px panes, long names, running/disabled/error states and keyboard navigation.
- Color adjustments must retain clear focus indicators, readable secondary text and distinct chart series.

## Tasks

- [x] Shell and SQL: update src/client/styles.css and components/SqlWorkspace.tsx. Neutral surfaces and semantic tokens, readable type, fewer bands, secondary SQL actions in Radix menu. Check SQL/date-batch/import and workspace-pane tests.
- [x] Board: update src/client/board styles and BoardWorkspace.tsx. Share tokens, remove persistent rare board actions into menu, consistent Phosphor controls, preserve data density and canvas behavior. Check board/table/chart/markdown tests.
- [x] Verify: run npm test and npm run build; inspect real app at the existing local demo address. Check overflow/menu/focus/chat/connection behavior. Independent diff review, fix material findings, save screenshots and verification notes.

## Execution notes

The user already confirmed implementation after choosing the visual proposal. Proceed without another design/plan approval. Native worktree creation could not identify the repository; use the clean current checkout on codex/soft-graphite. CSS changes do not need tests duplicating their declarations. Board presentation is delegated with exclusive file ownership; final review is independent.

Verification progress: baseline suite passes 835/835 when allowed to bind loopback test servers; sandbox-only run could not bind (EPERM). SQL/import/workspace targeted checks pass 32/32. Quiet text adjusted to #9c9fa5 for 4.5:1 contrast even on hover surfaces.

Final verification: all 75 test files / 835 tests pass after implementation; `npm run build` passes (existing Vite chunk-size warning remains). Board-focused checks passed 284 tests. `git diff --check` passes. Browser checks covered a 340 px SQL pane, board toolbar overflow, connection dialog, existing chat, SQL menu Escape focus, and cancelling board rename/delete dialogs. Independent review found one focus regression after formatting from the SQL menu: reproduced on an empty temporary tab, fixed, then confirmed `document.activeElement` is inside Monaco with label “Редактор SQL”. The temporary tab was closed. No SQL queries were executed during visual verification. Screenshot: `miracle-soft-graphite.jpg` in this task's visualization directory.
