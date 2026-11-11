# Agent activity implementation

1. Extend provider lifecycle events: Claude tool results and Codex public plan updates; preserve context telemetry and root filtering.
2. Add authoritative Miracle tool lifecycle with bounded factual summaries, stable per-call IDs and error/cancellation receipts.
3. Normalize existing and new action messages into typed client timeline items, respecting failures, source identity and legacy chats.
4. Replace the modal activity viewer with the inline Pasta-style timeline, open during work and collapsed after completion; preserve optional raw details.
5. Verify focused regressions, independent review, desktop UI, full tests and production build. Preserve all earlier 0.12.0 work.

Ownership: provider agent owns codex.ts/claude.ts + its new tests; tool agent owns tools.ts and new metadata helper/tests; UI agent owns AgentActivity.tsx, its CSS and activity UI tests; root owns normalization, manager launch scoping, scroll integration and final checks.

## Verification — 2026-11-11

- Completed all five implementation steps in the existing 0.12.0 worktree.
- `NODE_OPTIONS=--no-experimental-webstorage npm test`: **205 files, 2609 tests passed** with local HTTP server access.
- `npm run build`: client/server typechecks and production build passed. Existing Vite chunk-size warnings remain.
- Independent reviews covered provider root filtering, lifecycle grouping, safe source URLs and native/Miracle duplication. Fixed lost cancelled/pending native calls and missing Codex web-result URLs with regressions.
- Native and server MCP call IDs cannot be correlated exactly. Successful native transport events yield to the authoritative Miracle journal; pending/failed transport stays visible rather than silently losing a separate invocation.
- Desktop Browser verified automatic live expansion, manual collapse/reopen, keyboard access to step details, SSE terminal collapse and reopening history. Preview fixtures are explicitly labelled; no paid provider request was made.
- Reader position is preserved for history and collapsed activity; an expanded active timeline follows new events only while pinned to the bottom.
- Pasta UI attribution and packaged MIT notices cover both adapted components.
