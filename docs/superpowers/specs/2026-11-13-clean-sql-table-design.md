# Cleaner board tables

The user requests five changes: expand a table to its board area without a modal; protect and tint cells from a SQL snapshot; show only editable column names and sorting in headers; place add-column and add-row controls at the right and bottom edges; ask for a SQL expression in a large editor when adding a column.

Use the existing AG Grid, DuckDB expression evaluator, application tokens and SQL editor. A board-local surface preserves the rest of the application and agent access. A separate column editor keeps formulas, types and aggregates out of the header while retaining those existing capabilities. Do not add a new grid library or publish a release in this task.

Source protection applies to snapshot rows in source columns. Added columns and manual rows remain editable. Preserve older local cell overrides so existing documents do not lose work. Allow manual rows after a SQL snapshot, with distinct IDs, through sorting/filtering/pagination and calculation. New columns require a valid expression; expressions use the currently supported SQL subset. Editing existing manual columns may retain an empty expression. Column rename must preserve formula references.

Implementation choices: understated source-cell tint with a readable tooltip/legend, compact 36px headers, a board-local expansion with an explicit back button and Escape, and a large SQL expression editor using the already-installed editor. Keep stored data schema version and historical documents readable.

Alternatives considered: a larger modal still violates the requested board expansion; inline header editors retain the clutter the user explicitly rejects. The existing grid and a board-local surface satisfy the request without replacing the table engine.
