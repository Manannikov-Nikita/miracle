# Editable SQL tables on the board

Approved direction: the user accepted the working AG Grid / DuckDB prototype and asked to add it to Miracle. Formula inputs belong directly below column names. Local edits to individual cells are required, including overrides of calculated values. This document records that decision; no new approval gate is needed.

## Behavior
- Add a blank Table from the floating board toolbar, by click or drag. Start with three editable columns and five empty rows, allow adding rows and typed columns. Presentations show copied tables read-only; do not offer creation of an empty uneditable table there.
- Existing SQL result cards expose an explicit Formulas mode. Preserve the existing TableSpec view (formatting, pivot/reshape and chart semantics) alongside it.
- Formula expressions reference column names or bracketed names, and stable IDs internally. DuckDB performs all calculations, filters, sorting and footer aggregates over the complete bounded snapshot; AG Grid Community renders and edits cells.
- Column formula applies to all rows. Manual cell overrides apply after that column's calculation and before dependent calculations. Inputs must preserve decimal and large-integer strings rather than coerce to unsafe JS numbers.
- Save the bounded definition and edits in node.data.visualTable, through existing board revisions/autosave/undo/conflict handling. No application DB migration or beta schema adoption. Underlying SQL ResultSet remains immutable.
- Snapshot row IDs contain resultSetId and absolute source row index. Manual rows have UUIDs. Refresh cannot apply old overrides to new row numbers. Keep the previous spec, retain its snapshot reference, and show a clear action to use the new snapshot, explaining that local overrides are reset. Same-schema transitions may preserve formulas. Schema changes require explicit reinitialization.
- Formula errors remain editable, show the last successful result as such. No stale request may replace a newer result. Fullscreen editor supports narrow cards; presentations and agent-locked nodes are read-only.

## Architecture / approaches
Selected: local native DuckDB execution plus AG Grid Community display, with a small expression grammar compiled to SQL. This matches the approved prototype and avoids a second formula engine. Rejected spreadsheet engines were Handsontable/HyperFormula and Univer. Existing JS TableSpec engine remains for legacy views/charts until deliberately migrated.

Use the existing immutable SQL snapshots plus a bounded inline definition; a separate table-document store would add revisions, cloning and garbage collection without being necessary for the first supported limits. Native DuckDB is a production dependency and must pass archive/runtime smoke validation on the build host. Release CI already builds on native target platforms.

## Shared contract
`src/shared/visual-table.ts` exports:
- `VisualTableScalar = string | number | boolean | null`.
- `VisualTableColumn { id:string; name:string; type:'text'|'number'|'boolean'; sourceColumnId?:string; formula?:string; summary?:'none'|'sum'|'avg'|'min'|'max'|'count'; width?:number }`.
- `VisualTableRow { id:string; values:Record<string, VisualTableScalar> }`.
- `VisualTableEdit { rowId:string; columnId:string; value:VisualTableScalar }`.
- `VisualTableSpec { version:1; sourceResultSetId?:string; sourceSchema?:string; columns:VisualTableColumn[]; rows?:VisualTableRow[]; edits:VisualTableEdit[]; filters?:Array<{columnId:string; op:'contains'|'eq'|'neq'|'gt'|'gte'|'lt'|'lte'|'isNull'|'notNull'; value?:string}>; sort?:{columnId:string; direction:'asc'|'desc'} }`.
- `VisualTableResult { columns:VisualTableColumn[]; rows:VisualTableRow[]; summaries:Record<string,VisualTableScalar>; sourceRowCount:number; totalRowCount:number; offset:number; limit:number; sql:string; parameters:VisualTableScalar[]; elapsedMs:number }`.
- `visualTableSpecSchema`, `createEmptyVisualTable():VisualTableSpec`, `createResultVisualTable(result:ResultSet):VisualTableSpec`, `visualTableSourceSchema(columns:Column[]):string`, `renameVisualTableColumn(spec,id,name):VisualTableSpec` (updates references safely), `setVisualTableCell(spec,rowId,columnId,value):VisualTableSpec`.
- Limits: 100 columns, 1,000 manual rows, 10,000 overrides, 20 filters, formula length2,000, string cell length10,000, serialized spec<=1MiB. Validate unique IDs/names, references, finite values and source/manual exclusivity. Snapshot evaluation existing limits:50,000rows/20MiB/1,000,000cells. API pages default500,max2,000 rows; summaries use all filtered rows.

`src/server/visual-table.ts` exports `evaluateVisualTable({table,source?,offset?,limit?}):Promise<VisualTableResult>`, where source is `{result:ResultSet; rows:Cell[][]}`. It validates snapshot identity/schema and complete source. It exposes no raw SQL execution API. A bounded expression parser resolves names/IDs, allows scalar arithmetic/functions and aggregate-window expressions, rejects unknown identifiers, cycles, subqueries/statements/table functions; literals/edits/filter values are bound parameters. External access/extension loading disabled, bounded memory and execution time, each evaluation closes its connection. Source numeric precision must remain exact or fail explicitly.

`POST /api/visual-table/evaluate {table,resultSetId?,offset?,limit?}` authenticates/CSRF through existing middleware, loads a checked snapshot when needed, evaluates only, and does not save. Client `evaluateVisualTable` helper takes that input plus optional AbortSignal.

`src/client/board/SqlTableView.tsx`: props `{spec:VisualTableSpec; result?:ResultSet; editable?:boolean; presentationBackground?:string; onChange?:(spec:VisualTableSpec)=>void; onExit?:()=>void}`. All changes flow through onChange, wrapper prevents board drag/pan/key/clipboard conflicts. It imports the client API helper. Parent owns activation, title, snapshot metadata and persistence.

## Verification
Real engine tests for formulas/dependencies/overrides/nulls, exact decimals/large integers, aggregate/filter/paging, renamed columns, cycles and grammar rejection. API auth/limits/source mismatch and board reopen/retention tests. UI tests edit/formula/undo and read-only boundaries, then desktop browser checks in the existing 0.13 test stand. Typecheck, full suite, production build and local native packaging smoke. No mobile checks or publishing in this task.
