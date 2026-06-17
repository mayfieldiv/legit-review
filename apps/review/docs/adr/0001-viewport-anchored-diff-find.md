# Viewport-anchored diff-find selection

When the in-app diff find (Cmd/Ctrl-F) recomputes matches on a query or options
change, it selects the match closest to where the user is looking rather than
always jumping to the first match. "Where the user is looking" is tracked as an
**anchor**: a `{ itemId, lineNumber }` document position that is updated only by
deliberate user actions (opening find, manually scrolling, next/prev), never by
the auto-reveal that a query change triggers. This keeps a refined search near
the area you were already in instead of yanking you back to wherever a prior,
shorter query happened to land.

## Considered options

- **Detecting user-driven vs programmatic scroll.** We mirror the viewer's own
  input-source detection — `wheel`/`touchstart`/`pointerdown`/`keydown` on the
  scroll container mark a short window during which a scroll is user-driven.
  Programmatic reveals are never preceded by such input, so they are ignored,
  including the trailing scroll event fired just after a smooth scroll settles.
  We rejected reusing the viewer's private `scrollAnimation` state (would need a
  packages/diffs change, and has a race: that state clears on settle one frame
  before the final scroll event, which would clobber the anchor with the
  revealed position).

- **Measuring "closest".** We rank matches by linear line-distance in document
  order, not by pixel distance to the viewport. Off-screen matches have no DOM
  to measure, and document-order proximity is uniform, needs no per-match rect
  measurement, and matches the intuition that "the same area" means "nearby in
  the file listing." The anchor is resolved against the ordered-items list at
  compare time so it survives live-reload reorders.

## Consequences

- Manual scrolling moves the anchor but does not re-select the active match; the
  highlight only moves on a query/options change or next/prev. This matches
  conventional find behavior (scrolling to look around does not hijack the
  current match).
- If the closest match is already fully within the viewport, the active
  highlight moves to it without scrolling, so refining a query no longer
  recenters the view on most keystrokes.
