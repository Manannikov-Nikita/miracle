# Local agents and projects implementation plan

Spec: ../specs/2026-10-31-local-project-agents-design.md

## Tasks

- [x] 1. Project runtime: canonical cwd, .miracle default, --project-dir/storage overrides, free ports, authenticated registry, port-scoped cookies, compatible installation lifecycle.
- [x] 2. Durable state: schema migration, revisioned editor documents, profiles/chats/turns/events, replayable server event stream, idempotent mutations.
- [x] 3. Shared operations and MCP: reuse SQL/board services, bounded results, project-scoped tools, active-turn capability credentials.
- [x] 4. CLI adapters: command parsing/validation, native Codex app-server and Claude streaming protocols, session resume, approvals, cancellation and process cleanup.
- [x] 5. Agent manager: one active turn, durable messages/actions, restart recovery, context targets, background execution and scoped lifecycle.
- [x] 6. Client: chat panel/profiles/history/actions/approvals, server-persisted SQL tabs, board synchronization and conflict recovery.
- [x] 7. Migration/docs and acceptance: legacy-origin draft migration, backup/restore, protocol and browser acceptance, existing full checks, independent review.

## Interfaces

New APIs: /api/project, /api/agent-profiles, /api/chats, /api/chats/:id/messages, /api/agent-turns/:id/cancel, /api/agent-approvals/:id, /api/agent-state, /api/editor-documents, /api/events. Local MCP is /agent/mcp with per-turn bearer credentials. DTOs live in src/shared/agents.ts. Editor writes use baseRevision and mutationId. Context contains editorDocumentId and boardId. SSE events are ProjectEvent objects with monotonically increasing id.

## Verification

Real subprocess protocol fixtures; API/storage concurrency and restart; two-project lifecycle; legacy browser import; stale token/origin/revision rejection; UI at desktop and narrow widths. Run npm test, npm run typecheck, npm run build, relevant integration and install smoke. Real Codex smoke is required for provider acceptance. At the user's explicit request, support Claude but omit real Claude execution; keep deterministic protocol checks. Do not publish a release.

Verification evidence: [verification report](2026-10-31-local-project-agents-verification.md).
