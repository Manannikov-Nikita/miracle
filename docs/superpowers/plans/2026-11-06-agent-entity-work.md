# Agent Entity Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track completed steps below.

**Goal:** Show AI activity on the exact entity and prevent edits to that entity while allowing independent board edits.

**Architecture:** Server claims fence mutations and publish project events. Shared three-way board merging preserves unrelated edits. Client lock subscribers gate editing below controls and render an accessible violet/blue activity treatment.

**Tech Stack:** Existing TypeScript, Fastify, SQLite, React, Monaco, CodeMirror, React Flow, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-agent-entity-work-design.md`

## Global Constraints

- Continue `codex/release-0.8.0` in the existing checkout; preserve preceding explorer changes and test data.
- Only affected board nodes/edges are locked. Do not lock a board merely because it is in context.
- No dependency additions, publication or release tag. Keep real local drafts and all unrelated project data.
- Native file writes require explicit claim protocol; no claim that Miracle controls external editors.

## Shared Interfaces

`src/shared/agent-work.ts`: `AgentWorkTarget`, `AgentEntityWork`, `AgentWorkSnapshot`, `agentWorkKey(target)`.

`GET /api/agent-work` returns `{revision, locks}`. Revision is the latest persisted project-event ID. Event `agent.work` carries `{locks}`; its enclosing event ID is the snapshot revision. Clients reject older snapshots and hydrate on connect/reconnect.

`src/shared/board-merge.ts`: `mergeBoardDocuments(base, local, remote): BoardMergeResult`, where result is `{document: BoardDocument, conflicts: BoardMergeConflict[]}` and conflicts identify node/edge/document IDs. Conflicting objects retain remote values in `document`; callers preserve local recovery and must not silently commit partial conflicting changes. `boardChangedEntities(base,next)` returns `{nodeIds:string[],edgeIds:string[]}`. `boardValuesEqual(a,b)` compares canonical content independently of object key order.

`src/client/agents/useAgentWork.ts`: `useAgentWork(target?:AgentWorkTarget|null):AgentEntityWork|undefined`, `useAgentWorkLocks():AgentEntityWork[]`; ProjectSync exposes current `workSnapshot()`, `subscribeWork(fn)` and hydrates from server. `AgentWorkIndicator` accepts `{work?:AgentEntityWork, compact?:boolean}`; `.agent-work-active` applies the shared treatment.

## Review Focus

- An awaited old agent mutation cannot commit after cancellation.
- A lock arrives while a local save/drag/draft is pending; the draft survives and unrelated editing continues.
- SSE overtakes save replies; both writers' disjoint changes survive.
- Deleting/reconnecting an edge cannot modify a locked endpoint indirectly.
- Undo/redo never reinstates stale contents of a remotely edited block.

## Tasks

### 1. Shared board reconciliation

- [x] Add tests for disjoint updates/additions/deletions, same-object conflict, idempotent equal changes, edge endpoint deletion conflicts and order/key equality.
- [x] Implement the shared interfaces above; validate graph consistency and preserve deterministic ordering.
- [x] Run focused merge tests.

### 2. Server ownership and concurrent board writes

Files: `src/server/agents/entity-work.ts`, agent manager/tools/routes, project store/routes, workspace operations and their tests.

- [x] Add failing tests for claim/release, rejection of user writes, linked query aliases, cancellation fencing and independent board mutations.
- [x] Implement explicit begin/end tools, mutation fallback claims, server actor context and authoritative event snapshot endpoint.
- [x] Rebase board updates/patches against authoritative historic base using Task 1; protect target objects and incident edges.
- [x] Verify targeted server suites, including cancellation and stale revision cases.

### 3. SQL/file activity and shared client registry

Files: ProjectSync, `useAgentWork.ts`, `AgentWorkIndicator.tsx`, SqlWorkspace, useEditorSync, ProjectTextEditor and targeted tests.

- [x] Implement snapshot/event ordering and reconnect hydration tests, then shared hooks and indicator.
- [x] Gate content edits, formatting, save/run/delete and linked aliases using current locks; preserve queued/local drafts and refresh released entities.
- [x] Exercise editor/file restrictions, stale in-flight actions and unlock recovery.

### 4. Independent board editing and lock presentation

Files: useBoard, BoardWorkspace, ArtifactNode, Inspector/edge controls and targeted tests.

- [x] Test remote/local disjoint updates, HTTP/SSE order and undo safety.
- [x] Integrate Task 1 merging into events/acknowledgements/retries and rebase history transitions.
- [x] Guard nodes/edges and affected endpoints at mutation boundaries, including ongoing gestures and dialogs. Preserve selection, view/copy and unrelated edits.
- [x] Display shared activity per affected object and verify scoped lock behavior.

### 5. Integration and review

- [x] Add reduced-motion-aware violet/blue activity styles and usage documentation.
- [x] Run independent code review; fix consequential findings.
- [x] Run full tests and build; exercise deterministic agent work in Browser on a disposable test project, then leave the user's test environment available.

## Execution ledger

- Reconnaissance complete; user chose per-block locking. Shared interface types created; implementation proceeding in parallel by ownership boundaries.

- Shared merge, server ownership, SQL/file registry and board integration implemented. Independent reviews corrected stale restored drafts, repeated source undo, protected ordering and locked refresh retries.
- Disposable Browser smoke verified readonly claimed block, editable neighbor, merged agent/user changes and unlock. Existing 3078 environment restarted with original data.
- Full integration pass: 140 suites / 1767 tests passed; build passed. Final rerun follows late review fixes.
- Final verification after review fixes: 140 suites / 1773 tests passed; production build and both TypeScript configurations passed; git diff --check clean. SQL acknowledgement regression preserves agent edits while retaining saved query/run associations.
