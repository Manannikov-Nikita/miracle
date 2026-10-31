# Agent References Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent server and composer tasks; root owns board context, wiring, and final verification.

**Goal:** Add project files via `@` and selected board blocks as explicit agent targets.

**Architecture:** Extend persisted turn context. A bounded authenticated file API supplies suggestions; ProjectSync publishes selection previews and captures targets before saving.

**Tech Stack:** Existing React, TypeScript, Fastify, SQLite, Vitest; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-agent-references-design.md`

## Tasks

- [x] Backend: `shared/agents.ts`, `server/project-files.ts`, project routes, agent manager. Test project boundaries, limits, file changes, board membership, persisted context and idempotency before implementation; run focused tests.
- [x] Composer: `AgentFileMentions.tsx`, `AgentComposer.tsx`, scoped CSS. Test caret replacement, keyboard, asynchronous results and removable chips; implement within existing visual design.
- [x] Context wiring: ProjectSync preview, BoardWorkspace selection registration, AgentAssistant per-chat references, useAgentChat captured targets, AgentMessages history. Test selection changes during send and dismissed context before implementation.
- [x] Integrate: independent review, full `npm test`, `npm run build` (includes typecheck), diff-check; restart idle demo server and verify file + chart references with real Codex. Preserve original project data.

## Review focus

Do not retarget an accepted turn after selection changes; do not leak attachments between draft conversations; prevent late autocomplete results from changing current input; do not turn a dropped chip back into an implicit target; do not expose files outside the project through traversal/symlinks or the configured application storage.

## Verification — 2026-10-31

- `npm test`: 789 tests in 69 files passed. `npm run build`, including both TypeScript projects, passed. Existing Vite bundle-size warning remains. `git diff --check` passed.
- Independent review reproduced a new-chat retry edge where a dismissed chart was reattached after a failed POST. The fix preserves dismissal across chat creation; the regression is RED → GREEN and checks the same request ID and empty board-node context on retry.
- Desktop browser: selected «Поездки по дням» on the NYC Taxi board; its chip appeared in composer. Typed `@manifest`, chose `data/manifest.json` with Enter, verified both chips, then sent a read-only request to real Codex. Agent read the file and the selected node via MCP: `loadedRows=1000660`, node `bb68cb2c-24bf-481e-871d-ce7c6bacb556`, line chart, x=`day`, y=`trips`. No identifiers or filenames were written into the prose request; they came from references. The completed message retains both chips. No browser console errors.
- Proof: `.local/demo-project/agent-file-picker.jpg`, `agent-reference-composer.jpg`, `agent-references-verified.jpg`. Demo updated at `http://127.0.0.1:50264/`. Original data was not edited; only the board viewport changed during verification.
