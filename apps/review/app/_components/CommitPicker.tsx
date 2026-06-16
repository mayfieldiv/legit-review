'use client';

import { Check, GitCommitHorizontal, Loader2, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { PortalPopover } from './PortalPopover';
import { Button } from '@/components/ui/button';
import type { CommitSummary } from '@/lib/git';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 100;

interface RepoCommitsState {
  commits: CommitSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore(): void;
}

// Loads commits newest-first for a repo, paged. Fetching is gated by `enabled`
// (and a non-empty repo path) so it only runs once a commit-scope mode is
// active and the repo has been resolved — not on every keystroke. The list is
// loaded once here and shared across the one or two CommitSelects a caller
// renders.
export function useRepoCommits(
  repoPath: string | null,
  enabled: boolean
): RepoCommitsState {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const skipRef = useRef(0);
  const requestRef = useRef(0);

  const fetchPage = useCallback(
    async (skip: number) => {
      if (repoPath == null || repoPath === '') {
        return;
      }
      const requestId = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          repo: repoPath,
          skip: String(skip),
          limit: String(PAGE_SIZE),
        });
        const response = await fetch(`/api/commits?${params}`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error((await response.text()).trim());
        }
        const data = (await response.json()) as {
          commits: CommitSummary[];
          hasMore: boolean;
        };
        if (requestRef.current !== requestId) {
          return;
        }
        setCommits((prev) =>
          skip === 0 ? data.commits : [...prev, ...data.commits]
        );
        setHasMore(data.hasMore);
        skipRef.current = skip + data.commits.length;
      } catch (caught) {
        if (requestRef.current !== requestId) {
          return;
        }
        setError(
          caught instanceof Error && caught.message !== ''
            ? caught.message
            : 'Failed to load commits.'
        );
      } finally {
        if (requestRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [repoPath]
  );

  useEffect(() => {
    if (!enabled || repoPath == null || repoPath === '') {
      return;
    }
    skipRef.current = 0;
    setCommits([]);
    setHasMore(false);
    void fetchPage(0);
  }, [enabled, repoPath, fetchPage]);

  const loadMore = useCallback(() => {
    if (!loading && hasMore) {
      void fetchPage(skipRef.current);
    }
  }, [fetchPage, hasMore, loading]);

  return { commits, loading, error, hasMore, loadMore };
}

interface CommitSelectProps {
  align?: 'start' | 'end';
  commits: CommitSummary[];
  disabled?: boolean;
  error: string | null;
  hasMore: boolean;
  label?: string;
  loading: boolean;
  onChange(commit: CommitSummary): void;
  onLoadMore(): void;
  placeholder?: string;
  triggerClassName?: string;
  value: CommitSummary | null;
}

// A commit dropdown: a button showing the chosen commit that opens a searchable
// (sha prefix or subject substring) scrollable list. Reused by the Open
// Repository form (single = one, range = two) and the in-review switcher.
export function CommitSelect({
  align = 'start',
  commits,
  disabled = false,
  error,
  hasMore,
  label,
  loading,
  onChange,
  onLoadMore,
  placeholder = 'Select commit',
  triggerClassName,
  value,
}: CommitSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    normalizedQuery === ''
      ? commits
      : commits.filter(
          (commit) =>
            commit.sha.toLowerCase().startsWith(normalizedQuery) ||
            commit.subject.toLowerCase().includes(normalizedQuery)
        );

  return (
    <div className="relative" ref={containerRef}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-expanded={open}
        className={cn(
          'w-full justify-start gap-2 font-normal',
          triggerClassName
        )}
        onClick={() => setOpen((current) => !current)}
      >
        <GitCommitHorizontal className="text-muted-foreground size-3.5 shrink-0" />
        {value == null ? (
          <span className="text-muted-foreground truncate">{placeholder}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-xs">{value.shortSha}</span>
            <span className="text-muted-foreground truncate">
              {value.subject}
            </span>
          </span>
        )}
      </Button>

      <PortalPopover
        anchorRef={containerRef}
        open={open}
        onClose={() => setOpen(false)}
        align={align}
        width={384}
        className="bg-popover text-popover-foreground z-[100] overflow-hidden rounded-md border shadow-lg"
      >
        {label != null && (
          <div className="text-muted-foreground border-b px-3 py-1.5 text-xs font-medium">
            {label}
          </div>
        )}
        <div className="border-b p-2">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
            <input
              autoFocus
              className="border-input bg-background focus-visible:ring-ring/50 h-8 w-full rounded-md border pr-2 pl-7 font-mono text-xs focus-visible:ring-2 focus-visible:outline-none"
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Filter by sha or message"
              type="text"
              value={query}
            />
          </div>
        </div>

        <div className="cv-mini-scrollbar max-h-72 overflow-y-auto overscroll-contain p-1">
          {error != null ? (
            <div className="text-destructive px-2 py-3 text-xs">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="text-muted-foreground px-2 py-3 text-xs">
              {loading ? 'Loading commits…' : 'No matching commits.'}
            </div>
          ) : (
            filtered.map((commit) => (
              <button
                key={commit.sha}
                type="button"
                className={cn(
                  'hover:bg-accent hover:text-accent-foreground flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left',
                  commit.sha === value?.sha &&
                    'bg-accent text-accent-foreground'
                )}
                onClick={() => {
                  onChange(commit);
                  setOpen(false);
                }}
              >
                <span className="mt-0.5 w-16 shrink-0 font-mono text-xs">
                  {commit.shortSha}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {commit.subject}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {commit.authorName}
                    {commit.authorDate !== ''
                      ? ` · ${formatCommitDate(commit.authorDate)}`
                      : ''}
                  </span>
                </span>
                {commit.sha === value?.sha && (
                  <Check className="mt-0.5 size-3.5 shrink-0" />
                )}
              </button>
            ))
          )}
          {hasMore && error == null && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground flex w-full items-center justify-center gap-1.5 rounded-sm px-2 py-2 text-xs"
              disabled={loading}
              onClick={onLoadMore}
            >
              {loading && <Loader2 className="size-3.5 animate-spin" />}
              Load more
            </button>
          )}
        </div>
      </PortalPopover>
    </div>
  );
}

function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}
