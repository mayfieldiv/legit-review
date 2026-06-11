'use client';

import { GitBranch, PencilLine, Upload } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import type {
  RepoReviewScopes,
  ReviewScopeId,
  ReviewScopeOption,
} from '@/lib/git';
import { cn } from '@/lib/utils';

const MAX_SCOPE_REQUESTS = 3;

const scopeCache = new Map<string, Promise<RepoReviewScopes>>();
const scopeQueue: (() => void)[] = [];
let activeScopeRequests = 0;

const LOADING_BASE_OPTION: ReviewScopeOption = {
  id: 'branch-base',
  label: 'Branch base',
  shortLabel: 'Base',
  baseRef: null,
  refLabel: 'auto',
  detail: 'Auto-detect branch base',
  badge: 'auto',
  available: true,
  hasChanges: false,
};

const LOADING_UNPUSHED_OPTION: ReviewScopeOption = {
  id: 'unpushed',
  label: 'Unpushed changes',
  shortLabel: 'Unpushed',
  baseRef: null,
  refLabel: 'checking',
  detail: 'Checking upstream state',
  badge: 'checking',
  available: false,
  hasChanges: false,
  disabledReason: 'Checking upstream state',
};

const LOADING_UNCOMMITTED_OPTION: ReviewScopeOption = {
  id: 'uncommitted',
  label: 'Uncommitted changes',
  shortLabel: 'Uncommitted',
  baseRef: 'HEAD',
  refLabel: 'checking',
  detail: 'Checking working tree',
  badge: 'checking',
  available: false,
  hasChanges: false,
  disabledReason: 'Checking working tree',
};

const LOADING_OPTIONS: ReviewScopeOption[] = [
  LOADING_BASE_OPTION,
  LOADING_UNPUSHED_OPTION,
  LOADING_UNCOMMITTED_OPTION,
];

const ERROR_OPTIONS: ReviewScopeOption[] = [
  LOADING_BASE_OPTION,
  {
    ...LOADING_UNPUSHED_OPTION,
    badge: 'unavailable',
    detail: 'Unable to inspect upstream state',
    disabledReason: 'Unable to inspect upstream state',
  },
  {
    ...LOADING_UNCOMMITTED_OPTION,
    badge: 'unavailable',
    detail: 'Unable to inspect working tree',
    disabledReason: 'Unable to inspect working tree',
  },
];

export function RecentRepoScopeLinks({ repoPath }: { repoPath: string }) {
  const [scopes, setScopes] = useState<RepoReviewScopes | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setScopes(null);
    setFailed(false);

    void getRepoScopes(repoPath).then(
      (nextScopes) => {
        if (!cancelled) {
          setScopes(nextScopes);
        }
      },
      () => {
        if (!cancelled) {
          setFailed(true);
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const options = scopes?.options ?? (failed ? ERROR_OPTIONS : LOADING_OPTIONS);

  return (
    <div className="flex flex-wrap gap-1.5 sm:justify-end">
      {options.map((option) =>
        option.available ? (
          <Link
            key={option.id}
            className={scopeLinkClassName(option)}
            href={scopeHref(repoPath, option)}
            prefetch={false}
            title={`${option.label}: ${option.detail}`}
          >
            <ScopeIcon id={option.id} />
            <span>{option.shortLabel}</span>
            <span className="max-w-24 truncate rounded bg-current/10 px-1 font-mono text-[10px]">
              {option.badge}
            </span>
          </Link>
        ) : (
          <span
            key={option.id}
            aria-disabled="true"
            className={cn(scopeLinkClassName(option), 'cursor-not-allowed')}
            title={option.disabledReason}
          >
            <ScopeIcon id={option.id} />
            <span>{option.shortLabel}</span>
            <span className="max-w-24 truncate rounded bg-current/10 px-1 font-mono text-[10px]">
              {option.badge}
            </span>
          </span>
        )
      )}
    </div>
  );
}

function getRepoScopes(repoPath: string): Promise<RepoReviewScopes> {
  const cached = scopeCache.get(repoPath);
  if (cached != null) {
    return cached;
  }

  const request = new Promise<RepoReviewScopes>((resolve, reject) => {
    scopeQueue.push(() => {
      activeScopeRequests++;
      void fetch(`/api/repo-scopes?repo=${encodeURIComponent(repoPath)}`, {
        cache: 'no-store',
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error((await response.text()).trim());
          }
          return (await response.json()) as RepoReviewScopes;
        })
        .then(resolve, reject)
        .finally(() => {
          activeScopeRequests--;
          startNextScopeFetch();
        });
    });
    startNextScopeFetch();
  });

  scopeCache.set(repoPath, request);
  void request.catch(() => {
    if (scopeCache.get(repoPath) === request) {
      scopeCache.delete(repoPath);
    }
  });
  return request;
}

function startNextScopeFetch() {
  while (activeScopeRequests < MAX_SCOPE_REQUESTS && scopeQueue.length > 0) {
    scopeQueue.shift()?.();
  }
}

function scopeHref(repoPath: string, option: ReviewScopeOption) {
  const query =
    option.baseRef == null
      ? { repo: repoPath }
      : { repo: repoPath, base: option.baseRef };
  return { pathname: '/review', query };
}

function scopeLinkClassName(option: ReviewScopeOption): string {
  return cn(
    'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
    option.hasChanges
      ? 'border-amber-300 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100 dark:hover:bg-amber-400/15'
      : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground',
    !option.available &&
      'opacity-55 hover:bg-background hover:text-muted-foreground'
  );
}

function ScopeIcon({ id }: { id: ReviewScopeId }) {
  const className = 'size-3.5 shrink-0';
  if (id === 'unpushed') {
    return <Upload className={className} />;
  }
  if (id === 'uncommitted') {
    return <PencilLine className={className} />;
  }
  return <GitBranch className={className} />;
}
