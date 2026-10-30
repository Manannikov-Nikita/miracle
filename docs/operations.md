# Miracle operations

Miracle is a personal local service, with SQLite workspace storage and external ClickHouse/Trino analytical sources. Released packages include Node.js. PostgreSQL, Docker and account administration are not runtime dependencies.

## Access and lifecycle

The API binds to 127.0.0.1, port 3001 by default. Host, Origin, browser-session and CSRF checks protect local data. This edition is not designed for remote hosting; do not expose it through a public reverse proxy.

`miracle` opens the browser and starts the background service if needed. `miracle stop` authenticates to that exact instance and shuts it down gracefully. A stale PID never authorizes killing another process. `miracle serve` runs in the foreground. No login autostart is installed.

One process owns a workspace's SQLite connection exclusively. Ownership is acquired before migration or interrupted-run recovery. After a crash, unfinished runs become interrupted and are not automatically replayed.

## Data and limits

The data directory contains miracle.sqlite and encryption.key. Connection passwords and private TLS material are encrypted. Startup checks their key/database pairing; existing data with a missing/wrong key must not be reinitialized.

Transactions and foreign keys preserve snapshots and board references. Versioned migrations reject unsupported newer schemas. Workspace UUIDs separate browser drafts/settings; revisions protect multiple tabs.

Default limits: 120 seconds, 50,000 rows or 20 MiB per result, two concurrent runs, 2 GiB result quota. Unreferenced results expire after 24 hours; completed history after 30 days. Board-referenced snapshots remain. Failed refreshes preserve previous results.

## Backup and maintenance

Stop before `miracle backup DIRECTORY`. It creates a portable directory with a consistent SQLite snapshot, matching key and manifest. Never copy only a live database while WAL may contain data.

`miracle restore DIRECTORY --data-dir NEW_DIRECTORY` validates the copy and refuses a nonempty destination. Keep the original backup until verification. Backups contain private credentials. Browser SQL drafts require separate export.

Before upgrades: stop, back up, rerun installer. Versioned code is separate from data. Never discard the encryption key to recover from a startup error. There is no PostgreSQL import in 0.2.0; old Docker volumes remain untouched.

## Development and source connections

See [CONTRIBUTING.md](../CONTRIBUTING.md). API tests use temporary SQLite directories. Real ClickHouse/Trino integration is separate and may use optional Compose fixtures.

Use dedicated read-only database users. Miracle's SQL validation supplements source permissions. Native connections use normal host addresses; same-machine sources use 127.0.0.1.

[.env.example](../.env.example) lists development overrides: MIRACLE_DATA_DIR, PORT and APP_ORIGIN for the Vite proxy. Released CLI startup supplies the exact listener origin. Never put passwords, keys or control tokens in Git, URLs or public diagnostics.
