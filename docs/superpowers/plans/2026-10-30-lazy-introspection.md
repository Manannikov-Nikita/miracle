# Lazy introspection implementation plan

> Execute independent backend, shared store, Explorer, and completion tasks in the current session, then review the integrated change.

**Goal:** Responsive schema-based browsing and completion with a shared cache and complete background search index.
**Architecture:** Paged connector metadata API, workspace-owned incremental cache and priority scheduler, subscribed Explorer and context-aware editor.
**Tech Stack:** Existing TypeScript, Fastify, React, Monaco and Vitest; no new dependencies.
**Spec:** docs/superpowers/specs/2026-10-30-lazy-introspection-design.md

## Constraints and review focus

Preserve local single-user behavior, ClickHouse and Trino support, and source isolation. Test late responses after refresh, secret-only connection edits, duplicate table names, partial failures, empty schemas and thousands of objects. Metadata is cached for the browser workspace lifetime; an explicit refresh discovers subsequent database changes.

## Tasks

- [x] Backend: add shared metadata page types and schemas/tables/columns endpoints, cursor validation, scoped queries and disconnect cancellation; tests before implementation; preserve legacy API.
- [x] Store: implement cache, bounded priority queue, incremental background scan, subscriptions, deduplication and invalidation; test concurrency, errors, source switching and stale response rejection first.
- [x] Explorer: replace eager schema props with shared store, grouped lazy tree, persistent source expansion, progressive column search and bounded rendering; verify with real-store React tests.
- [x] Completion: share the store, request only referenced scopes/table columns, suggest independent schemas, bound prefix results and preserve deadline/cancellation; extend existing completion tests.
- [x] Integrate: full tests and build, real connector pagination checks, browser interaction and screenshot, independent review and fix important findings.
