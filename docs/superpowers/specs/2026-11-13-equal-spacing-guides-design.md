# Equal-spacing drag guides

The user requested visible hints for equal distances between objects, and explicitly chose gentle snapping as well as the hint.

During an existing drag, detect positive equal gaps between the moving object's visible bounds and neighboring objects in the same horizontal or vertical band. Support placement between two neighbors and extension before or after a pair. Treat a moving selection as one combined visible bound. Use the existing six-screen-pixel snap threshold; existing edge/center/slide-frame snapping wins equal-distance ties. Alt temporarily disables all snap hints.

Render paired solid dimension lines with short endpoint ticks, using Miracle's existing accent color. The user explicitly excluded numeric/pixel labels: this is a spacing hint, not a design measurement tool. Ticks retain a constant screen size during zoom. Unlike alignment guides, spacing lines run through the gaps. Indicators disappear on release or cancellation; dragging remains a single undo action.

The common snapping path covers both boards and presentation slides. Use only current-slide objects and the existing painted bounds for shapes and arrows. Reject overlapping objects, blocked intervals and unrelated rows. Cache visible geometry and bound work to the existing board size limit. No persistence/schema changes or resizing behavior changes.

Implementation choice: extend existing transient guides with an optional spacing kind rather than creating a second state/lifecycle system.
