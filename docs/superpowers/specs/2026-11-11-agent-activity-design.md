# Agent activity in chat

Extend the stable-based 0.12.0 work with the Pasta UI Agent Activity reference, preserving the existing collapsed-agent orb and context disclosure. The user selected an inline timeline that expands while the agent works and collapses to an action count when the turn ends. Users can reopen completed turns or manually collapse the current one.

Use one semantic connected list per existing transcript turn, in its current activity position. Each step has a category icon, concise Russian title, optional factual detail and source chips, and an explicit running/completed/failed/cancelled/unknown state. Support native reads/searches/file changes/commands/web actions, plans, MCP tools and subagent snapshots. Do not show private reasoning. Technical event details remain an optional disclosure. Only actual HTTP(S) URLs become links; filenames and object names can remain descriptive chips.

Use the existing React, Phosphor and CSS system. Adapt the MIT-licensed reference without introducing its motion/Tailwind/icon dependencies. Keep the existing approval interactions, SQL controls and subagent rail. A successful run_query means the query was launched; SQL execution status remains owned by the existing SQL activity subsystem.

Keep persisted action events and existing SSE/GET contracts. Group lifecycle events by stable source/launch/call identity, never by equal arguments. Extend Claude with root tool results and Codex with public plan updates. Instrument Miracle tools with their own explicit lifecycle and bounded metadata; never copy full query results, credentials or file contents into summaries. Prefer authoritative Miracle events to successful native transport duplicates; retain native transport failures that never reached Miracle.

Alternative approaches were a reskin of the old JSON dialog or a separate activity database. The selected implementation extends the current transcript model, supplies the requested visible steps and keeps stored chats compatible without a migration.

Verification covers lifecycle grouping and errors, provider root isolation, repeated identical calls, factual resource summaries, reload/events, auto-collapse and manual expansion, keyboard access, reader scroll preservation and desktop browser presentation. No paid provider runs or beta imports.
