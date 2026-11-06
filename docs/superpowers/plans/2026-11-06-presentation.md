# Presentation implementation plan

Approved user specification: separate presentation documents based on boards; any pair of editor/board/presentation (never three), individual panes; independent block copies; 16:9 multi-slide editor and fullscreen presentation; no PDF/PPTX export.

## Binding behavior

- Fixed pane order editor, board, presentation. Opening third retains last-focused visible pane. Preserve drafts/state while hidden; pair-specific saved split sizes and legacy editor/board sizes.
- Presentations have named documents, slide thumbnails, slide add/rename/duplicate/delete/reorder; at least one slide. Logical size 1600x900, fit and zoom; white customizable slide background. Preserve block appearance. Editing may overflow slide; show clips.
- Copy via cross-pane drag, clipboard, and Add to presentation with destination picker. New IDs, same SQL/snapshot/settings/internal connections. Preserve source even on cancelled drag/save failure. Drop at pointer; menu centered; fit oversized groups into slide with32margin.
- SQL insert destination explicitly selected and captured before async work, exactly-once addressed delivery.
- Show flushes draft, starts selected slide, readonly current persisted document with live updates; arrows/PageUpDown/Home/End/Esc, fullscreen API with overlay fallback, restore prior focus/layout. Never auto-run SQL.
- Existing boards JSON storage and schemaVersion1; optional document.kind defaults board, presentation has ordered slides{id,title,background}; nodes AND edges get slideId; flat arrays retained. Kind immutable; reject cross-slide links and missing slides.
- Limits100slides/200nodes/500edges per document and existing payload limits; prevalidate copying/duplication.
- API/MCP kind filter/create plus add_slide/update_slide/remove_slide/reorder_slides, context slideId.
- Separate stores, active doc/slide/camera/selection/history/refresh ownership; active canvas alone owns shortcuts and agent canvas context; capture target before asyncflush.
- Entity merge: nodes,edges,slide metadata,slide order. Conflicting delete vs changed/new children preserves remote edits. Extend save acknowledgment, recovery, undo/redo.
- Existing per-node/edge claims; new board-slide metadata-only claim. Existing board claim covers name/slide-list/order. Delete verifies slide plus all children; unrelated blocks remain editable.

## Work ownership / interfaces

- Backend agent: src/shared/{types,board-schema,board-merge,agent-work,presentation}.ts; server files; shared agent types as needed; backend/model tests. Export BoardKind, PresentationSlide, boardKind(document), PRESENTATION_WIDTH=1600, HEIGHT=900; emptyPresentationDocument(); presentation schema optional slides on BoardDocument.
- Canvas agent: src/client/board/** including useBoard, presentation UI/helpers; client canvas tests. BoardWorkspace gets optional kind:BoardKind (defaultboard), active?:boolean(defaulttrue), onActivate?:()=>void, onTransferToPresentation?:(fragment:BoardClipboardFragment)=>void, insertion?:CanvasInsertionRequest|null, onInsertionConsumed?:(requestId:string)=>void. Root supplies runtime registry via CanvasWorkspaceProvider (see below).
- Root: App/WorkspaceRail, SqlWorkspace/Results, ProjectSync, new client/canvas-workspace.tsx registry, integration/QA/docs.
- CanvasWorkspaceProvider in client/canvas-workspace.tsx exposes activeCanvas(kind/null), activateCanvas(kind), registerCanvas(kind, handle), getCanvas(kind), transfer request/drop notifications. Handle contract includes documentId(), slideId(), flush(), insertResult(result,destination), insertFragment(fragment,destination,position?), screenToCanvas(point), activeSlideBounds(). Exact contract communicated before integration.
- Both canvas instances must register unique ProjectSync surface keys. Only active canvas context supplies boardId/boardNodes/slideId. Flush providers stay registered even hidden.

## Verification

- Focused red/green tests per task; integrate build and all tests once stable.
- Independent review against approved requirements and baseline snapshot /tmp/miracle-presentation-baseline.
- Disposable Browser environment, no mutation of user demo data. Verify pairs, slide operations, copy/drag, source preservation, fullscreen, claims and target routing.

## Progress

- [x] Plan approved, existing release branch and dirty state verified; baseline snapshot saved.
- [x] Backend schema/API/MCP/merge/claims.
- [x] Canvas/slide editor/presentation mode/transfers.
- [x] Panes/registry/context/SQL routing.
- [x] Integration tests and independent review.
- [x] Browser QA, full suite/build, usage documentation.

## Completion evidence

- Full suite: 149 files, 1832 tests passed (2026-11-06); production build and both TypeScript projects passed. `git diff --check` passed.
- Independent backend and integration reviews completed; final scoped review found no actionable issues.
- Built-in Browser, disposable project on port 3088: slide creation, rename, background, reorder, duplicate/delete; real thumbnails; menu copy, cross-pane drag and clipboard; source blocks and camera preserved; undo/Delete confined to the active panel; saved SQL result insertion; per-pair resize restoration; show sizing/navigation/live updates/Esc focus; node and slide-metadata lock boundaries.
- Main test environment on port 3078 restarted with the new backend, preserving its project data. No commit, push, or release publication.

Ruling: implement on existing codex/release-0.8.0 branch, preserve prior authorized changes and do not commit/push/release. Parallel workers have disjoint file ownership; coordinate shared contracts explicitly.
