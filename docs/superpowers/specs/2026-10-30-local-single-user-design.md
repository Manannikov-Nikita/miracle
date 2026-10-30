# Miracle: local, single-user edition

## Intent and agreed scope

Miracle is a personal SQL workspace and board served to the user's browser by one local process. Installation must not require PostgreSQL, Docker, Node.js, npm, Git, or a compiler. The user confirmed a **clean installation with no migration of existing PostgreSQL data**, and support for **macOS, Linux, and Windows**. Existing installations/data must be left untouched.

Preserve SQL editing, real ClickHouse/Trino connections, TLS options, saved queries, history, immutable result snapshots, boards, tables, and charts. Remove accounts, login/setup forms, passwords for Miracle itself, invitations, roles, team management, and shared/team messaging. Remote database credentials remain encrypted.

## Delivery approach

Use platform-specific GitHub release archives containing compiled web/server code, a pinned Node 24 runtime, production dependencies, launchers and license notices. This keeps the existing Fastify/React/ESM stack. A shell installer downloads and verifies a fixed-version release for macOS/Linux; a PowerShell equivalent does so on Windows. Homebrew/WinGet can later distribute these same artifacts; adding those registries is out of this change. A single executable bundler is unnecessary and introduces additional module/asset compatibility work.

Targets: darwin arm64/x64, GNU/Linux arm64/x64, Windows x64. Reject unsupported OS/architecture/libc with an actionable error. Windows ARM native support and automatic login startup are not promised. Pin Node 24.22.2 and verify upstream SHA-256 before packaging; include its license. Test artifacts on native runners for supported targets.

Primary future command, only advertised as usable after an actual release contains the installer:

```sh
curl -fsSL https://github.com/Manannikov-Nikita/miracle/releases/latest/download/install.sh | sh
miracle
```

Install per OS user, without elevation. Store versioned code separately from data and atomically activate a validated version through a text `current-version` pointer. Root: `~/Library/Application Support/Miracle` on macOS, `${XDG_DATA_HOME:-~/.local/share}/miracle` on Linux, `%LOCALAPPDATA%/Miracle` on Windows. Keep data in `data/`, code in `versions/X.Y.Z/`, logs in `logs/`; Unix launcher is `~/.local/bin/miracle`, Windows launcher is `<root>/bin/miracle.cmd`. PATH guidance must be explicit; do not edit arbitrary shell profiles. Support an installation-root override for tests/manual installs. Reinstall preserves data, requires the app stopped before changing active version, and does not overwrite an already installed version's files.

## Storage and process model

One `miracle.sqlite` in the data directory, using built-in `node:sqlite`, prepared statements and synchronous transactions. UUIDs/JSON are explicitly serialized; timestamps are consistently converted at the storage boundary. Use versioned SQLite schema migrations, foreign keys, WAL and full synchronization. Remove PostgreSQL SQL/types/error handling, account tables and query ownership. No synthetic admin account. Limit to two concurrent query runs while preserving existing timeout/result/quota/retention behavior.

Hold an exclusive SQLite connection for the application's lifetime. Force acquisition before migrations, key verification or interrupted-run recovery. A second process must fail without touching the first's queries; process death releases the lock. Keep optimistic revisions because one person can use multiple browser tabs.

Create a private `encryption.key` only for a genuinely empty new workspace; refuse existing data with a missing/wrong key. Persist a workspace UUID in settings for browser-storage namespacing. SQL drafts remain in the browser, with the existing export capability; clean installation does not import old per-account drafts.

Backup is a portable directory containing a consistent SQLite snapshot, matching key and a format/schema manifest. Backup and restore require the workspace stopped. Restore validates all files and the key/database pairing in staging and refuses a nonempty destination. No live WAL copying, destructive restore, old PostgreSQL import or dual backend.

## Local HTTP and frontend contracts

Bind `127.0.0.1`, default port `3001`, configurable port. Validate the exact configured Host, supplied Origin and cross-site Fetch Metadata; no CORS. Development uses the existing Vite proxy with an explicit local origin. Browser access requires no username/password.

`GET /api/session` creates/reuses a single in-memory opaque local session pair for the server instance and returns `{ workspaceId: string, csrfToken: string }`. Concurrent tab bootstraps share the same pair; expiry rotates it synchronously. Cookie: HttpOnly, SameSite=Strict, host-only. Other data endpoints require that session; writes require CSRF. Session expiry/restart triggers one safe handshake retry rather than a login page. Retry only HTTP 401 or explicit HTTP 403 `LOCAL_SESSION_STALE`, which is returned before execution when a dormant tab supplies a stale token alongside another tab's refreshed cookie. Generic 403, workspace mismatch and ambiguous network failures are never replayed.

The browser pins workspaceId and sends `X-Miracle-Workspace` on content requests. A mismatching supplied header is rejected before execution with HTTP 409 and code `WORKSPACE_CHANGED`. The client keeps drafts/UI and blocks further actions until reload. Session/health/control routes are exempt. This also protects an older tab when another tab has already installed a different workspace's valid cookie.

Remove `/api/auth/*`, `/api/setup/*`, `/api/users/*` and corresponding shared `User`/`Role` types. Existing content endpoint payloads retain their shape, minus user ownership. All editing actions are available to the local user. Namespaced browser keys use workspaceId instead of userId. Preserve stale-revision conflicts and local draft recovery, changing team/another-user wording to another tab/version.

CLI control uses `POST /api/local/control`, `Authorization: Bearer <private instance token>`, JSON `{ action: 'status' | 'stop' }`, returning `{ ok: true }`. It is independent of browser sessions/CSRF but still validates Host/Origin. A stop schedules graceful closure after sending the response, cancelling remote queries and closing SQLite. Tokens are never in URLs/logs/backups. The CLI never kills a PID merely because it appears in a state file.

## Runtime interfaces and commands

`buildApp` accepts existing test/connector options plus `dataDir?: string`, `appOrigin?: string`, `controlToken?: string`, `onShutdown?: () => void`; remove `databaseUrl`. `resolveDataDir(env?: NodeJS.ProcessEnv): string` and `resolvePort(env?: NodeJS.ProcessEnv): number` live in server config. Overrides are `MIRACLE_DATA_DIR` and `PORT`. Server index consumes `MIRACLE_CONTROL_TOKEN` and installs signal/graceful-shutdown handlers. Static assets resolve relative to the package, never cwd.

Server maintenance exports `backupWorkspace(dataDir: string, destination: string): Promise<void>` and `restoreWorkspace(source: string, dataDir: string): Promise<void>` from `src/server/maintenance.ts`.

One Node CLI, thin shell/cmd launchers:

- `miracle` / `miracle open`: ensure a background service, open browser, always print URL.
- `start [--port N] [--data-dir PATH]`: idempotent, detached, redirected logs, authenticated readiness; occupied port fails clearly.
- `serve`: foreground service for tests/service managers, no autostart registration.
- `stop`: authenticated graceful stop and wait; never kill an unrelated process.
- `status [--json]`: explicit running/stopped/error status and instance information.
- `backup DIRECTORY` / `restore DIRECTORY`: call storage maintenance while stopped.
- `--version` / `--help`: no service required.

Private runtime state is written only after authenticated readiness and includes instance token, port, PID, data directory and version. On restart, stale state is verified through the control endpoint; never trusted by PID alone. Control checks distinguish running, stopped and unknown: timeout/authentication/malformed-response failures preserve state and fail closed. Stop success requires listener closure and workspace-lock release. There is no separate automatic updater: rerunning the versioned installer while stopped performs installation/update safely.

## Acceptance and release boundaries

API and storage tests use temporary SQLite directories without PostgreSQL. Verify real two-process exclusion, abrupt exit/restart, encrypted secrets and missing/wrong key, persistence, JSON round trips, atomic snapshots/references, quota/cancellation and stale revisions. UI opens directly, edits sources/queries/boards and reconnects after restart with no account/team controls. Preserve all existing analytical rendering tests.

Run packaged-app lifecycle/install tests from unrelated directories and paths with spaces/Unicode; test repeat install, invalid checksum/download, occupied port, duplicate start, backup/restore and missing key. Native CI must launch bundled Node rather than the system runtime. Keep external ClickHouse/Trino integration coverage distinct from self-contained tests.

Update installation, usage, operation, contribution, security and release documentation consistently. Build and verify a local native archive before calling implementation complete. A live GitHub installation URL requires publishing release assets; do not claim an unpublished URL works. Publication is separate from local implementation and verification.
