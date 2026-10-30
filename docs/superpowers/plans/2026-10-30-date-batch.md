# Date range execution implementation plan

**Goal:** Run parameterized SQL over calendar dates with retries, progress and a growing result table.
**Architecture:** Extend existing query runs and source configuration; sequential server worker plus incremental SQLite aggregate; dedicated modal/progress UI.
**Spec:** docs/superpowers/specs/2026-10-30-date-batch-design.md

## Constraints

Keep prior uncommitted introspection changes. Weeks accept only Mondays and months only first days, per user decision. All ordinary SQL flows remain unchanged. Failed attempts never append; cancellation preserves successful results. No dependencies added.

## Tasks

- [x] Shared dates/template helpers and DTOs; calendar edge cases and quoting regression tests first.
- [x] SQLite migration and version-compatible backup/restore; preserve existing data and key.
- [x] Server batch runner under one query slot, per-attempt timeout/retry, atomic append, quotas/schema checks, recovery and board guards; API tests.
- [x] Modal/button/current-statement detection, persisted range source, incremental table and progress/cancel/errors; UI tests.
- [x] Integrated tests/build/real connectors/browser, independent review and fixes.

## Verification

567 tests across 42 files passed; client/server build passed. Real SQLite + ClickHouse + Trino integration passed all 11 groups, including inclusive daily ranges, leap day, calendar weeks/months and aggregate rows. Browser checks covered native calendar controls, live rows, active-run recovery after reload, cancellation preserving 12 rows, an exhausted retry followed by the next successful date, and ordinary SQL after a batch.

Independent review fixes include literal column aliases, retention after long batches/restart, transient result-loading failures and failed page fetches. Browser review added an explicit previous-result label and removed duplicate partial-result notices. Prior introspection changes remain in the same working copy.
