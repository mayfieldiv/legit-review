'use client';

import { type CodeViewItem } from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { type RefObject, useEffect, useRef, useState } from 'react';

import type { CommentMetadata } from './types';
import { type FindMatch, findMatches, type FindOptions } from '@/lib/diffFind';
import {
  clearFindHighlights,
  getFindScopes,
  repaintFind,
} from '@/lib/diffFindHighlight';

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

  // Reveals a match: expands its file if collapsed, then centers it. The active
  // highlight is resolved by item id, so it lands the instant the target row
  // mounts in the DOM — caught by the scroll/mutation observers below, no need
  // to poll for the (possibly smooth) scroll to settle.
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
      item.version = (item.version ?? 0) + 1;
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
  });

  const next = useStableCallback(() => goTo(activeIndexRef.current + 1));
  const prev = useStableCallback(() => goTo(activeIndexRef.current - 1));

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
