# Board Drag Performance Implementation Plan

> **For agentic workers:** Execute the independently owned tasks in parallel, then review the complete change and verify it in Browser.

**Goal:** Keep large-board dragging responsive without losing saved changes, undo history, resizing, or remote-update protection.

**Architecture:** Preserve unchanged node identities through the controlled React Flow adapter, stabilize card action context and component rendering, and coalesce local draft persistence during gestures. Keep alignment semantics unchanged in this pass: Browser measurements put snapping near 0.1 ms while React commits peaked at 19–23 ms.

**Tech Stack:** React 19, XYFlow 12, TypeScript, Vitest, localStorage, existing board API.

**Spec:** User-approved optimization following the UK-board Browser diagnosis in this chat. Evidence: `.local/release-0.7.0/drag-diagnostics/browser-probes.json`.

## Global Constraints

- Use the existing release checkout and local demo server; do not alter unrelated project data.
- Test UI changes with Browser.
- Preserve one undo entry per drag and the latest complete draft across navigation, lifecycle flushes, save acknowledgements, and conflicts.
- Preserve resize handles, multi-selection, duplicate dragging, live source refresh, and table/chart settings updates.
- Do not introduce dependencies or change snapping behavior based on an unmeasured hypothesis.

## Review Focus

- Stable callbacks must see current board/selection/refresh state, not stale closures.
- A queued draft must never resurrect a saved or deleted stale document.
- Unchanged nodes must remain stable while selected state, dimensions, and data edits still propagate.
- Remote updates and in-flight saves must retain revision/conflict safeguards.
- Navigation and zoom must update controls correctly while avoiding unnecessary card content work.

### Task 1: Preserve flow-node identity

**Files:** `src/client/board/flow-nodes.ts`, `src/client/board/edge-flow.ts` if needed; focused board flow tests.

- [x] Add failing behavior tests for unchanged nodes during position/selection/dimension changes and adapter reuse.
- [x] Preserve untouched BoardNode references; reuse adapted nodes for unchanged immutable input and selected state.
- [x] Verify additions/removals/resizes/free-edge anchors with existing tests.

### Task 2: Coalesce gesture draft writes

**Files:** `src/client/board/useBoard.ts`, a small draft helper only if useful, focused hook tests.

**Interface:** Keep existing `change(document, record?)` behavior compatible; if an explicit gesture/defer option is needed, expose it as an optional argument and report the contract for Workspace integration.

- [x] Add failing tests proving a burst of gesture changes does not write the whole draft each time, and that the newest state survives flush/board switch/unmount.
- [x] Coalesce pending local persistence, flush at completion/lifecycle boundaries, and cancel stale writes after save/reload/removal.
- [x] Avoid repeated source serialization for unchanged source references; retain semantic equality and revision checks.
- [x] Verify undo/redo, save events, source revision changes, and conflicts.

### Task 3: Stabilize card rendering

**Files:** `src/client/board/BoardWorkspace.tsx`, `src/client/board/ArtifactNode.tsx`, focused render/integration tests.

- [x] Add a failing render regression that moving one node does not rerender another card's content; also prove updated actions/data are observed.
- [x] Stabilize action callbacks and provider value, memoize card rendering at the relevant props boundary, subscribe to zoom rather than whole viewport where appropriate.
- [x] Integrate any explicit gesture persistence boundary from Task 2.
- [x] Verify selection, resize, inspector, busy state, and current-board actions.

### Task 4: Review and measured validation

- [x] Run focused tests, complete test suite, and production build.
- [x] Independently review changes for stale closures, lifecycle races, and lost edits.
- [x] Repeat the same temporary Browser profiling on the UK board, undo test movements, and remove all instrumentation.
- [x] Record before/after measurements and final verification; leave the demo ready for testing.

## Verification results

- Full suite: 135 files, 1,709 tests passed on Node 24. The sandbox-only attempt could not bind local test HTTP ports (`listen EPERM`); the permitted run passed.
- Production build passed. Existing bundle-size and dependency annotation warnings remain.
- Independent review found no actionable regression in callbacks, node identity, or draft lifecycle handling.
- Browser on the UK board (30 blocks): two drag probes before/after. Total React render work fell from 117.7/150.0 ms to 38.6/39.5 ms (71% across the two probes); maximum render duration fell from 19.1/22.7 ms to 5.5/5.8 ms. Snapping median remained 0.1 ms. These are local development measurements, not an FPS guarantee.
- Browser checks: drag undo restored exact original position in one step; resize updated the chart canvas and undo restored its dimensions; zoom kept resize handles at a stable screen size. Test movements and resize were undone. After reloading, the board reported saved and retained the exact restored geometry; no browser errors were logged.
- Temporary profiling code removed; implementation files restored byte-for-byte from pre-profiling backups.
- Local evidence: `.local/release-0.7.0/drag-diagnostics/browser-probes{,-after}.json`, `tests-allowed.log`, `build.log`.
