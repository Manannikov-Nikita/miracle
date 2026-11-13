# Shape geometry on the board

The visible shape is the container: selection, alignment, distribution and snapping must use its painted extent, including rotation and arrowheads. Empty regions outside the silhouette must not intercept clicks. Standalone lines use endpoint handles instead of a wide rectangular resize frame.

Keep saved layout coordinates and dimensions unchanged to preserve existing boards. A shared geometry helper computes the actual visible bounds; the XYFlow adapter projects those bounds into runtime nodes and converts drag positions back to saved layout coordinates. Artifact content retains its original local size and rotation inside the tight runtime frame. This avoids a data migration and preserves old arrowhead sizing.

Use shape geometry for alignment/snapping, with ordinary cards retaining their existing rectangular behavior. Thin lines have a small mouse hit tolerance excluded from their visible bounds. Endpoint editing preserves the opposite endpoint, supports cancellation/undo, and canonicalizes the edited line direction while preserving its visible position.

The change is functional and retains the existing interface style. No new shape types, database schema, dependencies or redesign. Test desktop only with synthetic objects; verify rotated shapes, line directions and arrowheads, drag projection, endpoint cancellation/undo, existing connections, full tests and build.
