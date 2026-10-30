# Lazy introspection

Miracle must handle sources with thousands of objects. The Explorer groups objects by catalog/schema, loads the open scope first, and shares all metadata with SQL completion. Switching sources or hiding the Explorer must not discard metadata. An automatic background scan discovers tables and columns in unopened schemas for search.

## Approach

A workspace-owned in-memory metadata store holds independent connection entries. This replaces the two existing independent loaders. A persistent server cache would add storage/versioning without being needed for source-switch reuse; keeping the eager endpoint behind a UI grouping would still read the entire source before it becomes usable. The shared incremental store addresses both problems. Cache persistence across browser reload is outside this change.

New paged metadata endpoints enumerate schemas, schema tables, and schema columns. A table filter supports direct foreground lookups for editor references. Keyset pagination avoids the existing whole-source 50,000-row ceiling. Trino retains the configured catalog scope; ClickHouse databases are schemas.

Foreground requests share a deduplicating priority queue with the background scanner. At most three requests run, of which at most one is background. A small delay between background pages leaves capacity for interaction. Selecting a source starts its scan; switching away keeps its accumulated data and background work. No eager work is started for sources the user never selects.

Refresh/edit/delete abort and invalidate the relevant generation, including password-only edits. Late responses cannot publish stale metadata. The store is disposed on workspace change. Failures are visible per scope, other scopes continue, and retry is explicit.

The Explorer retains expanded nodes per source, bounds visible rows, and searches schema/table/column names. Search is progressive and shows when indexing is incomplete. Completion reuses available data immediately, prioritizes SQL reference scopes and columns, suggests schemas before tables are loaded, and retains the existing 300ms responsiveness deadline.

## Verification

Test pagination and quoting on both engines; cache reuse, shared requests, foreground priority, background unopened columns, empty scopes, partial failure and invalidation races; UI switching, search and bounded DOM; editor schema/alias completion and bounded prefix results. Run the full suite/build and real connector/browser checks when local fixtures are available.
