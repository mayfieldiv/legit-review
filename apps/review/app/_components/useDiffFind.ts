'use client';

import { type CodeViewItem } from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { type RefObject, useEffect, useRef, useState } from 'react';

import type { CommentMetadata } from './types';
import {
  type FindMatch,
  findMatches,
  type FindOptions,
  matchLine,
} from '@/lib/diffFind';

const ALL_HIGHLIGHT = 'cv-find';
const ACTIVE_HIGHLIGHT = 'cv-find-active';
const RECOMPUTE_DEBOUNCE_MS = 120;

interface UseDiffFindParams {
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  // Full set of loaded items in display order, including collapsed/virtualized
  // ones. Searching this (not the DOM) is what lets find reach content the
  // browser's native Cmd-F can't.
  getOrderedItems: () => readonly CodeViewItem<CommentMetadata>[];
  // Bumped whenever the viewer remounts (e.g. a live diff reload) so stale
  // matches against old item ids are recomputed.
  revision: unknown;
}

export interface DiffFind {
  open: boolean;
  query: string;
  options: FindOptions;
  count: number;
  // 1-based index of the active match for display; 0 when there are none.
  activeOrdinal: number;
  focusNonce: number;
  openFind: () => void;
  closeFind: () => void;
  setQuery: (query: string) => void;
  setOptions: (options: FindOptions) => void;
  next: () => void;
  prev: () => void;
}

const DEFAULT_OPTIONS: FindOptions = { caseSensitive: false, wholeWord: false };

function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

function clearHighlights(): void {
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

// The shadow roots that actually hold rendered diff content. Usually a single
// container, but handled as a list to stay robust.
function getContentShadowRoots(container: HTMLElement): ShadowRoot[] {
  const roots: ShadowRoot[] = [];
  for (const element of container.querySelectorAll('diffs-container')) {
    const shadowRoot = (element as HTMLElement).shadowRoot;
    if (shadowRoot != null) {
      roots.push(shadowRoot);
    }
  }
  return roots;
}

interface NodeSpan {
  node: Text;
  start: number;
  end: number;
}

// Maps a character offset within an element's concatenated text back to the
// text node and in-node offset that contains it. Offsets that land on a node
// boundary resolve to the end of the earlier node, which is an equivalent DOM
// position for range endpoints.
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

// Builds highlight ranges for one rendered line element. Matching is scoped to
// a single line so a query never spans a line break, and the offset map stitches
// matches back together across the syntax-highlight token <span>s that split a
// line into many text nodes.
function collectLineRanges(
  element: Element,
  query: string,
  options: FindOptions,
  out: Range[]
): void {
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
  if (text === '') {
    return;
  }
  for (const match of matchLine(text, query, options)) {
    const start = locateOffset(spans, match.columnStart);
    const end = locateOffset(spans, match.columnStart + match.length);
    if (start == null || end == null) {
      continue;
    }
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    out.push(range);
  }
}

// The active match is the one nearest the scroll viewport's vertical center.
// Navigation centers its target via scrollTo, so right after a jump this is the
// navigated match; during manual scrolling it tracks whatever is centered.
function pickActiveRange(
  container: HTMLElement,
  ranges: Range[]
): Range | null {
  const containerRect = container.getBoundingClientRect();
  const centerY = containerRect.top + containerRect.height / 2;
  let best: Range | null = null;
  let bestDistance = Infinity;
  for (const range of ranges) {
    const rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) {
      continue;
    }
    const distance = Math.abs(rect.top + rect.height / 2 - centerY);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = range;
    }
  }
  return best;
}

export function useDiffFind({
  viewerRef,
  scrollRef,
  getOrderedItems,
  revision,
}: UseDiffFindParams): DiffFind {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [options, setOptionsState] = useState<FindOptions>(DEFAULT_OPTIONS);
  const [count, setCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [focusNonce, setFocusNonce] = useState(0);

  // Refs mirror state so the stable callbacks and observers below read current
  // values without re-subscribing.
  const matchesRef = useRef<FindMatch[]>([]);
  const queryRef = useRef(query);
  const optionsRef = useRef(options);
  const activeIndexRef = useRef(activeIndex);
  const rafRef = useRef<number | null>(null);
  queryRef.current = query;
  optionsRef.current = options;
  activeIndexRef.current = activeIndex;

  const rebuildHighlights = useStableCallback(() => {
    if (!highlightsSupported()) {
      return;
    }
    const container = scrollRef.current;
    const currentQuery = queryRef.current;
    if (container == null || currentQuery === '') {
      clearHighlights();
      return;
    }
    const ranges: Range[] = [];
    const shadowRoots = getContentShadowRoots(container);
    // Fall back to the light DOM if the web components ever render there.
    const scopes: (ShadowRoot | HTMLElement)[] =
      shadowRoots.length > 0 ? shadowRoots : [container];
    for (const scope of scopes) {
      if (scope instanceof ShadowRoot) {
        ensureFindStyles(scope);
      }
      const lineElements = scope.querySelectorAll(
        '[data-content] > *, [data-column-content]'
      );
      for (const element of lineElements) {
        collectLineRanges(element, currentQuery, optionsRef.current, ranges);
      }
    }
    if (ranges.length === 0) {
      clearHighlights();
      return;
    }
    CSS.highlights.set(ALL_HIGHLIGHT, new Highlight(...ranges));
    const active = pickActiveRange(container, ranges);
    if (active != null) {
      const activeHighlight = new Highlight(active);
      activeHighlight.priority = 1;
      CSS.highlights.set(ACTIVE_HIGHLIGHT, activeHighlight);
    } else {
      CSS.highlights.delete(ACTIVE_HIGHLIGHT);
    }
  });

  const scheduleRebuild = useStableCallback(() => {
    if (rafRef.current != null) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      rebuildHighlights();
    });
  });

  // Reveals a match: expands its file if collapsed, then centers it. Highlights
  // are rebuilt now and again shortly after, since the target row may not exist
  // in the DOM until the (possibly smooth) scroll brings it into the window.
  const goTo = useStableCallback((index: number) => {
    const matches = matchesRef.current;
    if (matches.length === 0) {
      return;
    }
    const clamped =
      ((index % matches.length) + matches.length) % matches.length;
    setActiveIndex(clamped);
    activeIndexRef.current = clamped;
    const match = matches[clamped];
    const viewer = viewerRef.current;
    if (viewer == null) {
      return;
    }
    const item = viewer.getItem(match.itemId);
    if (item != null && item.collapsed === true) {
      item.collapsed = false;
      item.version = typeof item.version === 'number' ? item.version + 1 : 1;
      viewer.updateItem(item);
    }
    viewer.scrollTo({
      type: 'line',
      id: match.itemId,
      lineNumber: match.lineNumber,
      side: match.side,
      align: 'center',
      behavior: 'smooth',
    });
    scheduleRebuild();
    window.setTimeout(scheduleRebuild, 120);
    window.setTimeout(scheduleRebuild, 350);
  });

  const next = useStableCallback(() => goTo(activeIndexRef.current + 1));
  const prev = useStableCallback(() => goTo(activeIndexRef.current - 1));

  const openFind = useStableCallback(() => {
    setOpen(true);
    setFocusNonce((nonce) => nonce + 1);
  });

  const closeFind = useStableCallback(() => {
    setOpen(false);
    clearHighlights();
    scrollRef.current?.focus();
  });

  const setQuery = useStableCallback((nextQuery: string) =>
    setQueryState(nextQuery)
  );
  const setOptions = useStableCallback((nextOptions: FindOptions) =>
    setOptionsState(nextOptions)
  );

  // Recompute the match list (debounced) and reveal the first match, the way
  // find-as-you-type works. Re-runs when the query/options change, when find
  // opens, or when the viewer remounts (revision).
  useEffect(() => {
    if (!open) {
      return;
    }
    const handle = window.setTimeout(() => {
      const matches = findMatches(getOrderedItems(), query, options);
      matchesRef.current = matches;
      setCount(matches.length);
      if (matches.length > 0) {
        goTo(0);
      } else {
        setActiveIndex(-1);
        activeIndexRef.current = -1;
        scheduleRebuild();
      }
    }, RECOMPUTE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [open, query, options, revision, getOrderedItems, goTo, scheduleRebuild]);

  // While find is open, rebuild highlights as the virtualizer renders new rows,
  // as the user scrolls, and on container resize. The rendered rows live inside
  // the diffs-container shadow root, whose mutations don't bubble to the light
  // DOM, so we observe each shadow root directly (and the light container only
  // to notice a shadow root appearing or being replaced).
  useEffect(() => {
    if (!open) {
      return;
    }
    const container = scrollRef.current;
    if (container == null) {
      return;
    }
    const onScroll = () => scheduleRebuild();
    container.addEventListener('scroll', onScroll, { passive: true });

    const observedRoots = new WeakSet<ShadowRoot>();
    const shadowObservers: MutationObserver[] = [];
    const attachShadowObservers = () => {
      for (const shadowRoot of getContentShadowRoots(container)) {
        if (observedRoots.has(shadowRoot)) {
          continue;
        }
        observedRoots.add(shadowRoot);
        const observer = new MutationObserver(() => scheduleRebuild());
        observer.observe(shadowRoot, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        shadowObservers.push(observer);
      }
    };
    attachShadowObservers();

    const lightObserver = new MutationObserver(() => {
      attachShadowObservers();
      scheduleRebuild();
    });
    lightObserver.observe(container, { childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(() => scheduleRebuild());
    resizeObserver.observe(container);
    scheduleRebuild();
    return () => {
      container.removeEventListener('scroll', onScroll);
      lightObserver.disconnect();
      for (const observer of shadowObservers) {
        observer.disconnect();
      }
      resizeObserver.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [open, scrollRef, scheduleRebuild]);

  // Cmd/Ctrl-F opens find and steals the chord from the browser's native find,
  // which can't see virtualized or collapsed content. Capture phase so we win
  // the event regardless of focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        (event.key === 'f' || event.key === 'F')
      ) {
        event.preventDefault();
        openFind();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openFind]);

  useEffect(() => clearHighlights, []);

  return {
    open,
    query,
    options,
    count,
    activeOrdinal: activeIndex >= 0 ? activeIndex + 1 : 0,
    focusNonce,
    openFind,
    closeFind,
    setQuery,
    setOptions,
    next,
    prev,
  };
}
