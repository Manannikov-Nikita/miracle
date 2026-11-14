# Board Agent Collaboration Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Track verification alongside each task.

**Goal:** Give agents compact spatial understanding, atomic board operations and two isolated, visibly attributed workers.

**Architecture:** Shared geometry powers UI and MCP. Server-issued worker capabilities and per-owner locks isolate real adapter processes. The root receives bounded scene/status data and delegates independent scopes.

**Tech Stack:** Existing TypeScript, React, Node24, Fastify, Vitest; no new dependencies.

**Spec:** docs/superpowers/specs/2026-11-14-board-agent-collaboration-design.md

## Global Constraints

- Same selected profile/model; at most two running workers and sixteen tasks per root turn.
- Separate immutable board scopes and capability tokens, no self-reported identity.
- Shared painted bounds; do not persist derived geometry or change document format.
- Compact reads/receipts, selected content fetched only on demand; no full history in worker prompt.
- Single work boundary per object and accessible owner names.
- No release or user-project mutations; desktop verification only.

## Review Focus

- Stale anchor reads: exact revision inside idempotent atomic spatial operation.
- Shared incident edges: serialize overlapping expanded reservations.
- Cancellation during await: revoke writes immediately, retain locks until process stops.
- Large sources/text and malicious IDs: bounded output and immutable worker scope.
- Missing/wrong-slide selected edge and native worker events: preserve target identity and root session/context.

### Task 1: Shared geometry and board service

Files: shared/board-geometry.ts, shared/board-layout.ts, client/board/{shape-geometry,alignment}.ts, server/board-agent.ts, tests/board-agent.test.ts, tests/board-spatial.test.ts.

Produces `readBoardScene(operations,input)`, `readBoardItems(operations,input)`, `applyBoardSpatial(operations,input)` and JSON schemas for tool discovery. Inputs use id for board ID; spatial uses baseRevision/mutationId/operations. Scene has revision/slideId/nodeIds/edgeIds/offset/limit; explicit selection can include bounded relations. Items returns bounded exact JSON chunks for selected IDs. Mutation receipts never contain full document.

- [x] Add failing geometry, pagination, output-budget and spatial concurrency tests.
- [x] Extract existing pure helpers with client re-exports; preserve UI behavior.
- [x] Implement bounded readers and exact-revision/idempotent operations using WorkspaceOperations.
- [x] Verify targeted suites including existing alignment/shape fixtures.

### Task 2: Ownership and real managed workers

Files: shared/agent-work.ts, server/agents/{entity-work,manager,board-workers}.ts, tests/agent-board-workers.test.ts and fixture.

Produces optional `ActiveAgent.worker` and `AgentEntityWork.worker` identity `{id,name,color:number}`, worker scope fields on ActiveAgent, `manager.isActive`, `manager.workActor`, `manager.authorizeTool`, `manager.availableTools`, `manager.startBoardTask`, `manager.boardTaskStatus`, `manager.cancelBoardTask`.

- [x] Add failing tests for root/sibling scope, release, cancellation, two-worker limit, deduplication and overlapping claims.
- [x] Extend authoritative ownership without weakening existing entity checks.
- [x] Implement isolated adapter processes and queue, bounded status and lifecycle cleanup.
- [x] Route worker approvals/questions safely; preserve root session and context metrics.
- [x] Verify entity-work and worker integration suites.

### Task 3: Worker visualization and selected edges

Files: client/board indicators/styles/workspace, client/agents reference/context components, shared/agents.ts, focused rendering/reference tests. Coordinate manager changes with Task 2 owner.

- [x] Add failing tests for distinct colors, one shape boundary and edge reference capture/retry.
- [x] Extend existing indicators with worker name and palette, preserving accessible neutral fallback.
- [x] Carry boardEdges end-to-end in browser; Task 2/root adds corresponding manager validation.
- [x] Verify client interaction/rendering/reference suites.

### Task 4: MCP integration and context policy

Files: server/agents/{tools,routes,manager}.ts, shared/agent-activity.ts as needed, tests/agent-mcp-integration.test.ts, new protocol integration tests.

- [x] Add discovery/real HTTP tests for new tools and scoped worker access.
- [x] Register scene/items/spatial/delegate/status/cancel tools, enforce allowlist and compact patch mode.
- [x] Replace automatic large board context with bounded identity/counts; prioritize scene and delegated independent work in prompts.
- [x] Check two fixture workers, user/root contention, stale anchors and output size through actual transport.

### Task 5: Independent review and final verification

- [x] Review concurrency, authorization, context budgets and UI regressions with a fresh reviewer.
- [x] Fix findings with regression cases; run complete `npm test` and `npm run build`.
- [x] Desktop check using temporary data: simultaneous colored owners, selected connector, completion and reconnect; movement and cancellation checked through real HTTP MCP.
- [x] Record exact results, remaining limitations and changed files. Do not publish a release.

## Verification result — 2026-11-14

- Full suite: **222 test files, 2980 tests passed**; production build passed.
- Independent geometry and collaboration reviews completed; findings fixed with regression coverage and scoped rereview.
- Desktop browser check on an isolated production-build stand: distinct worker colors match shape/line/card boundaries and activity, survive reload, disappear after completion, and keyboard-selected connectors enter chat context.
- Real fixture CLI processes exercised HTTP MCP delegation, scoped writes, overlapping queues, cancellation, token revocation, sibling continuation and compact output. Paid provider/model calls were not performed.
- Existing canvas notices in jsdom and Vite large-chunk warnings remain; no dependency or migration changes.
- Implementation remains in the current worktree; no release published.
