import path from 'node:path';

import {
  listRepoWorktrees,
  type RepoWorktree,
  resolveRepoCommonGitDir,
} from './git';
import {
  countStoredReviewThreads,
  listRecentRepoEntries,
  type RecentRepoEntry,
  type ThreadCounts,
} from './store';

const RECENT_REPO_GROUP_LIMIT = 12;

export interface RecentRepoWorktree {
  path: string;
  branch: string;
  isDetached: boolean;
  openedAt?: string;
  threadCounts: ThreadCounts;
}

export interface RecentRepoGroup {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
  worktrees: RecentRepoWorktree[];
}

export async function listRecentRepoGroups(
  limit = RECENT_REPO_GROUP_LIMIT
): Promise<RecentRepoGroup[]> {
  const recentEntries = await listRecentRepoEntries();
  const openedByPath = latestRecentEntryByPath(recentEntries);
  const groups = new Map<string, RecentRepoGroup>();

  for (const entry of recentEntries) {
    let groupId: string;
    try {
      groupId = await resolveRepoCommonGitDir(entry.repoPath);
    } catch {
      continue;
    }
    if (groups.has(groupId)) {
      continue;
    }

    const group = await buildRecentRepoGroup(groupId, entry, openedByPath);
    if (group != null) {
      groups.set(groupId, group);
    }
    if (groups.size >= limit) {
      break;
    }
  }

  return [...groups.values()].sort(
    (left, right) =>
      Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt)
  );
}

function latestRecentEntryByPath(
  entries: RecentRepoEntry[]
): Map<string, RecentRepoEntry> {
  const latest = new Map<string, RecentRepoEntry>();
  for (const entry of entries) {
    const existing = latest.get(entry.repoPath);
    if (
      existing == null ||
      Date.parse(entry.openedAt) > Date.parse(existing.openedAt)
    ) {
      latest.set(entry.repoPath, entry);
    }
  }
  return latest;
}

async function buildRecentRepoGroup(
  groupId: string,
  seed: RecentRepoEntry,
  openedByPath: ReadonlyMap<string, RecentRepoEntry>
): Promise<RecentRepoGroup | undefined> {
  const worktrees = await listWorktreesOrSeed(seed);
  if (worktrees.length === 0) {
    return undefined;
  }

  const enriched = await Promise.all(
    worktrees.map(async (worktree) => {
      const openedAt = openedByPath.get(worktree.path)?.openedAt;
      return {
        path: worktree.path,
        branch: worktree.branch,
        isDetached: worktree.isDetached,
        openedAt,
        threadCounts: await countStoredReviewThreads(
          worktree.path,
          worktree.branch
        ),
      };
    })
  );
  enriched.sort(compareWorktrees);

  const primaryPath = worktrees[0]?.path ?? seed.repoPath;
  const primaryName = path.basename(primaryPath);
  return {
    id: groupId,
    name: primaryName === '' ? primaryPath : primaryName,
    path: primaryPath,
    lastOpenedAt: latestOpenedAt(seed.openedAt, enriched),
    worktrees: enriched,
  };
}

async function listWorktreesOrSeed(
  seed: RecentRepoEntry
): Promise<RepoWorktree[]> {
  try {
    return await listRepoWorktrees(seed.repoPath);
  } catch {
    return [
      {
        path: seed.repoPath,
        branch: seed.branch,
        head: null,
        isDetached: seed.branch === 'HEAD',
      },
    ];
  }
}

function compareWorktrees(
  left: RecentRepoWorktree,
  right: RecentRepoWorktree
): number {
  const openedDelta =
    parseOptionalDate(right.openedAt) - parseOptionalDate(left.openedAt);
  if (openedDelta !== 0) {
    return openedDelta;
  }
  return left.path.localeCompare(right.path);
}

function latestOpenedAt(
  seedOpenedAt: string,
  worktrees: RecentRepoWorktree[]
): string {
  let latest = seedOpenedAt;
  for (const worktree of worktrees) {
    if (
      worktree.openedAt != null &&
      Date.parse(worktree.openedAt) > Date.parse(latest)
    ) {
      latest = worktree.openedAt;
    }
  }
  return latest;
}

function parseOptionalDate(value: string | undefined): number {
  return value == null ? 0 : Date.parse(value);
}
