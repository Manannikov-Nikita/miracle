# Date range query execution

A SQL statement containing `{{date}}` gets a range-run button. The modal captures the current statement or selection and its tab/source, then asks for inclusive start/end, day/week/month granularity and extra retry attempts. The user explicitly chose calendar boundaries: weekly endpoints must be Mondays; monthly endpoints are first days (month picker). No implicit rounding or dates outside the selection.

The existing query-run API gains optional dateRange configuration. A single server-side run executes dates sequentially, occupying one concurrency slot and surviving browser/tab closure. Dates are ISO YYYY-MM-DD in UTC calendar arithmetic. A bare token becomes a quoted SQL literal; inside a single-quoted string it becomes date text. Tokens in comments/quoted identifiers do not activate the feature.

Each successful iteration appends to a stable aggregate result in one transaction with its progress update. Failed attempts add no rows; retries do not duplicate successes. After retries are exhausted, the run records that date's error and continues. At the end any failed dates make the run failed with an explicit partial-result summary. Storage quota or incompatible result columns stop the batch. Cancellation also retains accumulated data; restarting the server marks the run interrupted rather than replaying it automatically.

Limits stay per iteration (existing timeout/rows/bytes); accumulated storage uses the workspace quota. Maximum 10000 date iterations and 10 extra retries; UI default 2 retries. Compatible columns preserve position/type and first-result headers; differing expression names are compared after date normalization, while identical fixed aliases remain intact. Append respects existing fixed500-row SQLite chunks.

The results table refreshes on growing row count while retaining visible rows and page. Progress shows completed/total dates, current date/attempt, failures and stop action. In-progress aggregates cannot be pinned as immutable board snapshots. Once terminal, board sources retain range configuration so refresh replays the batch.

SQLite migration1→2 adds optional batch progress JSON. Backups preserve actual schema version, support existing version1 and new2, and reject unsupported/mismatched versions.

## Verification

Calendar/alignment/leap year/DST and substitution tests; retry/exhaustion/cancellation/restart/quotas/compatible columns; atomic append and pagination across499+2 rows; modal statement snapshot and validation; incremental rows/progress; board replay and active-snapshot guard; full regression/build and actual ClickHouse/Trino/browser checks.
