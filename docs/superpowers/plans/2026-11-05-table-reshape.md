# Table reshape implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent model and UI verification tasks.

**Goal:** Add wide-to-long (melt) and long-to-wide (pivot) table modes without aggregation or value loss.

**Architecture:** Extend the saved version-1 table spec with an optional `reshape` union, mutually exclusive with the existing aggregate `pivot`. Transform the complete filtered snapshot before sorting and presentation. Keep the original result immutable.

**Tech Stack:** TypeScript, React, Zod, existing table model and Radix controls; no new dependencies.

**Spec:** User request in this conversation, including explicit confirmation that duplicate pivot intersections must produce a conflict.

## Constraints and review focus

- Melt selects one or more source columns and retains every unselected column as an identifier. Generated fields default to «Ключ» and «Значение».
- Raw pivot selects zero or more identifier columns, one category column and one value column. Duplicate intersections fail even when values are equal; missing intersections become NULL.
- Preserve raw NULL, strings, numbers, booleans, objects and large numeric strings; mixed melt types must not be treated as numeric.
- Retain existing aggregate pivot behavior and compatibility with saved version-1 specs.
- Protect full-snapshot loading, stable generated identities, source-name/id collisions, source and output size bounds, read-only settings and mode transitions.

## Tasks

1. **Model and schema** — `tableTypes.ts`, `table-schema.ts`, `tableModel.ts` (and focused reshape helper if needed): introduce the union, validate selections, implement lossless transformations and conflict/size checks. Test typed keys, roundtrip data, NULL, precision, mixed types, collisions, legacy aggregate pivot and limits.
2. **Settings and full-snapshot rendering** — `TableSettings.tsx`, `TableReshapeSettings.tsx`, `TableView.tsx`, `table-settings.css`: expose four forms, multiple column/key selection, melt field names, compatible sorting controls and cleanup of generated settings when changing form. Load all rows for reshape and reset local header sorting when configuration changes.
3. **Verification** — real Inspector/TableView integration tests, model/schema tests, production build and independent review. In @Browser demonstrate melt, raw pivot, multiple identifiers and a duplicate conflict on disposable local fixtures, then save screenshots.

## Completion

- [x] Model/schema tests pass (105 focused tests).
- [x] Inspector and complete-snapshot integration tests pass, including preservation of generated-column formatting on rename.
- [x] Production build passes.
- [x] Browser demonstration and independent review complete; duplicate conflicts are visible without opening error details.
