# Table transformations in charts

**Goal:** Charts use the table's transformed data and presentation.

**Architecture:** Reuse `buildTable` for filtering, sorting, column visibility/order, aggregation and reshape. Keep source metadata for table settings, and use the prepared schema for chart settings. Preserve numeric values for geometry; use table formatting and substitutions in labels. Custom charts receive the same transformed rows through their bounded server data endpoint.

**Scope:** A result block's table and chart are alternate views of the same configuration. Board arrows remain visual connections; unrelated copies of a snapshot retain independent settings.

- [x] Add pure chart adapter and regressions for filters, sorting, labels, hidden columns, aggregate pivot, melt, raw pivot and conflicts.
- [x] Connect standard chart rendering, settings and series colors to prepared data; retain source metadata for table editing.
- [x] Share table calculations with the custom-chart server endpoint; rerender on table changes and enforce limits after transformation.
- [x] Verify UI changes, failures, precision and stale-load protection with tests.
- [x] Exercise table-to-chart transitions in Browser, capture a demo, run build and complete suite.

Presentation-only table layout (width, wrapping, density, frozen columns and summary footer) does not add chart points. Table number formatting affects labels, not raw numeric geometry. Explicit chart appearance settings remain authoritative.

**Validation:** 132 test files / 1684 tests passed; production build passed on Node 24.22.2. Browser exercised filtered/sorted/renamed/formatted data, melt/pivot schemas, custom iframe refresh, and visible conflict messages.
