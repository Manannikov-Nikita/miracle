# SQL prevalidation in the editor

The user requests underlines and hover explanations for common SQL mistakes before execution, especially overwritten aliases and missing GROUP BY fields. This extends the existing ClickHouse/Trino SQL workspace; the board table experiment remains unchanged.

Use a local, conservative analyzer and Monaco markers. It runs after a 350 ms typing pause, follows the active model and selected dialect, and never executes SQL or prevents the user from running it. Reuse the existing scope-aware completion lexer. Mark duplicate projection aliases, likely ClickHouse source/alias shadowing, and ungrouped references in aggregate queries. Add other aggregate-placement checks only where the analyzer can establish the mistake. Messages explain a concrete correction in Russian; settings-dependent cases use warnings.

Do not infer unknown fields from incomplete metadata. Treat each SELECT/CTE/subquery/UNION branch independently; exclude strings and comments. Accept constants, grouped expressions/positions, aggregate combinators and window expressions correctly. Skip uncertain syntax rather than issue definite errors. Cap work for unusually large buffers and diagnostics count.

Considered server EXPLAIN validation and a new general SQL parser. Both add latency and dialect/server coupling. Local diagnostics fit the requested immediate feedback and existing lexer; this is preliminary checking, not complete server validation.

Preserve typing, cursor, undo, completion, formatting, query execution and agent edits. Clear this validator's markers on edits, model changes and disposal without changing other marker owners. Desktop browser verification must exercise a warning hover and its removal after correction.

Dialect references: [ClickHouse alias scope](https://clickhouse.com/docs/reference/syntax#notes-on-usage), [Trino grouping rules](https://trino.io/docs/current/sql/select.html#group-by-clause).
