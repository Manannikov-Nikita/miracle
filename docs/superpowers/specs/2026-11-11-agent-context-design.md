# Agent context usage

The 0.12.0 development branch starts from stable 0.11.1; beta changes are excluded. Keep Thinking Orbs confined to the collapsed running-agent button.

Add a compact segmented context bar immediately above the chat composer. Clicking it opens details upward over the transcript without moving the input. Details follow the Pasta UI Context Breakdown reference: used tokens/window, colored category rows, percentages and available capacity. Use Miracle's existing dark surfaces and Russian labels. Keyboard activation, Escape, outside click and chat changes close/reconcile the panel. Reduced motion is respected.

The user approved approximate available category counts marked «≈». Overall usage and capacity come from provider telemetry. Codex uses the latest context usage, not cumulative session spend. Claude uses the latest root assistant input including cache reads/writes; capacity must match that root model. Never guess model context limits. Unknown usage/window has an explicit unavailable state rather than a percentage.

Categories estimate visible conversation, actual project data sent by Miracle, Miracle tool definitions and Miracle instructions. Unobserved native CLI content remains «Остальной контекст». Do not claim referenced files were read merely because a path was attached. Estimates are bounded by the reported total; their limitations are explained in details. No compaction action is added.

Approaches considered: a visual-only mock cannot satisfy real usage; importing the whole Pasta UI stack would broaden scope. Implement a focused React/CSS adaptation of its context breakdown and connect provider telemetry to persisted message metadata. No schema migration or new UI framework is needed. Preserve the upstream MIT notice if adapting source.

Usage is merged into the originating user message metadata, leaving user content/images/references unchanged. A separate context event updates the selected chat without unread notifications. Saved chats recover the measurement on reload. Session restart/fallback and model changes invalidate stale measurements. Old CLI versions continue to work with unavailable telemetry.

Validation: provider fixtures for latest/cumulative semantics and root isolation; persistence/event races; estimated sums and unknown/overflow cases; disclosure keyboard behavior; full existing tests/build; desktop browser verification on explicit fixtures, with no paid provider run required.
