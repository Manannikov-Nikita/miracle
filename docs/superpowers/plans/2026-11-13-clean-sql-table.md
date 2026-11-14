# Cleaner board tables Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for implementation, with independent subtasks delegated where files do not overlap.

**Goal:** Implement the user's five table cleanup requirements and the follow-up request to open the clicked column in a right sidebar.

**Architecture:** Retain AG Grid and DuckDB. Extend the existing table model to combine a snapshot with manual rows, protect source cells at the common edit boundary, and separate the column editor from grid headers. Expansion portals into the owning board rather than a document modal. The column editor uses the same board scope: a floating right panel in normal view and a pane beside the expanded grid, with one active editor per board and cached drafts per table/column.

**Tech Stack:** React, TypeScript, AG Grid Community, Monaco, DuckDB, Vitest.

**Spec:** ../specs/2026-11-13-clean-sql-table-design.md

## Global Constraints

- Preserve existing stored edits, formula references, undo and read-only presentation rendering.
- Use existing dependencies and theme tokens; desktop verification only.
- No release/version changes or user installation changes.

## Review Focus

- SQL cells cannot be changed by typing, edit events or paste; local cells can.
- SQL plus manual rows survive sorting, filtering, formula calculation and pagination.
- Invalid expressions never save a partially created column; cancel leaves the document intact.
- Clicking a column title opens that exact column; renaming in the sidebar rewrites dependent expressions.
- Sorting stays separate, selected headers update without recreating the grid, and switching editors preserves drafts.
- Only one editor is active per owning board; independent board panes do not close each other's editors.
- Expansion fills only its board; closing restores a single grid and focus.

### Task 1: Mixed table data and protection

Files: shared/visual-table, server/visual-table, API pagination schema, corresponding tests.
- [x] Add failing regressions for mixed source/manual rows, ID conflicts and protected edits.
- [x] Implement backwards-compatible rows plus snapshot ingestion and shared edit guard.
- [x] Run shared, API and native DuckDB table tests.

### Task 2: Column editor and compact headers

Files: SqlTableHeader, new SqlTableColumnEditor, SQL table UI tests.
- [x] Replace header formula/aggregate tests with rename/focus/sort tests.
- [x] Create a large expression editor with validation, column references, type/aggregate settings and explicit save/cancel.
- [x] Test draft preservation, validation failure and create/edit behavior.

### Task 3: Board surface and grid integration

Files: new BoardTableSurface, SqlTableView, sql-table.css, component tests.
- [x] Change expansion assertions to an owning-board region without a dialog.
- [x] Integrate edge add buttons, source-cell tint/protection, manual-row addition and column editor.
- [x] Preserve undo, filtering, paging, read-only rendering and editor focus.

### Task 4: Verify

- [x] Run affected tests, typecheck and production build; broaden only for relevant regressions.
- [x] Inspect the desktop UI and exercise expansion, source lock, rename, sorting, add-row/add-column, invalid expression and undo.
- [x] Independent review of final diff; report completed behavior and material limits.

## Baseline verification result — before the sidebar follow-up

These results cover the completed five-part table cleanup. They do not establish verification of the subsequent sidebar changes below.

- Full suite: 216 files / 2860 tests passed with local fixture servers permitted. The initial sandboxed run failed to bind loopback ports (EPERM) and was stopped.
- TypeScript client/server and production build passed. Existing canvas test-environment and bundle-size notices remain.
- Desktop checks on the main stand: board-sized expansion without a dialog, invalid-expression draft preservation, valid SQL computation, rename/reference updates, sort, row editing and undo. All temporary edits restored with table undo.
- Separate disposable stand: actual SQL snapshot cells resist typing and paste, source tint differs from manual cells, manual change recomputes DuckDB totals, Escape restores the grid and trigger focus. Stand stopped and disposable data removed.
- Independent reviews found and verified fixes for new-row visibility through pagination/filters, CSS specificity, and deletion of referenced columns.

### Follow-up: Open the selected column in a sidebar

Files: SqlTableHeader, SqlTableColumnEditor, BoardTableSurface, SqlTableView, related CSS and component tests.
- [x] Replace inline header renaming with a title button that opens that column and shows its selected state; keep sorting separate.
- [x] Convert the column editor to a nonmodal right panel with rename, SQL expression, type and aggregate controls; retain source-column restrictions and validation.
- [x] Float the panel outside canvas scaling in normal view and place it beside the grid in expanded view; preserve global agent access.
- [x] Preserve drafts when switching columns and clear the active draft on save or explicit cancel; retain grid identity and restore focus on explicit close.
- [x] Enforce one active editor per owning board, preserving the previous table's draft without restoring its focus; include the add-column entry point.
- [x] Verify column selection, sort isolation, draft switching across columns and tables, board independence, save/cancel, read-only rendering, keyboard focus and Escape handling.
- [x] Run the relevant automated checks and desktop verification against the integrated sidebar changes.

## Sidebar follow-up verification

- Focused checks: 4 files / 37 tests passed, including same-table and cross-table draft switching, expansion of another table, independent boards, sort isolation, source restrictions and Escape behavior. Cross-table regressions reproduced overlapping panels and a stale panel over another expanded table before the scoped coordination fix.
- TypeScript client/server and production build passed; the existing bundle-size notice remains. The full baseline suite was not repeated for this UI follow-up.
- Desktop checks on the main stand verified the selected column and expression, normal floating and expanded side-by-side layouts, draft restoration, cancel and Escape. The global agent button does not overlap editor actions. Cross-table exclusivity was verified by component tests using real AG Grid.
- Screenshot: `/private/tmp/miracle-column-sidebar.png`. Temporary name drafts were canceled and the stand returned to the board view.
