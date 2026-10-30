# Local single-user Miracle implementation plan

**Goal:** Ship a local personal workspace with SQLite and native GitHub installers.
**Architecture:** Keep React/Fastify; replace PostgreSQL/account ownership with one exclusive SQLite workspace and local browser sessions. Bundle Node with compiled code for distribution.
**Spec:** `docs/superpowers/specs/2026-10-30-local-single-user-design.md`.

## Global constraints

- Clean installation; no PostgreSQL migration and no changes to existing installations.
- macOS/Linux arm64+x64; Windows uses the Linux edition inside WSL 2. Publish four `.tar.gz` archives, their checksums and one `install.sh`. No external runtime, Docker or database dependency inside the prepared environment.
- Keep installation/data in the WSL Linux filesystem rather than `/mnt/c`; run commands in the same distribution and open the exact printed loopback URL in a Windows browser.
- User data and encryption key survive restart/reinstall; only loopback access; no accounts/roles/invites.
- Preserve all SQL, connector/TLS, snapshot, board/chart/table features and multi-tab revision protection.
- Follow the spec's `/api/session`, `/api/local/control`, config and maintenance interfaces exactly.
- Use CodeGraph first for code discovery; native git is `/Library/Developer/CommandLineTools/usr/bin/git` in this environment.

## Review focus

- A second process or crash must never interrupt another live workspace's query runs.
- Removing login must not expose local data to cross-origin pages or unvalidated Hosts.
- SQLite JSON/timestamp and transaction changes must preserve snapshots, quotas, references and revisions.
- Installed binaries must work with no system Node, from arbitrary cwd and Unicode paths.
- Failed setup/restore/update must preserve data and its encryption key.

## Task 1: SQLite server and local sessions

Own `src/server/**` except `cli.ts`, shared types read-only; own server/API/storage/TLS tests and integration scripts. New maintenance module belongs here. Other implementers own frontend and installers.

- [x] Add failing temporary-workspace API tests: direct local session, content CRUD without accounts, restart persistence, Host/Origin/CSRF rejection, removed account routes.
- [x] Replace PostgreSQL storage with SQLite and versioned migrations. Explicitly decode JSON/timestamps and keep transactional admission/snapshot/reference operations synchronous.
- [x] Add real subprocess tests for exclusive ownership and abrupt-exit recovery; acquire ownership before any recovery writes.
- [x] Preserve key validation and add new-empty/missing-key/wrong-key tests. Implement paired backup/restore directory helpers and behavioral tests for active workspace/nonempty target/corruption.
- [x] Replace account routes/need checks with local sessions and workspaceId; expose authenticated control status/stop. Unify concurrency at two queries.
- [x] Update index/config for loopback startup, bundled-relative assets, env overrides and graceful signals. Implement spec exports used by the CLI.
- [x] Convert PostgreSQL-dependent tests to SQLite; preserve connector/TLS, quota, cancellation, revision and result-reference coverage.
- [x] Verify focused server tests and server TypeScript; report pending cross-task compilation issues explicitly.

## Task 2: Personal frontend

Own `src/client/**`, `src/shared/types.ts`, and frontend tests. Do not edit backend or packaging.

- [x] Add failing UI tests for direct workspace opening and recovery after local-session expiry; API contract is `GET /api/session -> { workspaceId, csrfToken }`.
- [x] Remove login/setup/team screens, profile/logout/role UI and all permission branches. Replace User props with workspaceId only where persistence needs it; remove User/Role types.
- [x] Namespace browser drafts/view/layout/selected connection/board by workspaceId. Preserve draft recovery, SQL source tabs, snapshots and multi-tab revisions.
- [x] Make API helper refresh local session once on an explicit pre-execution unauthorized rejection. Preserve error handling and never retry ambiguous network errors.
- [x] Replace team/other-user wording with personal workspace/tab wording; keep established visual design.
- [x] Run focused frontend tests and client TypeScript; report integration dependencies.

## Task 3: Native CLI and distribution

Own `src/server/cli.ts`, new launcher modules (not backend-owned config/maintenance), `release/**`, `scripts/**`, `.github/workflows/**`, manifests/lockfile, Docker/compose removal/replacement, installer/CLI/release tests. Documentation is owned by coordinator. Read config/maintenance contracts from spec.

- [x] Write failing CLI subprocess tests for start/status/stop/restart, occupied port, paths with spaces, no system runtime and private state. Use a real app after backend becomes available.
- [x] Implement spec CLI commands. Start a bundled-node child with private token, verify authenticated readiness, persist state; never kill by PID. Call backend maintenance for backup/restore.
- [x] Reduce production dependencies to actual server imports; move browser/build packages to devDependencies, remove PostgreSQL/password-hashing deps and obsolete scripts. Keep full development build dependency installation.
- [x] Replace the Docker release with four allowlisted macOS/Linux `.tar.gz` archives and verified Node 24.22.2 runtime; include licenses and checksums. No local keys/data/env files in payload.
- [x] Implement one fixed-version shell installer for macOS/Linux/WSL 2, OS/arch detection, SHA-256 verification, staged extraction/activation and non-destructive repeat installation. Include manual-download support and PATH instructions.
- [x] Add behavioral installer tests (not source-text assertions) covering download/hash/extraction failure and preserved prior installation/data. Replace obsolete Docker distribution tests.
- [x] Update CI to self-contained API tests plus native archive smoke on the four macOS/Linux targets; retain optional real connector integration.
- [x] Verify release bundle locally on macOS arm64. Do not publish without coordinator release decision.

## Task 4: Integration, review and documentation

Coordinator owns design/plan/ledger, human docs, integration verification and final review.

- [x] Record baseline results and task/interface ownership; never overwrite another implementer's changes.
- [x] Rewrite README/install/usage/operations/contribution/security/release docs around clean single-user setup and actual commands, explicitly distinguishing unpublished installer from a live release.
- [x] Run `npm test`, `npm run build`, integration available locally, `git diff --check` and native archive smoke. Diagnose and repair failures; do not silently drop useful tests.
- [x] Inspect browser with real local app: no signup, create/edit source, query/history/board flow, restart and multiple tabs.
- [x] Independent review of final diff, especially local request security, SQLite locking, installer integrity and data preservation. Fix material findings and rerun affected tests.
- [x] Report verified behavior, available local artifacts and any platform/remote integration checks left to CI. Publish only after the concrete release has passed its applicable checks and publication is authorized.

## Windows scope update

The user's latest requirement replaces native-Windows delivery with WSL 2. The current spec supersedes the earlier installer/archive approach. Existing verification of other targets remains evidence for those targets only.

- [x] Remove native-Windows packaging paths and keep four macOS/Linux archives plus `install.sh`.
- [x] Verify WSL CLI guidance: print the exact loopback URL for a Windows browser without requiring Linux GUI tools.
- [x] Update current installation, operations and release docs for the Linux installer inside WSL 2; preserve unpublished-release and no-PostgreSQL-import statements.
- [ ] Verify WSL 2 networking and Windows-browser access on an actual Windows/WSL host; report as not run while no such host is available. Linux native CI does not replace this check.
