'use client';

import { type CodeViewItem } from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { type RefObject, useEffect, useRef, useState } from 'react';

import type { CommentMetadata } from './types';
import {
  type FindAnchor,
  findClosestMatchIndex,
  type FindMatch,
  findMatches,
  type FindOptions,
} from '@/lib/diffFind';
import {
  clearFindHighlights,
  getFindScopes,
  locateActiveRange,
  repaintFind,
} from '@/lib/diffFindHighlight';

const RECOMPUTE_DEBOUNCE_MS = 120;
// A scroll fired within this window of a user scroll-intent event (wheel,
// touch, scrollbar drag, or a navigation key) is treated as user-driven and
// moves the anchor. Programmatic reveals are never preceded by such input, so
// their scrolls — including the trailing one after a smooth scroll settles —
// fall outside the window and leave the anchor alone.
const USER_SCROLL_WINDOW_MS = 180;
// How long after starting a programmatic reveal we keep ignoring scrolls for
// anchoring. Comfortably longer than a smooth scroll; a user input event clears
// the guard sooner if they take over mid-animation.
const PROGRAMMATIC_SETTLE_MS = 600;
// Keys that scroll a focused scroll container. A keydown with one of these
// (outside a text field) counts as user scroll intent.
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

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
  // Whether the diff is currently shown. When false (error/empty/status panel)
  // the Cmd-F chord is left to the browser instead of opening an empty find.
  enabled: boolean;
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

// A focused text field where the native Cmd-F (or typing) should win.
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

export function useDiffFind({
  viewerRef,
  scrollRef,
  getOrderedItems,
  revision,
  enabled,
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
  const openRef = useRef(open);
  const enabledRef = useRef(enabled);
  const rafRef = useRef<number | null>(null);
  // The document position the user is looking at, in (itemId, lineNumber). It
  // is updated only by deliberate actions — opening find, manual scrolling, and
  // next/prev — never by the auto-reveal a query change triggers. On a query or
  // options change the match nearest this anchor is selected.
  const anchorRef = useRef<FindAnchor | null>(null);
  // High-res timestamp of the last user scroll-intent input, and a guard set
  // while one of our own programmatic reveals is in flight. Together they let a
  // scroll handler tell a manual scroll (move the anchor) from a reveal scroll
  // (leave it).
  const lastUserScrollInputAtRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimerRef = useRef<number | null>(null);
  const anchorRafRef = useRef<number | null>(null);
  queryRef.current = query;
  optionsRef.current = options;
  activeIndexRef.current = activeIndex;
  openRef.current = open;
  enabledRef.current = enabled;

  // Repaint both highlights from current state. The all-matches tint comes from
  // visible DOM text; the active match (matches[activeIndex]) is located in the
  // DOM of its owning item via the viewer's rendered-item map, so the orange
  // highlight always tracks the displayed ordinal rather than scroll geometry.
  const rebuildHighlights = useStableCallback(() => {
    const container = scrollRef.current;
    if (container == null) {
      clearFindHighlights();
      return;
    }
    const activeMatch = matchesRef.current[activeIndexRef.current] ?? null;
    let active: { element: HTMLElement; match: FindMatch } | null = null;
    if (activeMatch != null) {
      const rendered = viewerRef.current?.getInstance()?.getRenderedItems();
      const element =
        rendered?.find((item) => item.id === activeMatch.itemId)?.element ??
        null;
      if (element != null) {
        active = { element, match: activeMatch };
      }
    }
    repaintFind({
      scopes: getFindScopes(container),
      query: queryRef.current,
      options: optionsRef.current,
      active,
    });
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

  // Records that the user is about to scroll (wheel/touch/scrollbar/nav key).
  // Also drops the programmatic guard: if they take over mid-reveal, the
  // resulting scroll should re-anchor, mirroring the viewer aborting its own
  // smooth scroll on the same input.
  const markUserScrollInput = useStableCallback(() => {
    lastUserScrollInputAtRef.current = performance.now();
    programmaticScrollRef.current = false;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
      programmaticScrollTimerRef.current = null;
    }
  });

  // Marks the start of a programmatic reveal so the scrolls it produces don't
  // move the anchor. The guard auto-clears after the scroll has had time to
  // settle, since the viewer gives us no settle callback.
  const beginProgrammaticScroll = useStableCallback(() => {
    programmaticScrollRef.current = true;
    if (programmaticScrollTimerRef.current != null) {
      window.clearTimeout(programmaticScrollTimerRef.current);
    }
    programmaticScrollTimerRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimerRef.current = null;
    }, PROGRAMMATIC_SETTLE_MS);
  });

  // Captures the anchor from the line nearest the viewport's vertical center.
  // Only rendered lines can be measured, but the center line is always rendered,
  // so that is enough to record where the user is looking.
  const captureAnchorFromViewport = useStableCallback(() => {
    const container = scrollRef.current;
    const instance = viewerRef.current?.getInstance();
    if (container == null || instance == null) {
      return;
    }
    const rendered = instance.getRenderedItems();
    if (rendered.length === 0) {
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const centerY = containerRect.top + container.clientHeight / 2;
    let bestItemId: string | null = null;
    let bestLineNumber = 0;
    let bestDistance = Infinity;
    for (const item of rendered) {
      const scope = item.element.shadowRoot ?? item.element;
      for (const lineEl of scope.querySelectorAll('[data-line]')) {
        const lineNumber = Number(lineEl.getAttribute('data-line'));
        if (!Number.isFinite(lineNumber)) {
          continue;
        }
        const rect = lineEl.getBoundingClientRect();
        if (rect.height === 0) {
          continue;
        }
        const distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestItemId = item.id;
          bestLineNumber = lineNumber;
        }
      }
    }
    if (bestItemId != null) {
      anchorRef.current = { itemId: bestItemId, lineNumber: bestLineNumber };
    }
  });

  const scheduleAnchorCapture = useStableCallback(() => {
    if (anchorRafRef.current != null) {
      return;
    }
    anchorRafRef.current = requestAnimationFrame(() => {
      anchorRafRef.current = null;
      captureAnchorFromViewport();
    });
  });

  // Whether a match's row is rendered and fully inside the viewport. Used to
  // skip the scroll when the chosen match is already on screen, so refining a
  // query doesn't recenter the view on every keystroke.
  const isMatchVisible = useStableCallback((match: FindMatch): boolean => {
    const container = scrollRef.current;
    const instance = viewerRef.current?.getInstance();
    if (container == null || instance == null) {
      return false;
    }
    const rendered = instance
      .getRenderedItems()
      .find((item) => item.id === match.itemId);
    if (rendered == null) {
      return false;
    }
    const range = locateActiveRange(rendered.element, match);
    if (range == null) {
      return false;
    }
    const rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) {
      return false;
    }
    const containerRect = container.getBoundingClientRect();
    return rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
  });

  // Reveals a match: sets it active and, when `scroll` is true, expands its file
  // if collapsed and centers it. The active highlight is resolved by item id, so
  // it lands the instant the target row mounts in the DOM — caught by the
  // scroll/mutation observers below, no need to poll for the (possibly smooth)
  // scroll to settle. `anchorToMatch` moves the anchor to this match, which
  // next/prev want (deliberate navigation) but a query-change reveal does not.
  const revealMatch = useStableCallback(
    (index: number, opts: { scroll: boolean; anchorToMatch: boolean }) => {
      const matches = matchesRef.current;
      if (matches.length === 0) {
        return;
      }
      const clamped =
        ((index % matches.length) + matches.length) % matches.length;
      setActiveIndex(clamped);
      activeIndexRef.current = clamped;
      const match = matches[clamped];
      if (opts.anchorToMatch) {
        anchorRef.current = {
          itemId: match.itemId,
          lineNumber: match.lineNumber,
        };
      }
      const viewer = viewerRef.current;
      if (opts.scroll && viewer != null) {
        const item = viewer.getItem(match.itemId);
        if (item != null && item.collapsed === true) {
          item.collapsed = false;
          item.version = (item.version ?? 0) + 1;
          viewer.updateItem(item);
        }
        beginProgrammaticScroll();
        viewer.scrollTo({
          type: 'line',
          id: match.itemId,
          lineNumber: match.lineNumber,
          side: match.side,
          align: 'center',
          behavior: 'smooth',
        });
      }
      scheduleRebuild();
    }
  );

  const next = useStableCallback(() =>
    revealMatch(activeIndexRef.current + 1, {
      scroll: true,
      anchorToMatch: true,
    })
  );
  const prev = useStableCallback(() =>
    revealMatch(activeIndexRef.current - 1, {
      scroll: true,
      anchorToMatch: true,
    })
  );

  const openFind = useStableCallback(() => {
    setOpen(true);
    setFocusNonce((nonce) => nonce + 1);
  });

  const closeFind = useStableCallback(() => {
    setOpen(false);
    clearFindHighlights();
    scrollRef.current?.focus();
  });

  const setQuery = useStableCallback((nextQuery: string) =>
    setQueryState(nextQuery)
  );
  const setOptions = useStableCallback((nextOptions: FindOptions) =>
    setOptionsState(nextOptions)
  );

  // Recompute the match list (debounced) and reveal the match nearest the
  // anchor, so refining a query stays in the area the user is looking at instead
  // of jumping to the first match. If that match is already on screen, the
  // active highlight just moves to it — no scroll. Re-runs when the
  // query/options change, when find opens, or when the viewer remounts.
  useEffect(() => {
    if (!open) {
      return;
    }
    const handle = window.setTimeout(() => {
      const ordered = getOrderedItems();
      const matches = findMatches(ordered, query, options);
      matchesRef.current = matches;
      setCount(matches.length);
      if (matches.length > 0) {
        const orderIndex = new Map<string, number>();
        ordered.forEach((item, index) => orderIndex.set(item.id, index));
        const index = findClosestMatchIndex(
          matches,
          anchorRef.current,
          (id) => orderIndex.get(id) ?? -1
        );
        revealMatch(index, {
          scroll: !isMatchVisible(matches[index]),
          anchorToMatch: false,
        });
      } else {
        setActiveIndex(-1);
        activeIndexRef.current = -1;
        scheduleRebuild();
      }
    }, RECOMPUTE_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    open,
    query,
    options,
    revision,
    getOrderedItems,
    revealMatch,
    isMatchVisible,
    scheduleRebuild,
  ]);

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
    // A scroll always repaints; it additionally moves the anchor only when it
    // was user-driven — recent scroll-intent input and no reveal in flight. The
    // window is refreshed so a continuous gesture keeps re-anchoring.
    const onScroll = () => {
      scheduleRebuild();
      if (programmaticScrollRef.current) {
        return;
      }
      if (
        performance.now() - lastUserScrollInputAtRef.current >
        USER_SCROLL_WINDOW_MS
      ) {
        return;
      }
      lastUserScrollInputAtRef.current = performance.now();
      scheduleAnchorCapture();
    };
    container.addEventListener('scroll', onScroll, { passive: true });

    // Mirror the viewer's own user-scroll-intent set so we classify scrolls the
    // same way it does. wheel/touch/pointerdown are always intent; a keydown is
    // intent only for a scroll key outside a text field.
    const onKeyDownInput = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target) || !SCROLL_KEYS.has(event.key)) {
        return;
      }
      markUserScrollInput();
    };
    container.addEventListener('wheel', markUserScrollInput, { passive: true });
    container.addEventListener('touchstart', markUserScrollInput, {
      passive: true,
    });
    container.addEventListener('pointerdown', markUserScrollInput, {
      passive: true,
    });
    container.addEventListener('keydown', onKeyDownInput, { passive: true });

    const observedRoots = new WeakSet<ShadowRoot>();
    const shadowObservers: MutationObserver[] = [];
    const attachShadowObservers = () => {
      for (const scope of getFindScopes(container)) {
        if (!(scope instanceof ShadowRoot) || observedRoots.has(scope)) {
          continue;
        }
        observedRoots.add(scope);
        const observer = new MutationObserver(() => scheduleRebuild());
        observer.observe(scope, {
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
      container.removeEventListener('wheel', markUserScrollInput);
      container.removeEventListener('touchstart', markUserScrollInput);
      container.removeEventListener('pointerdown', markUserScrollInput);
      container.removeEventListener('keydown', onKeyDownInput);
      lightObserver.disconnect();
      for (const observer of shadowObservers) {
        observer.disconnect();
      }
      resizeObserver.disconnect();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (anchorRafRef.current != null) {
        cancelAnimationFrame(anchorRafRef.current);
        anchorRafRef.current = null;
      }
    };
  }, [
    open,
    scrollRef,
    scheduleRebuild,
    scheduleAnchorCapture,
    markUserScrollInput,
  ]);

  // Capture the anchor from the current viewport when find opens (and after the
  // viewer remounts on live reload), so the first query anchors to where the
  // user is looking rather than the top of the diff.
  useEffect(() => {
    if (!open) {
      return;
    }
    scheduleAnchorCapture();
  }, [open, revision, scheduleAnchorCapture]);

  // Cmd/Ctrl-F opens find and steals the chord from the browser's native find,
  // which can't see virtualized or collapsed content. Capture phase so we win
  // the event regardless of focus. We yield the chord back to the browser when
  // the diff isn't shown, or when the user is typing in another field (a
  // comment box) and find isn't already open — a second Cmd-F while find is
  // open still re-focuses its input.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isFindChord =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        (event.key === 'f' || event.key === 'F');
      if (!isFindChord || !enabledRef.current) {
        return;
      }
      if (!openRef.current && isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      openFind();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openFind]);

  useEffect(() => clearFindHighlights, []);

  // Drop the programmatic-scroll settle timer on unmount.
  useEffect(
    () => () => {
      if (programmaticScrollTimerRef.current != null) {
        window.clearTimeout(programmaticScrollTimerRef.current);
      }
    },
    []
  );

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
