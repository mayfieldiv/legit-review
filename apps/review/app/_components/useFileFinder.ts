'use client';

import { useStableCallback } from '@pierre/diffs/react';
import { useEffect, useRef, useState } from 'react';

interface UseFileFinderParams {
  // Whether a diff is currently shown. When false (error/empty/status panel)
  // there are no files to jump to, so the chord is left to the browser.
  enabled: boolean;
}

export interface FileFinder {
  open: boolean;
  // Bumped on every open request so the palette re-focuses and re-selects its
  // input even when it is already mounted.
  focusNonce: number;
  openFinder: () => void;
  closeFinder: () => void;
}

// Cmd/Ctrl-P opens a VS Code-style quick-open palette for jumping to a file in
// the diff. The hook owns only the open/closed state and the global chord; the
// palette UI lives in FileFinder. We steal the chord from the browser's print
// dialog (capture phase, preventDefault) since print is useless on the diff
// view, and a second press toggles the palette closed. The chord fires from
// anywhere, including while a comment editor is focused, because the palette's
// own input takes focus the moment it opens.
export function useFileFinder({ enabled }: UseFileFinderParams): FileFinder {
  const [open, setOpen] = useState(false);
  const [focusNonce, setFocusNonce] = useState(0);
  const openRef = useRef(open);
  const enabledRef = useRef(enabled);
  openRef.current = open;
  enabledRef.current = enabled;

  const openFinder = useStableCallback(() => {
    setOpen(true);
    setFocusNonce((nonce) => nonce + 1);
  });
  const closeFinder = useStableCallback(() => {
    setOpen(false);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isChord =
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'p' || event.key === 'P');
      if (!isChord || !enabledRef.current) {
        return;
      }
      event.preventDefault();
      if (openRef.current) {
        closeFinder();
      } else {
        openFinder();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openFinder, closeFinder]);

  // Close the palette if the diff goes away (e.g. a live reload drops into the
  // error/empty state) so it can't linger over a screen with no files.
  useEffect(() => {
    if (!enabled && open) {
      setOpen(false);
    }
  }, [enabled, open]);

  return { open, focusNonce, openFinder, closeFinder };
}
