import { type FindMatch, type FindOptions, matchLine } from './diffFind';

// Paints in-app find results onto the rendered diff using the CSS Custom
// Highlight API. Two concerns live here, kept separate on purpose:
//
//   - The all-matches tint is derived from the *visible DOM text*: every
//     occurrence of the query in a currently-rendered line is highlighted. This
//     is side-agnostic, so it correctly covers both columns of a split-view
//     context line (the model only enumerates context once, so deriving the
//     tint from the model would miss the second column).
//   - The active match is derived from the *model*: it is matches[activeIndex],
//     located in the DOM by (itemId, side, lineNumber, columnStart). This keeps
//     the highlighted occurrence in lockstep with the displayed ordinal instead
//     of guessing it from scroll geometry.

const ALL_HIGHLIGHT = 'cv-find';
const ACTIVE_HIGHLIGHT = 'cv-find-active';

export function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

export function clearFindHighlights(): void {
  if (!highlightsSupported()) {
    return;
  }
  CSS.highlights.delete(ALL_HIGHLIGHT);
  CSS.highlights.delete(ACTIVE_HIGHLIGHT);
}

// @pierre/diffs renders each line into a `diffs-container` web component's
// shadow DOM. CSS Custom Highlight ranges in a shadow tree are only painted by
// `::highlight()` rules in scope of that tree, so document-level styles don't
// reach them. We adopt this sheet into each container's shadow root. The
// all-matches tint keeps the token color; the active match forces
// black-on-orange (higher Highlight priority wins where the two overlap).
const FIND_HIGHLIGHT_CSS = `
::highlight(${ALL_HIGHLIGHT}) {
  background-color: light-dark(rgb(255 213 10 / 0.45), rgb(255 213 10 / 0.3));
}
::highlight(${ACTIVE_HIGHLIGHT}) {
  background-color: rgb(255 140 0 / 0.9);
  color: #000;
}`;

let findStyleSheet: CSSStyleSheet | null = null;

function getFindStyleSheet(): CSSStyleSheet | null {
  if (typeof CSSStyleSheet === 'undefined') {
    return null;
  }
  if (findStyleSheet == null) {
    findStyleSheet = new CSSStyleSheet();
    findStyleSheet.replaceSync(FIND_HIGHLIGHT_CSS);
  }
  return findStyleSheet;
}

function ensureFindStyles(root: ShadowRoot): void {
  const sheet = getFindStyleSheet();
  if (sheet == null || root.adoptedStyleSheets.includes(sheet)) {
    return;
  }
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}

// The scopes that hold rendered diff content: each `diffs-container`'s shadow
// root, or the container itself as a fallback if the web components ever render
// into the light DOM.
export function getFindScopes(
  container: HTMLElement
): (ShadowRoot | HTMLElement)[] {
  const roots: ShadowRoot[] = [];
  for (const element of container.querySelectorAll('diffs-container')) {
    const shadowRoot = (element as HTMLElement).shadowRoot;
    if (shadowRoot != null) {
      roots.push(shadowRoot);
    }
  }
  return roots.length > 0 ? roots : [container];
}

interface NodeSpan {
  node: Text;
  start: number;
  end: number;
}

// Concatenates an element's text nodes into a single string, recording where
// each node falls so a character offset can be mapped back to a DOM position.
// A rendered line is split into many text nodes by syntax-highlight token
// <span>s, so this stitches it back into one searchable line.
function buildSpans(element: Element): { spans: NodeSpan[]; text: string } {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const spans: NodeSpan[] = [];
  let text = '';
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    spans.push({
      node: node as Text,
      start: text.length,
      end: text.length + value.length,
    });
    text += value;
  }
  return { spans, text };
}

// Maps a character offset within the concatenated text back to the text node
// and in-node offset that contains it. Offsets that land on a node boundary
// resolve to the end of the earlier node, an equivalent DOM position for range
// endpoints.
function locateOffset(
  spans: NodeSpan[],
  offset: number
): { node: Text; offset: number } | null {
  for (const span of spans) {
    if (offset <= span.end) {
      return { node: span.node, offset: offset - span.start };
    }
  }
  if (spans.length === 0) {
    return null;
  }
  const last = spans[spans.length - 1];
  return { node: last.node, offset: last.node.length };
}

function rangeFromSpans(
  spans: NodeSpan[],
  columnStart: number,
  length: number
): Range | null {
  const start = locateOffset(spans, columnStart);
  const end = locateOffset(spans, columnStart + length);
  if (start == null || end == null) {
    return null;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

// Tint ranges for one rendered line: every occurrence of the query, matched
// against the line's own text so a query never spans a line break.
export function collectLineRanges(
  element: Element,
  query: string,
  options: FindOptions,
  out: Range[]
): void {
  const { spans, text } = buildSpans(element);
  if (text === '') {
    return;
  }
  for (const match of matchLine(text, query, options)) {
    const range = rangeFromSpans(spans, match.columnStart, match.length);
    if (range != null) {
      out.push(range);
    }
  }
}

// Does a rendered line element address the same (side, lineNumber) as a model
// match? `data-line-type` distinguishes the diff sides; context rows carry the
// line number of whichever column they render in, so a context match (modeled
// on the additions side) lands on the row whose `data-line` equals its addition
// number. A plain-file item has no side, so the line number alone identifies it.
function lineElementMatches(element: Element, match: FindMatch): boolean {
  const lineAttr = element.getAttribute('data-line');
  if (lineAttr == null || Number(lineAttr) !== match.lineNumber) {
    return false;
  }
  if (match.side == null) {
    return true;
  }
  const type = element.getAttribute('data-line-type');
  const change =
    match.side === 'additions' ? 'change-addition' : 'change-deletion';
  return type === change || type === 'context' || type === 'context-expanded';
}

// Locates the DOM range for one model match within its rendered item element.
// Returns null when the match's row is not currently rendered (virtualized out
// or inside a still-collapsed file), in which case the caller repaints once the
// row mounts.
export function locateActiveRange(
  itemElement: HTMLElement,
  match: FindMatch
): Range | null {
  const scope: ShadowRoot | HTMLElement = itemElement.shadowRoot ?? itemElement;
  for (const element of scope.querySelectorAll('[data-line]')) {
    if (!lineElementMatches(element, match)) {
      continue;
    }
    const { spans, text } = buildSpans(element);
    if (text === '') {
      continue;
    }
    return rangeFromSpans(spans, match.columnStart, match.length);
  }
  return null;
}

export interface RepaintFindParams {
  scopes: readonly (ShadowRoot | HTMLElement)[];
  query: string;
  options: FindOptions;
  // The active match and the rendered element of the item that owns it, or null
  // when there is no active match (or its item is not rendered).
  active: { element: HTMLElement; match: FindMatch } | null;
}

// Returns whether the active-match highlight was painted this call. The caller
// uses this to keep re-painting after a programmatic scroll until the active
// row has mounted: false means there is an active match but its row was not in
// the DOM yet (virtualized out, still scrolling, or content not rendered), so
// the orange highlight could not be placed.
export function repaintFind({
  scopes,
  query,
  options,
  active,
}: RepaintFindParams): boolean {
  if (!highlightsSupported()) {
    return false;
  }
  if (query === '') {
    clearFindHighlights();
    return false;
  }
  const ranges: Range[] = [];
  for (const scope of scopes) {
    if (scope instanceof ShadowRoot) {
      ensureFindStyles(scope);
    }
    const lineElements = scope.querySelectorAll(
      '[data-content] > *, [data-column-content]'
    );
    for (const element of lineElements) {
      collectLineRanges(element, query, options, ranges);
    }
  }
  if (ranges.length === 0) {
    clearFindHighlights();
    return false;
  }
  CSS.highlights.set(ALL_HIGHLIGHT, new Highlight(...ranges));

  const activeRange =
    active != null ? locateActiveRange(active.element, active.match) : null;
  if (activeRange != null) {
    const activeHighlight = new Highlight(activeRange);
    activeHighlight.priority = 1;
    CSS.highlights.set(ACTIVE_HIGHLIGHT, activeHighlight);
    return true;
  }
  CSS.highlights.delete(ACTIVE_HIGHLIGHT);
  return false;
}
