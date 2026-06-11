import {
  ArrowRight,
  CheckCircle2,
  CircleDot,
  FolderGit2,
  GitBranch,
  History,
} from 'lucide-react';
import Link from 'next/link';

import { RecentRepoScopeLinks } from './RecentRepoScopeLinks';
import { RepoReviewForm } from './RepoReviewForm';
import { listRecentRepoGroups, type RecentRepoGroup } from '@/lib/recentRepos';
import type { ThreadCounts } from '@/lib/store';

export async function RepoHome() {
  const recentRepos = await listRecentRepoGroups();

  return (
    <main className="bg-background text-foreground min-h-dvh">
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 px-4 py-5 md:px-8 md:py-7">
        <header className="border-border flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-normal">
              Pierre Review
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Local branch reviews with durable comment threads.
            </p>
          </div>
        </header>

        <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
          <section
            aria-labelledby="open-repo-heading"
            className="border-border bg-card h-fit rounded-md border p-4"
          >
            <div className="mb-4 flex items-center gap-2">
              <FolderGit2 className="text-muted-foreground size-4" />
              <h2 id="open-repo-heading" className="text-sm font-semibold">
                Open Repository
              </h2>
            </div>
            <RepoReviewForm />
          </section>

          <section aria-labelledby="recent-repos-heading" className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <History className="text-muted-foreground size-4" />
              <h2 id="recent-repos-heading" className="text-sm font-semibold">
                Recent Repositories
              </h2>
            </div>
            {recentRepos.length === 0 ? (
              <div className="border-border text-muted-foreground rounded-md border border-dashed p-6 text-sm">
                No recent repositories yet.
              </div>
            ) : (
              <div className="space-y-3">
                {recentRepos.map((repo) => (
                  <RecentRepoCard key={repo.id} repo={repo} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

function RecentRepoCard({ repo }: { repo: RecentRepoGroup }) {
  return (
    <article className="border-border bg-card overflow-hidden rounded-md border">
      <div className="border-border flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
            <h3 className="truncate text-sm font-semibold">{repo.name}</h3>
          </div>
          <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
            {repo.path}
          </p>
        </div>
        <time
          className="text-muted-foreground shrink-0 text-xs"
          dateTime={repo.lastOpenedAt}
        >
          {formatDateTime(repo.lastOpenedAt)}
        </time>
      </div>
      <div className="divide-border divide-y">
        {repo.worktrees.map((worktree) => (
          <div
            key={worktree.path}
            className="hover:bg-accent/50 grid min-h-14 gap-3 px-4 py-3 transition sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <Link
              className="group focus-visible:ring-ring/50 min-w-0 rounded-sm focus-visible:ring-2 focus-visible:outline-none"
              href={{ pathname: '/review', query: { repo: worktree.path } }}
              prefetch={false}
            >
              <div className="flex min-w-0 items-center gap-2">
                <GitBranch className="text-muted-foreground size-4 shrink-0" />
                <span className="truncate text-sm font-medium">
                  {worktree.branch}
                </span>
                {worktree.isDetached ? (
                  <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px]">
                    detached
                  </span>
                ) : null}
                <ArrowRight className="text-muted-foreground group-hover:text-foreground ml-auto size-4 shrink-0 transition group-hover:translate-x-0.5" />
              </div>
              <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
                {worktree.path}
              </p>
            </Link>
            <div className="flex min-w-0 flex-col gap-2 text-xs sm:items-end">
              <ThreadCountsInline counts={worktree.threadCounts} />
              <RecentRepoScopeLinks repoPath={worktree.path} />
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

function ThreadCountsInline({ counts }: { counts: ThreadCounts }) {
  return (
    <div className="text-muted-foreground flex flex-wrap items-center gap-2">
      <span
        className="inline-flex items-center gap-1"
        title={`${counts.unresolved} unresolved threads`}
      >
        <CircleDot className="size-3.5" />
        {counts.unresolved} unresolved
      </span>
      <span
        className="inline-flex items-center gap-1"
        title={`${counts.resolved} resolved threads`}
      >
        <CheckCircle2 className="size-3.5" />
        {counts.resolved} resolved
      </span>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Recently opened';
  }
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
