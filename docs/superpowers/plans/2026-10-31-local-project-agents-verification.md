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
