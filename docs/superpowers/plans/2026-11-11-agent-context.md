# Agent Context Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for independent tasks. Keep changes in the current isolated worktree.

**Goal:** Show provider context usage above the composer with an upward-opening category breakdown.

**Architecture:** Normalize root provider telemetry, persist snapshots in existing user-message metadata and stream a dedicated context event. A focused presentational component uses approximate categories and real totals without guessing capacity.

**Tech Stack:** React 19, TypeScript, existing CSS, Vitest/jsdom and desktop Browser.

**Spec:** docs/superpowers/specs/2026-11-11-agent-context-design.md

## Global Constraints

- Stable 0.11.1 base; no beta imports or schema migrations.
- Preserve collapsed-button-only Thinking Orbs change.
- Category values are estimates marked «≈»; totals/window must be provider-reported.
- No fixed model limits; no mock production numbers; no paid provider runs.
- No compaction button or broader agent UI redesign.
- Desktop verification only.

## Review Focus

- Cumulative spend must not become current context usage.
- Child agents and old turns must not overwrite root usage.
- Late conversation reads must not roll back streamed measurements.
- Model/session changes must not retain stale capacity.
- Unknown/zero/over-limit values must remain truthful and accessible.

### Task 1: Provider telemetry

- [x] Add shared usage/snapshot contract in src/shared/agent-context.ts.
- [x] Add failing provider fixture tests for root latest usage, missing limits, malformed telemetry and child isolation.
- [x] Extend AdapterEvent with context-usage and parse Codex/Claude telemetry without disrupting old CLIs.
- [x] Run relevant adapter tests and typecheck.

### Task 2: Persistence and estimates

- [x] Add estimate helpers and tests for bounded sums, unknown values and other-context residual.
- [x] Merge contextUsage into originating user message details; publish agent.context.updated without creating transcript items.
- [x] Invalidate measurements at model/session changes and protect streaming updates from late fetches.
- [x] Test metadata preservation, reload and event races.

### Task 3: Disclosure UI

- [x] Adapt the reference into AgentContextUsage.tsx and scoped CSS; preserve source attribution/license.
- [x] Test upward disclosure semantics, keyboard/outside close, unavailable data and approximate rows.
- [x] Integrate above AgentComposer's form with correct selected-chat snapshot.
- [x] Build, run full suite, review implementation and verify desktop with controlled fixtures.

## Verification — 2026-11-11

- `NODE_OPTIONS=--no-experimental-webstorage npm test`: 201 files, 2576 tests passed. Run with local server access; sandbox blocks tests that bind HTTP ports. A preceding concurrent build/test run exposed an existing partial trace-read race in the Codex catalog cancellation fixture; the separate final run passed unchanged.
- `npm run build`: passed client/server TypeScript checks and production builds. Existing bundle-size and Zod annotation warnings remain.
- Independent review resolved a Steer delivery/usage race and an oversized disclosure in short desktop windows. Regression tests cover both.
- Browser verified compact bar, upward disclosure without input movement, keyboard activation, Escape, outside click and scroll containment at 1280×720 with a tall draft. Default viewport restored. Screenshots use explicitly labelled demo telemetry; no paid provider request was made.
- Pasta UI Context Breakdown adapted under MIT; source notice retained and release notice generation includes its license.
