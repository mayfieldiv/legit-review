import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GET as getDiffRoute } from '../app/api/diff/route';
import { listRecentRepoGroups } from '../lib/recentRepos';
import {
  createComment,
  listRecentRepoEntries,
  recordRecentRepo,
  updateComment,
} from '../lib/store';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  await writeFile(path.join(dir, 'README.md'), '# test\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
}

let baseDir: string;
let dataDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'review-recent-test-'));
  dataDir = path.join(baseDir, 'data');
  process.env.PIERRE_REVIEW_DATA_DIR = dataDir;
});

afterEach(() => {
  delete process.env.PIERRE_REVIEW_DATA_DIR;
  rmSync(baseDir, { recursive: true, force: true });
});

describe('recent repo listing', () => {
  test('groups recent repos with all worktrees and thread counts', async () => {
    const repo = path.join(baseDir, 'project');
    const linked = path.join(baseDir, 'project-feature');
    await initRepo(repo);
    git(repo, 'worktree', 'add', '-qb', 'feature/x', linked);

    const resolved = await createComment(repo, 'main', {
      filePath: 'README.md',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'resolved thread',
    });
    await updateComment(repo, 'main', resolved.id, { resolved: true });
    await createComment(repo, 'main', {
      filePath: 'README.md',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'unresolved thread',
    });
    await createComment(linked, 'feature/x', {
      filePath: 'README.md',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'feature thread',
    });
    await recordRecentRepo(linked, 'feature/x');

    const groups = await listRecentRepoGroups();

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group).toBeDefined();
    if (group == null) {
      throw new Error('expected one recent repo group');
    }
    expect(group.name).toBe('project');
    const worktrees = new Map(
      group.worktrees.map((worktree) => [worktree.path, worktree])
    );
    expect(worktrees.get(repo)?.branch).toBe('main');
    expect(worktrees.get(repo)?.threadCounts).toEqual({
      unresolved: 1,
      resolved: 1,
    });
    expect(worktrees.get(linked)?.branch).toBe('feature/x');
    expect(worktrees.get(linked)?.threadCounts).toEqual({
      unresolved: 1,
      resolved: 0,
    });
  });

  test('backfills recent entries from existing state files', async () => {
    const repo = path.join(baseDir, 'legacy-project');
    await initRepo(repo);
    await createComment(repo, 'main', {
      filePath: 'README.md',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'legacy thread',
    });

    const groups = await listRecentRepoGroups();

    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group).toBeDefined();
    if (group == null) {
      throw new Error('expected one recent repo group');
    }
    expect(group.path).toBe(repo);
    expect(group.worktrees[0]?.threadCounts).toEqual({
      unresolved: 1,
      resolved: 0,
    });
  });

  test('diff route records a repo as recently opened', async () => {
    const repo = path.join(baseDir, 'opened-project');
    await initRepo(repo);

    const response = await getDiffRoute(
      new Request(`http://localhost/api/diff?repo=${encodeURIComponent(repo)}`)
    );
    expect(response.status).toBe(200);
    await response.text();

    const entries = await listRecentRepoEntries();
    expect(
      entries.some(
        (entry) => entry.repoPath === repo && entry.branch === 'main'
      )
    ).toBe(true);
  });
});
