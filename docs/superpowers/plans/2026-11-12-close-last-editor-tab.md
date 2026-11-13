# Closing the last editor tab

**Goal:** Closing every editor tab collapses its pane. Reopening an empty editor creates one new SQL tab. No empty-state screen.

**Design:** App passes the actual pane visibility to the mounted editor. Synchronization supports an empty document list without automatically creating replacements. The editor handles zero SQL tabs and text-only file tabs, collapses only when all documents are closed, and creates a blank tab only when an empty pane is explicitly opened (or initially visible). Opening a requested file/query/source opens that target without an extra blank tab. Manual pane collapse preserves existing documents.

**Constraints:** Preserve dirty-file confirmation, running-query and agent locks, synchronization failures and current file/board changes. Keep the editor mounted while hidden for project sync and registered file operations. No schema or dependency changes; Node24 and desktop checks.

- [x] Add editor lifecycle regressions: final SQL/file close, text-only editor, cancellation/failure, empty reopen and explicit target reopen.
- [x] Remove automatic replacement tabs; implement empty-safe state and pane lifecycle.
- [x] Pass actual pane visibility from App; extend pane tests to verify it across toggles and requested opens.
- [x] Review race handling and run focused tests, full suite and production build.
- [x] Verify desktop close/reopen, update usage and leave the test environment running.

Desktop verification: closing the sole SQL tab collapses the pane; reopening creates exactly one fresh tab. Closing SQL while a text file remains keeps the file visible. Manual collapse/reopen preserves the file. Closing the final text file collapses the pane, and opening it directly from Explorer creates no SQL placeholder. No browser console errors.

Final validation (Node24): 115 focused tests; all 2,706 tests across 208 files; production build and typecheck; `git diff --check`. Independent review clean after fixing a delayed-close/same-target-open race. Test/build logs: `/tmp/miracle-editor-collapse-final-tests.log`, `/tmp/miracle-editor-collapse-final-build.log`.
