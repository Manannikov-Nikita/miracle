# Date batch pause implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development or superpowers:executing-plans for the scoped tasks below.

**Goal:** Pause the entire date batch after exhausted attempts and resume the same failed date after explicit confirmation.

**Architecture:** Persist `QueryRun.status=paused`; resume the same run and result through an explicit API action. UI exposes the failed date and continuation without restarting completed work.

**Tech Stack:** Existing TypeScript, React, Fastify, SQLite and Vitest; Node 24.

**Spec:** `docs/superpowers/specs/2026-11-04-date-batch-pause-design.md`

## Constraints and review focus

- Preserve earlier release work and the running local test project.
- Resume uses the stored source and a fresh attempt budget for the failed date.
- Concurrent resume/cancel must not execute twice or resurrect a cancelled run.
- Paused partial results remain available across retention and service restart.
- Both editor and board run flows must expose the decision and retain progress.

## Server and shared contract

- [x] Extend RunStatus with `paused` in `src/shared/types.ts`.
- [x] Change `src/server/date-batch.ts` to persist a pause, skip completed items on resume, preserve elapsed execution time, and keep fatal storage failures terminal.
- [x] Add POST `/api/query-runs/:id/resume` in `src/server/app.ts`; validate paused state, availability, capacity and race-safe transition. Support cancelling paused runs.
- [x] Protect paused results/runs in `src/server/db.ts` retention and `src/server/workspace-operations.ts` snapshot checks.
- [x] Update `tests/date-batch-api.test.ts` and storage tests for pause/resume, no duplicated rows, concurrency, cancellation and restart.

## Client decision

- [x] Add API continuation and clear paused text/actions in `DateBatchProgress.tsx`, with double-submit protection.
- [x] Preserve paused run attachment in `SqlWorkspace.tsx`; keep result table and prevent treating a pending decision as completed.
- [x] Cover board reruns and history status, preserving access to a pending decision after reload.
- [x] Replace the old hint that errors automatically advance the series; test progress actions and SQL/board integration.

## Verification and stand

- [x] Review status consumers and independent race/recovery findings.
- [x] Run focused tests, then full tests sequentially with build; inspect results.
- [x] Create a local failure fixture and verify pause, explicit continuation, same-date restart and retained rows in browser.
- [x] Update usage/validation documentation and leave the refreshed 3060 stand running.
