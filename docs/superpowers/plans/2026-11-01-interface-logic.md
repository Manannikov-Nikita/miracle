# Interface Logic Implementation Plan

**Goal:** Make Miracle controls compact, understandable and consistently placed across its existing interfaces.
**Architecture:** Preserve current React components and data contracts; use Phosphor icons and Radix semantics, with scoped CSS adjustments.
**Spec:** ../specs/2026-11-01-interface-logic-design.md

## Tasks and ownership

- [x] Parent: WorkspaceRail, Explorer, SqlWorkspace, ResultTable, global styles.css. Correct connection cues/filter states; combine result add/drag; move SQL layout reset to menu; suppress useless pagination; normalize control sizes and integrate connection-form styles. Test explorer, result table, SQL/date-batch, workspace panes.
- [x] Board worker: board components/CSS only. Toolbar deduplication, accurate node icons, rule action layout, pagination, source/appearance grouping and connection editor. Run board inspector, table, chart and interaction checks; preserve read-only, undo, focus and dimensions.
- [x] Connection worker: Connections and connection option TSX/tests only. Engine display vs choice, row actions, footer groups and busy behavior; send CSS needs to parent. Run connection option/form checks.
- [x] Chat worker: agents components/CSS/tests only. Selected-profile settings, distinct creation, busy form lock, delete confirmation, correct composer menu, readable metadata. Add behavioral regression tests; run agent UI tests.
- [x] Parent: independent final review, full suite and build, real browser checks at normal and narrow panes, screenshots and result report.

## Review focus

- Removed duplicate controls must leave their action accessible by pointer and keyboard.
- Menus/dialogs must restore focus and not swallow unrelated editor/board shortcuts.
- Single-page pagination stays hidden, but a shrinking result must retain a route back from a later page.
- Async form replies cannot apply to another selected profile or connection.
- All icon actions have accurate names and no accidental submit semantics.

User authorization and existing design direction are sufficient to proceed. No further approval is needed for these reversible interface changes. Existing Soft Graphite changes remain intact.


## Verification results

- Full final suite: 77 files / 853 tests passed (`.local/soft-graphite/ux-final-tests.log`). Eighteen new regression tests cover per-explorer search, result pagination, board settings/navigation, connection forms, profile selection/deletion and pending dialog dismissal.
- Final `npm run build` passes, including both TypeScript projects; pre-existing Vite large-chunk warning remains (`.local/soft-graphite/ux-final-build.log`).
- Independent review found a profile operation lock could be bypassed by closing its parent dialog. Fixed and verified all four dismissal routes, late errors and reopening. Final review found no new actionable defects.
- Browser: SQL toolbar fits a 340 px pane; menu contains local layout reset; result has one add/drag action; single-page pagination omitted; inspector restores focus; source/appearance grouped; connection engine is static in edit mode and footer remains visible in expanded TLS form. No SQL execution or saved connection/profile/data changes during this verification.
- Browser found native autofocus could scroll the outer chat panel and clip the settings header. Outer containers now clip instead of scroll, leaving scrolling to transcript/settings body. Rechecked normal size and 960×640: outer scrollTop remains zero, header visible, body scrolls to save control. Temporary viewport override reset.
- Browser error log empty. Screenshot artifacts: `miracle-ux-overview.jpg`, `miracle-ux-inspector.jpg`, `miracle-ux-connections.jpg` in this task's visualization directory.
- Also removed the redundant static SQL saved footer; its layout reset action remains in SQL menu. Existing working-directory changes are uncommitted on `codex/soft-graphite`.
