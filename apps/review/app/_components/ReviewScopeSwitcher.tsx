'use client';

import {
  ChevronDown,
  GitBranch,
  GitCommitHorizontal,
  GitCompare,
  PencilLine,
  Upload,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { CommitSelect, useRepoCommits } from './CommitPicker';
import { PortalPopover } from './PortalPopover';
import {
  commitRangeReviewHref,
  singleCommitReviewHref,
  workingTreeReviewHref,
} from './reviewLinks';
import type { ReviewSourceInfo } from './types';
import { Button } from '@/components/ui/button';
import type { CommitSummary, RepoReviewScopes, ReviewScopeId } from '@/lib/git';
import { cn } from '@/lib/utils';

interface ReviewScopeSwitcherProps {
  repo: string;
  sourceInfo: ReviewSourceInfo;
}

// The clickable scope label in the diff header. Opens a popover that jumps to
// any working-tree scope or to a single commit / commit range — without the
// reviewer having to return to the home form and re-enter the repo path.
export function ReviewScopeSwitcher({
  repo,
  sourceInfo,
}: ReviewScopeSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scopes, setScopes] = useState<RepoReviewScopes | null>(null);
  const [rangeStart, setRangeStart] = useState<CommitSummary | null>(null);
  const [rangeEnd, setRangeEnd] = useState<CommitSummary | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const commitState = useRepoCommits(repo, open);

  // Load the working-tree scopes (for accurate links, esp. the upstream ref)
  // lazily when the popover first opens.
  useEffect(() => {
    if (!open || scopes != null) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(
          `/api/repo-scopes?repo=${encodeURIComponent(repo)}`,
          { cache: 'no-store', signal: controller.signal }
        );
        if (response.ok) {
          setScopes((await response.json()) as RepoReviewScopes);
        }
      } catch {
        // Leave scopes null; the working-tree links fall back to the basics.
      }
    })();
    return () => controller.abort();
  }, [open, repo, scopes]);

  const navigate = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const workingTreeOptions = scopes?.options ?? [];

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        aria-expanded={open}
        className="hover:bg-accent flex max-w-full items-center gap-1 rounded px-1 py-0.5 transition"
        onClick={() => setOpen((current) => !current)}
        title="Change review scope"
      >
        <ScopeSummary sourceInfo={sourceInfo} />
        <ChevronDown className="text-muted-foreground size-3 shrink-0" />
      </button>

      <PortalPopover
        anchorRef={containerRef}
        open={open}
        onClose={() => setOpen(false)}
        width={480}
        className="bg-popover text-popover-foreground z-[100] space-y-3 rounded-md border p-3 font-sans shadow-lg"
      >
        <section className="space-y-1.5">
          <h3 className="text-muted-foreground text-xs font-medium">
            Working tree
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {workingTreeOptions.length === 0 ? (
              <>
                <ScopeLink
                  icon={<GitBranch className="size-3.5" />}
                  label="Base"
                  onClick={() => navigate(workingTreeReviewHref(repo))}
                />
                <ScopeLink
                  icon={<PencilLine className="size-3.5" />}
                  label="Uncommitted"
                  onClick={() => navigate(workingTreeReviewHref(repo, 'HEAD'))}
                />
              </>
            ) : (
              workingTreeOptions.map((option) => (
                <ScopeLink
                  key={option.id}
                  disabled={!option.available}
                  icon={<ScopeIcon id={option.id} />}
                  label={option.shortLabel}
                  title={
                    option.available ? option.detail : option.disabledReason
                  }
                  onClick={() =>
                    navigate(workingTreeReviewHref(repo, option.baseRef))
                  }
                />
              ))
            )}
          </div>
        </section>

        <section className="space-y-1.5">
          <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <GitCommitHorizontal className="size-3.5" />
            Single commit
          </h3>
          <CommitSelect
            commits={commitState.commits}
            error={commitState.error}
            hasMore={commitState.hasMore}
            loading={commitState.loading}
            onChange={(commit) =>
              navigate(singleCommitReviewHref(repo, commit.sha))
            }
            onLoadMore={commitState.loadMore}
            placeholder="Pick a commit to review"
            value={null}
          />
        </section>

        <section className="space-y-1.5">
          <h3 className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <GitCompare className="size-3.5" />
            Commit range
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <CommitSelect
              commits={commitState.commits}
              error={commitState.error}
              hasMore={commitState.hasMore}
              loading={commitState.loading}
              onChange={setRangeStart}
              onLoadMore={commitState.loadMore}
              placeholder="Start (older)"
              value={rangeStart}
            />
            <CommitSelect
              align="end"
              commits={commitState.commits}
              error={commitState.error}
              hasMore={commitState.hasMore}
              loading={commitState.loading}
              onChange={setRangeEnd}
              onLoadMore={commitState.loadMore}
              placeholder="End (newer)"
              value={rangeEnd}
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={rangeStart == null || rangeEnd == null}
            onClick={() => {
              if (rangeStart != null && rangeEnd != null) {
                navigate(
                  commitRangeReviewHref(repo, rangeStart.sha, rangeEnd.sha)
                );
              }
            }}
          >
            Review range
          </Button>
        </section>
      </PortalPopover>
    </div>
  );
}

// The short scope label shown on the trigger, matching the active review mode.
function ScopeSummary({ sourceInfo }: { sourceInfo: ReviewSourceInfo }) {
  if (sourceInfo.mode === 'single') {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <GitCommitHorizontal className="size-3 shrink-0" />
        <span className="font-mono">{shortSha(sourceInfo.toSha)}</span>
        <span className="text-muted-foreground truncate">
          {sourceInfo.toSubject}
        </span>
      </span>
    );
  }
  if (sourceInfo.mode === 'range') {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <GitCompare className="size-3 shrink-0" />
        <span className="font-mono">
          {shortSha(sourceInfo.fromSha)}..{shortSha(sourceInfo.toSha)}
        </span>
      </span>
    );
  }
  return (
    <span className="truncate">
      {sourceInfo.branch}
      <span className="text-muted-foreground"> ← {sourceInfo.baseRef}</span>
    </span>
  );
}

function ScopeLink({
  disabled = false,
  icon,
  label,
  onClick,
  title,
}: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(
        'border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition',
        disabled && 'cursor-not-allowed opacity-55 hover:bg-background'
      )}
    >
      {icon}
      {label}
    </button>
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

function shortSha(sha: string | undefined): string {
  return sha == null ? '' : sha.slice(0, 7);
}
