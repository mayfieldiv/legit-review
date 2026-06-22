'use client';

import { Search } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { CodeViewFileTreeSource } from './types';
import type { FileFinder as FileFinderState } from './useFileFinder';
import { filterPaths } from '@/lib/fuzzyFileFilter';
import { cn } from '@/lib/utils';

// Cap on rendered rows. The palette is a quick-jump, not a browser: a few dozen
// candidates is plenty, and bounding the list keeps filtering and rendering
// cheap on a large diff.
const MAX_RESULTS = 50;

interface FileFinderProps {
  finder: FileFinderState;
  source: CodeViewFileTreeSource;
  // Called with the tree item id of the chosen file. Wired to the same handler
  // the sidebar uses, so it expands the file if collapsed and scrolls to it.
  onSelectFile(itemId: string): void;
}

// A VS Code-style "Go to File" palette: Cmd/Ctrl-P opens it, you type to fuzzy
// filter the diff's files, and Enter (or a click) jumps to the selected one.
// Rendered into document.body so it escapes the diff grid's `contain: paint`
// clipping (same reason PortalPopover portals).
export function FileFinder({ finder, source, onSelectFile }: FileFinderProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // The snapshot aliases the live streaming accumulator, so bound the slice by
  // the captured pathCount and recompute only when the source changes.
  const paths = useMemo(
    () => source.paths.slice(0, source.pathCount),
    [source.paths, source.pathCount]
  );
  const results = useMemo(
    () => filterPaths(paths, query.trim(), MAX_RESULTS),
    [paths, query]
  );

  // Focus and clear the palette every time it is (re)opened so it always starts
  // empty on the file list, mirroring VS Code's quick open.
  useEffect(() => {
    if (!finder.open) {
      return;
    }
    setQuery('');
    setActiveIndex(0);
    const input = inputRef.current;
    if (input != null) {
      input.focus();
      input.select();
    }
  }, [finder.open, finder.focusNonce]);

  // Keep the highlighted row scrolled into view as the user arrows through it.
  useEffect(() => {
    if (!finder.open) {
      return;
    }
    const row = listRef.current?.querySelector(`[data-index='${activeIndex}']`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, finder.open]);

  if (!finder.open || typeof document === 'undefined') {
    return null;
  }

  const select = (path: string) => {
    const itemId = source.pathToItemId.get(path);
    if (itemId != null) {
      onSelectFile(itemId);
    }
    finder.closeFinder();
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      finder.closeFinder();
      return;
    }
    if (results.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(results.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const match = results[Math.min(activeIndex, results.length - 1)];
      if (match != null) {
        select(match.path);
      }
    }
  };

  const clampedActive = Math.min(activeIndex, Math.max(0, results.length - 1));

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-center">
      <button
        type="button"
        aria-label="Close file finder"
        className="bg-background/60 absolute inset-0 cursor-default backdrop-blur-xs"
        onClick={finder.closeFinder}
      />
      <div
        role="dialog"
        aria-label="Go to file"
        aria-modal="true"
        className="bg-popover text-popover-foreground relative mt-[12vh] flex max-h-[70vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-xl border shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            ref={inputRef}
            aria-label="Go to file"
            className="placeholder:text-muted-foreground h-11 flex-1 bg-transparent text-sm outline-none"
            placeholder="Go to file"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKeyDown}
          />
        </div>
        {results.length === 0 ? (
          <div className="text-muted-foreground px-3 py-6 text-center text-sm">
            No matching files
          </div>
        ) : (
          <ul
            ref={listRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
          >
            {results.map((match, index) => (
              <FileRow
                key={match.path}
                active={index === clampedActive}
                index={index}
                match={match}
                onPick={() => select(match.path)}
                onHover={() => setActiveIndex(index)}
              />
            ))}
          </ul>
        )}
        <div className="text-muted-foreground flex items-center justify-between border-t px-3 py-1.5 text-[11px]">
          <span>
            <kbd className="font-sans">↑↓</kbd> navigate{'  '}
            <kbd className="font-sans">↵</kbd> open{'  '}
            <kbd className="font-sans">esc</kbd> dismiss
          </span>
          <span className="tabular-nums">
            {results.length}
            {results.length === MAX_RESULTS ? '+' : ''}
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface FileRowProps {
  active: boolean;
  index: number;
  match: { path: string; positions: number[] };
  onPick(): void;
  onHover(): void;
}

function FileRow({ active, index, match, onPick, onHover }: FileRowProps) {
  const { path, positions } = match;
  const positionSet = useMemo(() => new Set(positions), [positions]);
  const lastSlash = path.lastIndexOf('/');
  const basename = path.slice(lastSlash + 1);
  const directory = lastSlash > 0 ? path.slice(0, lastSlash) : '';

  return (
    <li data-index={index}>
      <button
        type="button"
        aria-selected={active}
        className={cn(
          'flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm',
          active ? 'bg-accent text-accent-foreground' : 'text-foreground'
        )}
        // Select on mousedown rather than click so the input losing focus
        // doesn't race the selection.
        onMouseDown={(event) => {
          event.preventDefault();
          onPick();
        }}
        onMouseMove={onHover}
      >
        <span className="truncate">
          {renderHighlighted(basename, lastSlash + 1, positionSet)}
        </span>
        {directory !== '' && (
          <span className="text-muted-foreground ml-auto truncate text-xs">
            {renderHighlighted(directory, 0, positionSet)}
          </span>
        )}
      </button>
    </li>
  );
}

// Renders `text` (a slice of the path beginning at absolute index `offset`)
// with the fuzzy-matched characters emphasized. Matched runs get a faint
// current-color highlight so they read against any Shiki theme.
function renderHighlighted(
  text: string,
  offset: number,
  positions: ReadonlySet<number>
): ReactNode {
  const nodes: ReactNode[] = [];
  let run = '';
  let runMatched = false;
  let key = 0;
  const flush = () => {
    if (run === '') {
      return;
    }
    nodes.push(
      runMatched ? (
        <span
          key={key++}
          className="rounded-[3px] bg-[color-mix(in_srgb,currentColor_22%,transparent)] font-semibold"
        >
          {run}
        </span>
      ) : (
        <span key={key++}>{run}</span>
      )
    );
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const matched = positions.has(offset + i);
    if (matched !== runMatched) {
      flush();
      runMatched = matched;
    }
    run += text[i];
  }
  flush();
  return nodes;
}
