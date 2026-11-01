# Programmable Agent Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Built-in agents create and refine arbitrary SVG/HTML/Canvas charts on SQL snapshots.

**Architecture:** Extend result nodes with a versioned custom spec. An opaque iframe runs browser-only code against bounded snapshot data; authenticated browser diagnostics let the agent distinguish saved code from observed rendering. Reuse board mutations, snapshot refresh and existing UI.

**Tech Stack:** TypeScript, React, Fastify, Zod, SQLite, Vitest, browser sandbox/CSP. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-01-custom-agent-charts-design.md` (approved 2026-11-01).

## Global Constraints

- `customChart.version: 1`; description ≤4,000 chars, HTML/CSS ≤100,000 each, JavaScript ≤200,000; combined code ≤256 KiB UTF-8.
- Boards containing customChart ≤1.5 MiB UTF-8, atomic rejection `BOARD_TOO_LARGE`; HTTP request limit remains 2 MiB.
- Data ≤5,000 rows, 100,000 cells, 5 MiB serialized columns + rows; no truncation or implicit numeric conversion.
- iframe `sandbox="allow-scripts"`, no same-origin; code never executes in parent/server. No external dependencies or API bridge.
- Fresh reports match current source hash and snapshot; expire at 60 seconds. Keep all active browser reports; no false success when not observed.
- Existing revisions, snapshot lifecycle, selected-node targeting, ordinary charts and tables stay compatible.
- Existing application style and Russian UI; generated chart may choose its own background and typography.
- No export, image uploads, multiple SQL sources, persistent interaction state or CPU-isolation guarantee.

## Review Focus

- Many individually small mutations must not make browser full-board saves fail; test aggregate limit and rollback (Task 2).
- Late messages/HTTP requests from replaced renders must not replace current status; test source/hash/snapshot/sequence freshness (Tasks 2, 3).
- Arbitrary cell strings including closing script tags must remain data; test trusted shell and DOM boundary (Task 3).
- Reopening, resizing, table switching and data updates must retain custom code without stale rendering (Tasks 3, 4).
- Empty results and exact-number strings must remain usable without fake points or coercion (Tasks 2, 3, 5).

## Shared interfaces and ownership

`src/shared/custom-charts.ts` exports CustomChartSpec, CustomChartData, CustomChartReportInput, CustomChartStatus, limits, `serializeCustomChart(spec): string` (JSON tuple [version,description,html,css,javascript]). SHA-256 of its UTF-8 encoding identifies code; server uses node crypto, client uses WebCrypto. Types use existing Column and Cell through type-only imports.

Data route: GET `/api/result-sets/:id/custom-chart` → `{columns,rows}`.
Report route: POST `/api/boards/:id/nodes/:nodeId/custom-chart-status` → `{ok:true}`. Body: `{browserId,sequence,sentAt,resultSetId,specHash,status,stage?,message?}`. Sequence is strictly increasing per browser page (module counter); browserId is page-unique UUID, not a credential. Status is rendering/rendered/error. Current status GET returns `{status,reports}`; MCP `read_custom_chart_status({id,nodeId,offset?,limit?})` adds `total,nextOffset` with default10/max20 reports per page and aggregation across all current reports; reports include observedAt and the input fields. Aggregate precedence error > rendering > rendered; empty → not_observed. Ignore/reject out-of-order sequence. Max 1,000 entries, lazy TTL cleanup, errors ≤4,000 chars. `sentAt` is fixed across retry; reject age ≥60s or future skew >5s. Retain sequence watermark until max(receivedAt,sentAt)+60s, while visible report expires at receivedAt+60s. At capacity reject new keys rather than evicting fresh entries.

`CustomChart` default component props `{boardId:string,nodeId:string,resultSetId:string,spec:CustomChartSpec,onShowTable?:()=>void}`. Owns bounded data fetching, hashing, renderer lifecycle, heartbeat/report upload and local state. `src/client/board/custom-chart-runtime.ts` builds trusted srcDoc shell and validates its message envelope. Root integrates component into existing views; runtime agent does not edit existing UI files.

## Task 1: Shared contract and validation

**Files:** create `src/shared/custom-charts.ts`, `src/server/custom-chart-schema.ts`, `tests/custom-chart-validation.test.ts`; modify `src/shared/types.ts`, `src/server/validation.ts`.
**Produces:** shared interfaces above; `customChartSchema`; BoardNodeData view `table|chart|custom` and optional customChart. Custom view requires result kind, snapshot, SQL and spec.

- [x] Write failing tests for accepted v1 spec, missing spec, unsupported version, Unicode byte limits, custom on non-result, code retained in table view.
- [x] Run `npm test -- tests/custom-chart-validation.test.ts`, verify missing-feature failures.
- [x] Implement contracts, canonical serialization and strict spec validation; preserve existing board validation behavior.
- [x] Run focused validation and existing chart/table schema tests; commit contract.

## Task 2: Server persistence, bounded data, agent tools and diagnostics

**Files:** modify `src/server/workspace-operations.ts`, `src/server/app.ts`, `src/server/agents/tools.ts`, `src/server/agents/manager.ts`; create `src/server/custom-chart-status.ts`, `src/server/custom-chart-guide.ts`, optional focused route/data helpers; tests `tests/custom-chart-server.test.ts`, `tests/custom-chart-status.test.ts`, agent MCP tests as necessary.
**Consumes:** Task 1 contracts. Own all server changes except Task 1 validation files.
**Produces:** routes above; `WorkspaceOperations.customChartStatus(boardId,nodeId)` and `reportCustomChartStatus(boardId,nodeId,input)` shared by routes/MCP; guide tool with executable SVG example, binding, resize, events, cleanup, limits and caveats.

- [x] Write failing tests for atomic board-size rejection and metadata data limits, persisted custom code, revision conflict/retry behavior, authenticated/CSRF-protected report route, data serialization bytes and no metadata leakage.
- [x] Write status tests for multiple tabs, hash/snapshot invalidation, 60s TTL, sequence ordering, cap, errors and not_observed.
- [x] Run focused tests and record expected failures before implementation.
- [x] Implement shared server helpers and wire operations/routes. Byte limit at data endpoint; metadata row/cell validation at attach. Current spec is validated before accepting reports; store does not mutate boards or log source/data.
- [x] Add `custom_chart_guide` and `read_custom_chart_status` MCP tools; selected-node prompt includes custom version/description, reads source with read_board. Describe bounded retries and rendered ≠ visual correctness.
- [x] Run focused server/MCP tests and typecheck; report results, coordinate commit with root.

## Task 3: Sandbox runtime and CustomChart component

**Files:** create `src/client/board/custom-chart-runtime.ts`, `src/client/board/CustomChart.tsx`, focused helpers/styles alongside it; tests `tests/custom-chart-runtime.test.ts`, `tests/custom-chart-client.test.ts`.
**Consumes:** Task 1 contracts and fixed Task 2 route paths. Existing `api<T>(path, options)` handles session/CSRF.
**Produces:** CustomChart props defined above. No changes to existing ResultView/ArtifactNode/Inspector/styles owned by Task 4.

- [x] Write failing runtime tests for trusted shell (no source/data interpolation), envelope source/run identity/size checking, error reporting, inert data and cleanup behavior. Write lifecycle tests covering late responses and retry.
- [x] Run tests, verify expected missing-feature failures.
- [x] Implement opaque iframe shell with restrictive CSP, synchronous `new Function('api', code)` only within iframe; render data transferred after handshake to concrete contentWindow, parent receives only bounded statuses. HTML/CSS applied inside iframe; window error/rejection events become errors. Do not promise process/network confinement beyond spec.
- [x] Implement abortable data fetch, WebCrypto hash, debounced dimensions from content box (not zoomed bounding rect), full frame replacement on change, render timeout, unexpected-navigation handling, text loading/error states, Retry/Table actions and a description accessible to assistive tech.
- [x] Send sequenced reports and 20s heartbeat only for mounted/current run; do not continue rendered heartbeat after frame errors/removal. Acknowledge lost diagnostic connection locally without declaring server success.
- [x] Run focused tests/typecheck; report results and coordinate commit with root.

## Task 4: Existing board UI integration

**Files:** modify `src/client/board/ResultView.tsx`, `src/client/board/ArtifactNode.tsx`, `src/client/board/Inspector.tsx`, `src/client/board/BoardWorkspace.tsx` or related typing where needed, existing board stylesheet only if needed; tests `tests/custom-chart-board.test.ts` and affected UI tests.
**Consumes:** Tasks 1/3 interfaces. Root owns this task, with task-scoped independent review.

- [x] Write a failing test that persisted custom view renders CustomChart with board/node/snapshot identity and retains source on table switch.
- [x] Wire new view through ResultView, ArtifactNode, Inspector and type guards. Offer custom mode only when source exists; use existing properties/SQL/refresh/delete actions.
- [x] Add description/status affordance in existing visual style, preserve table access, selection via header/frame and keyboard reachability. Avoid custom scripts in parent DOM.
- [x] Run affected UI tests and typecheck; commit integration after tasks 2/3 land.

## Task 5: Examples, browser acceptance and whole-feature verification

**Files:** create `tests/fixtures/custom-chart-examples.ts`, browser smoke under `tests/` using existing tooling conventions; update README and create `docs/custom-charts.md`; record verification in `docs/superpowers/plans/2026-11-01-custom-agent-charts-verification.md`.
**Consumes:** all prior tasks. Test fixtures are source-driven annotated bars and waterfall using named columns and labeled synthetic data; no logos.

- [x] Create two SVG examples with genuine data binding, responsive viewBox, annotation/bracket/connector geometry and keyboard/click interaction; verify changed rows alter geometry/text, zero rows show an empty state, exact strings are handled explicitly.
- [x] Run full `npm test`, `npm run typecheck`, `npm run build` using supported Node runtime. Investigate baseline/environment failures separately and document actual verification.
- [x] Run production browser smoke for both examples, resize, table switching, reconnect/refresh, syntax/runtime failures and retry, blocked parent/storage/API/subresources, stale diagnostics, ordinary chart regression. Save reviewable screenshots.
- [x] Exercise one real installed embedded CLI: create and revise a chart, inspect saved state and browser report. Explicitly record unavailable providers or environment blockers. **Attempted; environment-blocked before MCP by installed Codex0.136.0/config/model-account mismatch. Creation/revision not claimed.**
- [x] Independent task reviews and whole-branch review; address actionable findings, rerun affected checks; commit completed feature with verification evidence. Do not publish or deploy without instruction.

## Итог

Реализация завершена в отдельной ветке. Финальная проверка: 100 файлов / 1180 тестов; build/typecheck проходят; 12 браузерных сценариев проходят. Реальный CLI был запущен, но создание и правка заблокированы несовместимостью установленной версии и моделей аккаунта до вызова MCP. Подробности и границы подтверждения: [отчёт](2026-11-01-custom-agent-charts-verification.md).
