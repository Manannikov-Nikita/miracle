# Local projects and agents — verification

Implementation branch: `codex/local-project-agents`. Base `main` was verified against the remote repository at `8be0d5e3a7f0a4cbe92c0fbb032401654171bb5f` before implementation. No release is published by this change.

## Provider verification

A real installed Codex CLI (`0.165.0-alpha.1.2`, bundled in ChatGPT.app) completed a two-turn scenario in a disposable project with the user's existing CLI authorization:

- Read project instructions and a local file, then wrote a new local file.
- Read project/target context through Miracle MCP and changed the SQL editor with a revision check.
- Executed `SELECT 42 AS answer` against the local ClickHouse test container and read the result.
- Created a note on the target board and moved it to `(120, 80)`.
- Continued the saved native session in a second turn and reread the same editor and board without rerunning SQL.

The command used workspace-write sandboxing and on-request approvals. Global CLI configuration was unchanged. The older Homebrew Codex `0.136.0` cannot load the user's `ultra` setting or run the account's current model; errors are reported in the chat rather than silently changing configuration. Select a compatible installed binary and command in the profile.

At the user's explicit request, real Claude CLI testing is omitted. Claude remains supported and its command, stream, permission callback, continuation, failure and process cancellation contracts are checked with deterministic subprocess fixtures. This does not claim verification against an installed Claude binary.

## Automated and installation checks

Final checks on 2026-10-31 after the integration corrections: Tests exercise real SQLite, subprocess protocol streams and HTTP endpoints. The existing external integration suite uses actual local ClickHouse and Trino containers. The installation smoke builds a private local archive with pinned Node24 and runs it without system Node on PATH.

| Check | Result |
| --- | --- |
| `npm test` | 58 files, 723 tests passed |
| `npm run typecheck` | Passed; also executed inside final build |
| `npm run build` | Passed; existing large-bundle advisory remains |
| `npm run test:integration` | 11 groups passed against SQLite, ClickHouse and Trino |
| `npm run test:install -- <local archive>` | Passed on macOS arm64 with bundled Node24 and no system Node on PATH |
| Browser | 320, 768, 1024 and 1440 px; no horizontal overflow or fresh console errors |
| Independent code review | No open actionable findings after corrections |

Browser verification covered both approval stages, persisted resolved labels, closing/reopening the panel without cancellation, streamed messages, real Monaco cursor preservation and undo, rapid typing, simultaneous local/remote changes and recovery-copy creation. A clean external board edit and one undo persisted as consecutive revisions; a competing viewport save produced the expected protected draft conflict.

Installation verification covered default project `.miracle`, OS-assigned ports, two projects, live reinstall stopping both authenticated servers, explicit legacy storage, private state, persisted corporate CA, and backup/restore. Sequential and concurrent attempts to run the same project with different storage directories are rejected.

The review added regression coverage for stale deletes, resolved permission events, development MCP proxying, recovery of editor settings, delayed chat-state responses, interrupted turns, missing native sessions, copied profile trust and oversized MCP documents.

## Boundaries

Backups include Miracle state, editor documents and conversations. Project files and provider-native session storage remain separate. Copied profiles require local confirmation. Windows support is through WSL; this verification ran on macOS. Claude's real execution is intentionally unverified as described above.

## NYC Taxi demo: real agent regression check

On 2026-10-31, the actual Codex profile was exercised through the Miracle chat on the local NYC Taxi demo (1,000,660 ClickHouse rows). The first attempt exposed a protocol bug: a helper's `turn/completed` notification prematurely completed the parent Miracle turn and stopped its CLI process. The editor and saved query had been written, but execution, board changes and the local SQL file were unfinished.

The adapter now accepts text, action, error and completion notifications only for its own thread and the turn returned by `turn/start`. Notifications arriving before that response are buffered. Helper approval requests still reach the user. Three deterministic regressions failed before the fix and passed after it; independent review also checked the installed CLI's generated protocol types and early completion/error delivery.

After rebuilding and restarting the demo server, the same native Codex session continued successfully:

- Read project instructions and the dataset manifest with native file tools; read the schema and saved application state through Miracle MCP.
- Spawned and waited for another helper, then continued the parent task after the helper completed.
- Executed and read the monthly aggregation: July 192,802 trips / 16.07 USD average; August 557,407 / 16.36; September 250,451 / 16.43. Counts sum to the manifest's 1,000,660 rows and match an independent ClickHouse query.
- Created `sql/agent-monthly.sql`, matching the editor and saved query, and added a result table plus a note beneath the original six board blocks without duplicates.
- Continued while the browser tab was closed; reopening restored the conversation and board changes.
- A separate cancellation test stopped the turn's CLI and its sleeping Python child. Other Codex processes, Miracle and ClickHouse remained running; the dataset count was unchanged.

Fresh checks after this fix: **58 test files / 726 tests passed**, typecheck and production build passed, and `git diff --check` passed. The full HTTP/process test suite was run with local networking permitted. The build retains the existing large-bundle advisory. Real Claude execution remains intentionally untested.

Cancellation preserves the action event log: an interrupted command can retain its last `started/inProgress` entry, while the enclosing turn is correctly `cancelled` and no owned process remains.

Observed UI limitation: an MCP query result is available in history and on the board, but `run_query` does not automatically attach it to the SQL editor's result pane. The editor's text and the query's result are persisted independently; the demo therefore shows the agent's monthly result on its board table.
