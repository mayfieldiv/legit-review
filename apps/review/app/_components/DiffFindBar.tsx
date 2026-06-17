'use client';

import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  WholeWord,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';

import type { DiffFind } from './useDiffFind';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DiffFindBarProps {
  find: DiffFind;
}

// Floating find bar overlaid on the diff pane, modeled on the browser/VS Code
// find widget. It is purely presentational — all search state and navigation
// live in useDiffFind.
export function DiffFindBar({ find }: DiffFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select the query whenever find is (re)opened, so a second Cmd-F
  // selects the existing term for quick replacement.
  useEffect(() => {
    if (!find.open) {
      return;
    }
    const input = inputRef.current;
    if (input != null) {
      input.focus();
      input.select();
    }
  }, [find.open, find.focusNonce]);

  if (!find.open) {
    return null;
  }

  const hasQuery = find.query !== '';
  const noResults = hasQuery && find.count === 0;

  return (
    <div className="pointer-events-none absolute top-3 right-4 z-20 [grid-area:viewer]">
      <div className="bg-popover text-popover-foreground pointer-events-auto flex items-center gap-1 rounded-lg border p-1 shadow-lg">
        <input
          ref={inputRef}
          aria-label="Find in diff"
          className={cn(
            'h-7 w-52 rounded-md bg-transparent px-2 text-sm outline-none',
            'placeholder:text-muted-foreground',
            noResults && 'text-destructive'
          )}
          placeholder="Find in diff"
          spellCheck={false}
          value={find.query}
          onChange={(event) => find.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (event.shiftKey) {
                find.prev();
              } else {
                find.next();
              }
            } else if (event.key === 'Escape') {
              event.preventDefault();
              find.closeFind();
            }
          }}
        />
        <span className="text-muted-foreground min-w-14 px-1 text-right text-xs tabular-nums">
          {noResults
            ? 'No results'
            : hasQuery
              ? `${find.activeOrdinal}/${find.count}`
              : ''}
        </span>
        <Toggle
          active={find.options.caseSensitive}
          label="Match case"
          onClick={() =>
            find.setOptions({
              ...find.options,
              caseSensitive: !find.options.caseSensitive,
            })
          }
        >
          <CaseSensitive className="size-4" />
        </Toggle>
        <Toggle
          active={find.options.wholeWord}
          label="Match whole word"
          onClick={() =>
            find.setOptions({
              ...find.options,
              wholeWord: !find.options.wholeWord,
            })
          }
        >
          <WholeWord className="size-4" />
        </Toggle>
        <div className="bg-border mx-0.5 h-5 w-px" />
        <Button
          aria-label="Previous match"
          className="hover:text-muted-foreground hover:bg-transparent"
          disabled={find.count === 0}
          onClick={find.prev}
          size="icon-sm"
          title="Previous match (Shift+Enter)"
          variant="ghost"
        >
          <ChevronUp className="size-4" />
        </Button>
        <Button
          aria-label="Next match"
          className="hover:text-muted-foreground hover:bg-transparent"
          disabled={find.count === 0}
          onClick={find.next}
          size="icon-sm"
          title="Next match (Enter)"
          variant="ghost"
        >
          <ChevronDown className="size-4" />
        </Button>
        <Button
          aria-label="Close find"
          className="hover:text-muted-foreground hover:bg-transparent"
          onClick={find.closeFind}
          size="icon-sm"
          title="Close (Esc)"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// A small icon button that reads as pressed when its option is on.
function Toggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'hover:bg-accent',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground bg-transparent'
      )}
      onClick={onClick}
      size="icon-sm"
      title={label}
      variant="ghost"
    >
      {children}
    </Button>
  );
}
