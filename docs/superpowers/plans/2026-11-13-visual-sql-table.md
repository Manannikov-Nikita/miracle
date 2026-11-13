# Visual SQL Table Implementation Plan

> **For agentic workers:** Use the existing release worktree; preserve unrelated changes. Implement disjoint ownership tasks with focused reviews, then integrated verification.

**Goal:** Add the approved DuckDB-backed editable table to board cards and existing SQL results.
**Architecture:** Persist bounded definitions through existing board revisions. Compile expressions to DuckDB SQL and display returned pages in AG Grid Community.
**Tech Stack:** TypeScript, React, Fastify, SQLite project storage, native DuckDB, AG Grid Community.
**Spec:** docs/superpowers/specs/2026-11-13-visual-sql-table-design.md

## Global Constraints
- Production worktree already contains accepted uncommitted UI changes; preserve them.
- No beta schema adoption; no writes to source databases; no remote publication.
- All calculations/filters/summaries in DuckDB; exact numeric values or explicit errors.
- Snapshot-bound row IDs; no silent reassociation after refresh; existing views retained.
- Desktop verification only.

## Review Focus
- Stale snapshot overrides after refresh and retention of referenced old snapshots.
- Unsafe numeric coercion and NULL semantics in formulas/aggregates.
- Input expressions reaching filesystem/network or multiple SQL statements.
- Out-of-order responses, board keyboard capture and save/undo interference.
- Native dependency presence in distributable archives and source result size limits.

### Task1: Shared model and execution engine
Files: create src/shared/visual-table.ts, src/shared/visual-table-formula.ts, src/server/visual-table.ts; tests/visual-table.test.ts.
Interfaces: exact shared/server contract in spec.
- [x] Write failing behavior tests for arithmetic and dependent overrides, exact decimal strings, NULLs, filters and full-source totals with paging, schema/identity checks and hostile expressions.
- [x] Implement schema/defaults/model helpers, expression parser/compiler and bounded native DuckDB execution.
- [x] Verify real engine tests and typecheck; report limits and resources.

### Task2: React table editor
Files: create src/client/board/SqlTableView.tsx, sql-table.css and focused helper/test files as necessary.
Interfaces: SqlTableView props and client evaluateVisualTable helper in spec.
- [x] Write meaningful UI/helper tests for formula commits, cell edits, renamed references and stale-response/read-only behavior.
- [x] Implement Community grid, inline headers/formulas, rows/columns, local overrides, aggregate/filter/sort controls, SQL view, errors and expanded editor.
- [x] Preserve parent-controlled state; stop board events; render presentations read-only.
- [x] Run targeted tests and typecheck.

### Task3: Board/API/release integration
Files: shared/types.ts, shared/board-schema.ts, server/app.ts, server/workspace-operations.ts, client/api.ts, board/ArtifactNode.tsx, ResultView.tsx, BoardWorkspace.tsx, canvas-tools.ts, CanvasToolPreview.tsx, clipboard.ts; package.json/lock, notices/docs; tests/visual-table-api.test.ts and board tests.
- [x] Write failing schema/API/retention and creation tests.
- [x] Add dependencies, authenticated evaluate endpoint and API helper.
- [x] Add new table kind/tool/drag preview and explicit formulas toggle for result cards; retain legacy table/chart view.
- [x] Retain old snapshot while overrides remain, expose explicit reset on changed snapshot, prevent focus/clipboard capture.
- [x] Verify board save/reopen and all supported states in desktop browser.
- [x] Run full tests/typecheck/build, notices and local native release-runtime smoke.

### Task4: Review and completion
- [x] Independent review of feature diff plus cross-component contracts, fix concrete defects.
- [x] Record final verification and remaining material limitations; leave test stand running for user.


## Final verification — 2026-11-13
- Final full suite: 214 files, 2824 tests passed.
- `npm run build`: both TypeScript projects, browser bundle and server compilation passed.
- Final darwin-arm64 archive rebuilt and installed in a disposable directory: bundled Node/DuckDB formulas, cell overrides and totals passed, together with the existing lifecycle/backup/restore smoke.
- Desktop browser: blank table creation, inline column names/formulas, cell edits, dependent recalculation, aggregates, filters, generated SQL, formula errors, Cmd+Z, expanded editor, focus transitions, close-with-pending-edit and persistence after reload verified.
- API integration: authentication/CSRF, immutable SQL snapshots, mismatches, board save/reopen and retention of an older referenced snapshot verified.
- Independent review findings fixed: numeric coercion, header focus; actual browser also found and verified the portal mount and native blur/focus fixes.
- Test stand remains at http://127.0.0.1:5183/, board «SQL-таблица — проверка». No release publication or changes to the user's installed runtime. Other native platforms were not exercised locally.
- Creation is offered on the board; copies on presentation slides are read-only. Graphs retain their existing snapshot/view behavior. Multi-cell rectangular paste and spreadsheet-style fill are outside this version.
