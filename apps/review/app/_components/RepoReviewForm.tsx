'use client';

import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  GitCompareArrows,
  Loader2,
  PencilLine,
  Upload,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  RepoReviewScopes,
  ReviewScopeId,
  ReviewScopeOption,
} from '@/lib/git';
import { cn } from '@/lib/utils';

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
  const [selectedScope, setSelectedScope] =
    useState<ReviewScopeId>('branch-base');
  const [scopes, setScopes] = useState<RepoReviewScopes | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

      <input name="base" type="hidden" value={baseValue} />

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
        </div>
      </fieldset>

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
        className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition focus-visible:ring-2 focus-visible:outline-none"
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

function optionById(
  options: ReviewScopeOption[],
  id: ReviewScopeId
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
