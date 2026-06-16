'use client';

import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  GitCompareArrows,
  Loader2,
  PencilLine,
  Upload,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { CommitSelect, useRepoCommits } from './CommitPicker';
import type {
  CommitSummary,
  RepoReviewScopes,
  ReviewScopeId,
  ReviewScopeOption,
} from '@/lib/git';
import { cn } from '@/lib/utils';

// The form tracks the three server-resolved working-tree scopes plus two local
// commit-scope modes that require picking commits from a list.
type FormScope = ReviewScopeId | 'single-commit' | 'commit-range';

const FALLBACK_OPTIONS: ReviewScopeOption[] = [
  {
    id: 'branch-base',
    label: 'Branch base',
    shortLabel: 'Base',
    baseRef: null,
    refLabel: 'auto',
    detail: 'Auto-detect branch base',
    badge: 'auto',
    available: true,
    hasChanges: false,
  },
  {
    id: 'unpushed',
    label: 'Unpushed changes',
    shortLabel: 'Unpushed',
    baseRef: null,
    refLabel: 'upstream',
    detail: 'Enter a repository path',
    badge: 'unknown',
    available: false,
    hasChanges: false,
    disabledReason: 'Enter a valid repository path',
  },
  {
    id: 'uncommitted',
    label: 'Uncommitted changes',
    shortLabel: 'Uncommitted',
    baseRef: 'HEAD',
    refLabel: 'HEAD',
    detail: 'Enter a repository path',
    badge: 'unknown',
    available: false,
    hasChanges: false,
    disabledReason: 'Enter a valid repository path',
  },
];

export function RepoReviewForm() {
  const [repo, setRepo] = useState('');
  const [selectedScope, setSelectedScope] = useState<FormScope>('branch-base');
  const [scopes, setScopes] = useState<RepoReviewScopes | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Commit-scope selections, kept independent so switching modes preserves them.
  const [singleCommit, setSingleCommit] = useState<CommitSummary | null>(null);
  const [rangeStart, setRangeStart] = useState<CommitSummary | null>(null);
  const [rangeEnd, setRangeEnd] = useState<CommitSummary | null>(null);

  useEffect(() => {
    setScopes(null);
    setErrorMessage(null);

    if (repo.trim() === '') {
      setIsLoading(false);
      setSelectedScope('branch-base');
      return;
    }

    const controller = new AbortController();
    const inspectRepo = async () => {
      setIsLoading(true);
      try {
        const response = await fetch(
          `/api/repo-scopes?repo=${encodeURIComponent(repo)}`,
          { cache: 'no-store', signal: controller.signal }
        );
        if (!response.ok) {
          throw new Error((await response.text()).trim());
        }

        const nextScopes = (await response.json()) as RepoReviewScopes;
        setScopes(nextScopes);
        setSelectedScope((current) =>
          isCommitScope(current) ||
          optionById(nextScopes.options, current)?.available === true
            ? current
            : 'branch-base'
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setSelectedScope('branch-base');
        setErrorMessage(
          error instanceof Error && error.message !== ''
            ? error.message
            : 'Unable to inspect repository.'
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    };
    const timeout = window.setTimeout(() => {
      void inspectRepo();
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [repo]);

  const options = scopes?.options ?? FALLBACK_OPTIONS;
  const selectedOption =
    optionById(options, selectedScope) ?? optionById(options, 'branch-base');
  const baseValue =
    selectedOption?.available === true ? (selectedOption.baseRef ?? '') : '';

  const statusPills = useMemo(
    () => (scopes == null ? [] : buildStatusPills(scopes)),
    [scopes]
  );

  // Commits load only while a commit-scope mode is active and the repo has been
  // resolved. The canonical repo path from /api/repo-scopes keys the fetch so
  // it doesn't refire on every keystroke.
  const commitScopeActive = isCommitScope(selectedScope);
  const commitState = useRepoCommits(
    scopes?.repoPath ?? null,
    commitScopeActive
  );

  const commitSelectionIncomplete =
    (selectedScope === 'single-commit' && singleCommit == null) ||
    (selectedScope === 'commit-range' &&
      (rangeStart == null || rangeEnd == null));

  return (
    <form action="/review" method="get" className="space-y-4">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Repository path</span>
        <input
          autoFocus
          className="border-input bg-background focus-visible:ring-ring/50 block h-9 w-full rounded-md border px-3 font-mono text-sm focus-visible:ring-2 focus-visible:outline-none"
          name="repo"
          onChange={(event) => setRepo(event.currentTarget.value)}
          placeholder="/absolute/path/to/repo"
          required
          type="text"
          value={repo}
        />
      </label>

      {/* Only the inputs for the active scope are rendered, so the native GET
          submit carries exactly one scope's params. */}
      {selectedScope === 'single-commit' ? (
        singleCommit != null && (
          <input name="commit" type="hidden" value={singleCommit.sha} />
        )
      ) : selectedScope === 'commit-range' ? (
        <>
          {rangeStart != null && (
            <input name="from" type="hidden" value={rangeStart.sha} />
          )}
          {rangeEnd != null && (
            <input name="to" type="hidden" value={rangeEnd.sha} />
          )}
        </>
      ) : (
        <input name="base" type="hidden" value={baseValue} />
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Review scope</legend>
        <div className="grid gap-2">
          {options.map((option) => (
            <ScopeButton
              key={option.id}
              option={option}
              selected={option.id === selectedScope}
              onSelect={() => setSelectedScope(option.id)}
            />
          ))}
          <ModeButton
            detail="Review one commit's changes (git show)"
            icon={
              <GitCommitHorizontal className="text-muted-foreground size-4 shrink-0" />
            }
            label="Single commit"
            onSelect={() => setSelectedScope('single-commit')}
            selected={selectedScope === 'single-commit'}
          />
          <ModeButton
            detail="Review the diff across a span of commits"
            icon={
              <GitCompare className="text-muted-foreground size-4 shrink-0" />
            }
            label="Commit range"
            onSelect={() => setSelectedScope('commit-range')}
            selected={selectedScope === 'commit-range'}
          />
        </div>
      </fieldset>

      {commitScopeActive && (
        <div className="space-y-2">
          {scopes == null ? (
            <p className="text-muted-foreground text-xs">
              Enter a repository path to choose commits.
            </p>
          ) : selectedScope === 'single-commit' ? (
            <CommitSelect
              commits={commitState.commits}
              error={commitState.error}
              hasMore={commitState.hasMore}
              loading={commitState.loading}
              onChange={setSingleCommit}
              onLoadMore={commitState.loadMore}
              placeholder="Select a commit"
              value={singleCommit}
            />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">
                  Start (older, inclusive)
                </span>
                <CommitSelect
                  commits={commitState.commits}
                  error={commitState.error}
                  hasMore={commitState.hasMore}
                  loading={commitState.loading}
                  onChange={setRangeStart}
                  onLoadMore={commitState.loadMore}
                  placeholder="Start commit"
                  value={rangeStart}
                />
              </label>
              <label className="space-y-1">
                <span className="text-muted-foreground text-xs">
                  End (newer, inclusive)
                </span>
                <CommitSelect
                  align="end"
                  commits={commitState.commits}
                  error={commitState.error}
                  hasMore={commitState.hasMore}
                  loading={commitState.loading}
                  onChange={setRangeEnd}
                  onLoadMore={commitState.loadMore}
                  placeholder="End commit"
                  value={rangeEnd}
                />
              </label>
            </div>
          )}
        </div>
      )}

      <div className="min-h-6">
        {errorMessage != null ? (
          <div className="text-destructive flex items-start gap-1.5 text-xs">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        ) : isLoading ? (
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin" />
            <span>Checking repository</span>
          </div>
        ) : scopes == null ? (
          <div className="text-muted-foreground text-xs">
            Enter a repository path to inspect local state.
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {statusPills.map((pill) => (
              <span
                key={pill.label}
                className={cn(
                  'inline-flex min-h-6 items-center gap-1 rounded-md border px-2 py-0.5 text-xs',
                  pill.active
                    ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100'
                    : 'border-border bg-muted text-muted-foreground'
                )}
              >
                {pill.active ? (
                  <AlertCircle className="size-3.5" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
                {pill.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55"
        disabled={commitSelectionIncomplete}
        type="submit"
      >
        <GitCompareArrows className="size-4" />
        Review
      </button>
    </form>
  );
}

function ScopeButton({
  onSelect,
  option,
  selected,
}: {
  onSelect: () => void;
  option: ReviewScopeOption;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        'border-border bg-background focus-visible:ring-ring/50 grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-3 py-2 text-left transition focus-visible:ring-2 focus-visible:outline-none',
        selected &&
          'border-foreground bg-accent text-accent-foreground shadow-xs',
        option.available
          ? 'hover:bg-accent/80'
          : 'cursor-not-allowed opacity-55'
      )}
      disabled={!option.available}
      onClick={onSelect}
      title={option.available ? undefined : option.disabledReason}
      type="button"
    >
      <ScopeIcon id={option.id} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">
          {option.label}
        </span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {option.detail}
        </span>
      </span>
      <span
        className={cn(
          'rounded border px-1.5 py-0.5 font-mono text-[11px]',
          option.hasChanges
            ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100'
            : 'border-border bg-muted text-muted-foreground'
        )}
      >
        {option.badge}
      </span>
    </button>
  );
}

// A scope button for the commit-scope modes, which carry no server-resolved
// badge (you pick the commits below instead).
function ModeButton({
  detail,
  icon,
  label,
  onSelect,
  selected,
}: {
  detail: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        'border-border bg-background focus-visible:ring-ring/50 grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border px-3 py-2 text-left transition hover:bg-accent/80 focus-visible:ring-2 focus-visible:outline-none',
        selected &&
          'border-foreground bg-accent text-accent-foreground shadow-xs'
      )}
      onClick={onSelect}
      type="button"
    >
      {icon}
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {detail}
        </span>
      </span>
    </button>
  );
}

function ScopeIcon({ id }: { id: ReviewScopeId }) {
  const className = 'text-muted-foreground size-4 shrink-0';
  if (id === 'unpushed') {
    return <Upload className={className} />;
  }
  if (id === 'uncommitted') {
    return <PencilLine className={className} />;
  }
  return <GitBranch className={className} />;
}

function isCommitScope(scope: FormScope): boolean {
  return scope === 'single-commit' || scope === 'commit-range';
}

function optionById(
  options: ReviewScopeOption[],
  id: string
): ReviewScopeOption | undefined {
  return options.find((option) => option.id === id);
}

function buildStatusPills(scopes: RepoReviewScopes): {
  active: boolean;
  label: string;
}[] {
  return [
    {
      active: scopes.hasUncommittedChanges,
      label: scopes.hasUncommittedChanges
        ? `${scopes.dirtyPathCount} uncommitted ${scopes.dirtyPathCount === 1 ? 'path' : 'paths'}`
        : 'No uncommitted changes',
    },
    {
      active: scopes.hasUnpushedChanges,
      label:
        scopes.upstreamRef == null
          ? 'No upstream branch'
          : scopes.hasUnpushedChanges
            ? `${scopes.aheadCount} unpushed ${scopes.aheadCount === 1 ? 'commit' : 'commits'}`
            : 'No unpushed commits',
    },
  ];
}
