# Shape visible bounds Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for the independent tasks below.

**Goal:** Make shapes and standalone arrows selectable and alignable by their visible geometry.
**Architecture:** Share primitive geometry between rendering and bounds. Project saved layout into tight runtime XYFlow frames, translating drag changes back. Use endpoint controls for lines.
**Tech Stack:** React, TypeScript, SVG, XYFlow, Vitest, Node 24.22.2.
**Spec:** docs/superpowers/specs/2026-11-12-shape-visible-bounds-design.md

## Constraints and review focus

Preserve existing document appearance and unrelated file-editor changes. Do not mutate saved dimensions during load. Keep arrowheads independent of zoom. Desktop tests only. Check rotated ellipses/polygons, thin and thick lines, frame projection, old connections, duplicate drag, endpoint undo/cancel and read-only/agent locks.

### 1. Shared geometry
- [x] Add failing geometry/rendering regressions for visible stroke/arrowhead extents and rotation.
- [x] Add shape-geometry.ts exporting getLineGeometry(shape,width,height) and getNodeVisualBounds(node), returning actual primitives and x/y/right/bottom bounds.
- [x] Refactor LineShapeContent to render the same primitives and provide narrow pointer hit tolerance; run focused tests.

### 2. Alignment
- [x] Test alignment/distribution and snapping of visible rotated shapes/lines with ordinary cards.
- [x] Use shared bounds in alignment.ts and resize-snapping.ts, applying deltas to saved positions; run focused tests.

### 3. Endpoint controls
- [x] Test fixed opposite endpoint, zoom, rotation, cancellation and keyboard input.
- [x] Add LineTransformControls and optional lineDirection to ShapeTransformPatch; integrate guarded undoable patches; run focused tests.

### 4. Runtime containers
- [x] Test tight flow frames, drag round-trips, no-op positions and unchanged stored geometry.
- [x] Project shapes in flow-nodes.ts; offset/rotate original content in ArtifactNode and disable pointer capture outside actual primitives.
- [x] Integrate endpoint controls and preserve ordinary shape resize/connection behavior.

### 5. Verification
- [x] Independent code review and desktop browser checks using synthetic board objects.
- [x] Full npm test, npm run build, git diff --check under pinned Node24.
- [x] Update usage documentation and leave the test environment running.
