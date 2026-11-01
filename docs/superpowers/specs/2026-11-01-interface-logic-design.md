# Miracle interface logic review

The user requested a second pass beyond Soft Graphite colors: review every interface, use recognizable icons where appropriate, remove redundant or misleading controls, and improve proportion and placement. This continues the authorized redesign in the existing checkout.

## Approach

Keep the existing React, Radix, Phosphor, Monaco and XYFlow foundation. Apply contextual cleanup instead of replacing every label with an icon or redesigning the information architecture. Universal secondary actions use icons with stable accessible names and native tooltips. Primary submissions, ambiguous actions, form fields, permissions and destructive confirmations keep text. Preserve the chat's existing message layout.

## Audit and selected work

- Shell/explorer: connection selection has a false disclosure caret; connections settings uses a generic gear; filters leak between explorer modes and filtered empty states lack explanation. Correct these cues and add an explicit clear-search action.
- SQL/results: adding a result to the board has separate click/drag controls; combine them into one named icon control, preserving both interactions. Move local layout reset into the SQL menu. Hide disabled page controls for single-page results. Keep run/date-run/cancel semantics and labels.
- Board: remove duplicated fit-view action from the creation toolbar; use consistent note/Markdown icons; give properties, source and deletion semantically accurate icons; make rule actions compact; hide single-page pagination; group source details and chart appearance; let connection editing close explicitly. Keep geometry, permissions, snapshots and undo behavior.
- Connections: engine choice only during creation, readable engine identity during editing. Use compact per-row check/edit/delete controls; put back navigation apart from form test/save actions. Keep footer reachable on long TLS forms. Preserve all security fields, validation and explicit delete confirmation.
- Agent: open settings for the selected profile; create a new profile with a distinct action. Separate save/check, trust and deletion; confirm deletion and block edits during pending requests. Replace the misleading plus menu with an ellipsis and remove duplicate settings entry. Keep conversation UI and draft behavior.
- Date dialog, execution progress, errors, help and permission prompts: retain explicit text and existing behavior; avoid icon-only controls where consequences need explanation.

## Verification and constraints

No new dependencies, server changes, real SQL execution, chat messages, connection changes or live destructive actions for visual testing. Use focused regression tests for changed interaction behavior, existing subsystem tests, full test suite, TypeScript/Vite build and browser checks. Review narrow panes, long names, keyboard focus, readonly/busy states, error recovery and destructive confirmation. Document findings that remain outside this scope honestly.
