# SQL Prevalidation Implementation Plan

**Goal:** Underline common SQL mistakes and explain corrections on hover before execution.

**Architecture:** Pure local diagnostics reuse the completion lexer and feed a debounced Monaco controller. SqlWorkspace supplies the current dialect and owns controller lifecycle. No query/server calls or new dependencies.

**Spec:** ../specs/2026-11-13-sql-prevalidation-design.md

## Constraints and review focus

- Preserve all existing table work; no release, rollback or dependency changes.
- UTF-16 ranges must identify the relevant expression/alias, including Unicode and multiline input.
- False positives in valid SQL, incomplete input, CTEs, unions, windows, aggregate combinators, dialect-specific grouping and quoted names are primary risks.
- Model swaps, connection changes, remote agent edits and disposal must not leave stale markers.
- Checking is local and advisory; execution behavior stays unchanged. Desktop verification only.

## Tasks

1. [x] Pure analyzer (`sql-diagnostics.ts`, reusable exports in `sql-completion-context.ts`, `sql-diagnostics.test.ts`): write failing examples/range and valid-query regressions, implement conservative rules, verify diagnostics and existing completion tests.
2. [x] Monaco controller (`sql-diagnostics-controller.ts`, controller tests): test debounce, dialect refresh, exact markers, stale marker cleanup and disposal; implement using Monaco types without runtime editor imports.
3. [x] Workspace integration (`SqlWorkspace.tsx`, workspace mock updates/tests): register hover support, install controller at mount, refresh dialect on source changes, dispose on unmount; preserve run action and SQL text.
4. [x] Verify focused tests and build, independent review, then desktop underline/hover/correction checks on the test stand. Record actual results and limitations below.

## Verification

- Final full suite: 218 files / 2937 tests passed with local fixture servers permitted. Existing jsdom canvas notices remain. The initial run before review fixes also passed (2926 tests).
- Client/server TypeScript and production build passed after integration and review fixes. Existing bundle-size notice remains.
- Independent review reproduced four issues: equivalent qualified grouping expressions, ClickHouse alias chains, valid substring/trim/interval syntax, and excessive nesting. All received failing regressions and fixes. Additional review found repeated alias references could cause exponential traversal; an isolated process reproduced the timeout, then memoization fixed it. Focused engine/completion/format suites: 142 tests passed (64 diagnostics cases).
- Controller/workspace tests cover exact ranges, debounce, correction, model/source changes, cleanup, remote agent edits during read-only locks and unchanged execution availability. No SQL execution is initiated by validation.
- Conservative scope: SELECT projection aliases and grouping, direct aggregates in WHERE/PREWHERE. Incomplete SQL, unknown functions, unresolved scalar WITH bindings, complex grouping and unsupported expression shapes are left to the database. Bounds: 200k characters, 25k tokens, 100 SELECT scopes, nesting depth 128 and 100 hints.
- Desktop stand: exact `city` underline, Russian hover explanation, marker removal after adding `city` to GROUP BY, and a warning/hover on the second conflicting alias. Screenshot `/private/tmp/miracle-sql-prevalidation.png`. No external query was executed. Temporary test SQL was cleared, its tab closed, and the original board-only layout restored.
