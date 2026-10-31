# Local agents and project folders

Approved design, 2026-10-31. Base: main 8be0d5e, verified against GitHub before implementation.

Each launch directory is a separate project. Its .miracle directory stores connections, saved queries, boards, editor documents and agent chats. One background server owns one project; repeat launch reuses it; different projects have independent ports and browser sessions. --project-dir selects the project from elsewhere; explicit --data-dir/MIRACLE_DATA_DIR remains a storage override. Existing global data is not silently moved.

Support locally installed Codex CLI and Claude CLI through native structured protocols, not a terminal emulator. Users configure named provider profiles with a full launch command. Preserve their model and permission options and show the adapter-derived command. Commands support quoting and leading environment assignments; complex shell syntax requires an executable wrapper. Do not collect account credentials or add login flows. Native permission prompts appear in chat.

A lower-right circular button opens an accessible responsive chat panel with history, profiles/settings, streamed messages/actions, approvals and stop. Multiple conversations are saved, one agent turn runs per project. A chat retains its provider/profile. Closing the browser does not stop execution. Restart interrupts unfinished work without repeating actions.

Agents use native filesystem/shell tools with project cwd and native project instructions. A scoped local MCP bridge exposes Miracle context, schema, editor documents, saved SQL, read-only query execution/cancellation/results and board operations (nodes, position/size, edges, notes, charts/tables and result attachment). No general-purpose file explorer/editor is added. Existing SQL limits and private connection credentials remain server-side.

SQLite is authoritative for editor and board state. All changes use expected revisions; mutations are deduplicated; events follow commits and support reconnect. Browser unsaved changes remain recoverable on conflicts. User focus changes do not silently retarget an active agent task. Native provider session IDs support continuation; unavailable sessions are visibly replaced using saved conversational context, never replaying tools.

Legacy SQL drafts must be imported while the previous workspace is opened on its original browser origin, then migrate with stopped backup/restore. Backups include app state and chats but not ordinary project files or provider home state. Imported executable profiles require local configuration before execution. macOS/Linux/WSL remain supported; native Windows, attachments, orchestration and release publication are out of scope.

Approaches: user selected independent project instances over a unified multi-project server. Native adapters with a shared MCP bridge are used instead of terminal scraping or file mirroring because live revisioned state and headless execution are required.

Acceptance: deterministic protocol tests and real smoke of both CLIs; file → SQL → result → board; background/reconnect/resume/cancel; two projects and cookies; alias/restart/port conflicts; no lost concurrent edits; isolated scoped tokens; migration/backup. Missing real Claude means its end-to-end acceptance remains explicitly unverified.
