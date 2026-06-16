import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GET as getCommitsRoute } from '../app/api/commits/route';
import { GET as getDiffRoute } from '../app/api/diff/route';
import {
  createLocalDiffStream,
  listRepoCommits,
  loadDiffFileContents,
  resolveCommitNeighbors,
  resolveRangeDiffSource,
} from '../lib/git';

// Git's well-known empty tree object — the old side when a range starts at a
// root commit.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

let baseDir: string;
let repo: string;
let c1: string;
let c2: string;
let c3: string;

beforeAll(async () => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'review-range-test-'));
  process.env.PIERRE_REVIEW_DATA_DIR = path.join(baseDir, 'data');

  repo = path.join(baseDir, 'repo');
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-qb', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 'T');

  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'c1 init');
  c1 = git(repo, 'rev-parse', 'HEAD');

  await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
  await writeFile(path.join(repo, 'b.txt'), 'b1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'c2 add b');
  c2 = git(repo, 'rev-parse', 'HEAD');

  await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git(repo, 'add', '-A');
  // A body (second -m) so listRepoCommits' multi-line body parsing is covered.
  git(
    repo,
    'commit',
    '-qm',
    'c3 third line',
    '-m',
    'Body line one.\nBody line two.'
  );
  c3 = git(repo, 'rev-parse', 'HEAD');

  // An untracked file must never leak into a range diff (no working-tree read).
  await writeFile(path.join(repo, 'untracked.txt'), 'scratch\n');
});

afterAll(() => {
  delete process.env.PIERRE_REVIEW_DATA_DIR;
  rmSync(baseDir, { recursive: true, force: true });
});

async function streamText(repoInput: string, from: string, to: string) {
  const source = await resolveRangeDiffSource(repoInput, from, to);
  return new Response(createLocalDiffStream(source)).text();
}

describe('resolveRangeDiffSource', () => {
  test('single commit diffs against its parent', async () => {
    const source = await resolveRangeDiffSource(repo, c2, c2);
    expect(source.kind).toBe('range');
    expect(source.fromRef).toBe(c2);
    expect(source.toRef).toBe(c2);
    expect(source.baseCommit).toBe(c1);
    expect(source.single).toBe(true);
    expect(source.toSubject).toBe('c2 add b');
  });

  test('range baseline is the parent of the start commit (inclusive)', async () => {
    const source = await resolveRangeDiffSource(repo, c2, c3);
    expect(source.fromRef).toBe(c2);
    expect(source.toRef).toBe(c3);
    expect(source.baseCommit).toBe(c1);
    expect(source.single).toBe(false);
  });

  test('normalizes endpoint order by ancestry', async () => {
    const source = await resolveRangeDiffSource(repo, c3, c2);
    expect(source.fromRef).toBe(c2);
    expect(source.toRef).toBe(c3);
    expect(source.baseCommit).toBe(c1);
  });

  test('root start commit uses the empty tree as the baseline', async () => {
    const source = await resolveRangeDiffSource(repo, c1, c1);
    expect(source.baseCommit).toBe(EMPTY_TREE_SHA);
  });

  test('rejects an unknown commit', () => {
    expect(resolveRangeDiffSource(repo, 'deadbeef', c3)).rejects.toThrow(
      /Start commit not found/
    );
  });
});

describe('createLocalDiffStream (range)', () => {
  test('emits the inclusive diff for a single commit and no untracked files', async () => {
    const text = await streamText(repo, c2, c2);
    expect(text).toContain('b/b.txt');
    expect(text).toContain('+two');
    expect(text).not.toContain('untracked.txt');
    // c3's change must not appear in a single-c2 review.
    expect(text).not.toContain('+three');
  });

  test('spans both endpoints for a range', async () => {
    const text = await streamText(repo, c2, c3);
    expect(text).toContain('+two');
    expect(text).toContain('+three');
    expect(text).toContain('b/b.txt');
  });

  test('root commit reviews as all additions', async () => {
    const text = await streamText(repo, c1, c1);
    expect(text).toContain('a/a.txt');
    expect(text).toContain('+one');
    expect(text).not.toContain('+two');
  });
});

describe('loadDiffFileContents (range)', () => {
  test('reads both sides from commit blobs', async () => {
    const source = await resolveRangeDiffSource(repo, c2, c3);
    const [aContents] = await loadDiffFileContents(source, [{ path: 'a.txt' }]);
    // Old side = baseline (c1), new side = end commit (c3).
    expect(aContents.oldContents).toBe('one\n');
    expect(aContents.newContents).toBe('one\ntwo\nthree\n');
  });
});

describe('resolveCommitNeighbors', () => {
  test('returns parent as older and child as newer', async () => {
    const middle = await resolveCommitNeighbors(repo, c2);
    expect(middle.prevSha).toBe(c1);
    expect(middle.nextSha).toBe(c3);
  });

  test('head has no newer neighbor', async () => {
    const head = await resolveCommitNeighbors(repo, c3);
    expect(head.prevSha).toBe(c2);
    expect(head.nextSha).toBeNull();
  });

  test('root has no older neighbor', async () => {
    const root = await resolveCommitNeighbors(repo, c1);
    expect(root.prevSha).toBeNull();
    expect(root.nextSha).toBe(c2);
  });
});

describe('listRepoCommits', () => {
  test('lists commits newest-first with subject and body', async () => {
    const { commits, hasMore } = await listRepoCommits(repo);
    expect(commits.map((commit) => commit.sha)).toEqual([c3, c2, c1]);
    expect(commits[0].subject).toBe('c3 third line');
    expect(commits[0].body).toBe('Body line one.\nBody line two.');
    // A commit with no body reports an empty string, not the next record.
    expect(commits[1].subject).toBe('c2 add b');
    expect(commits[1].body).toBe('');
    expect(hasMore).toBe(false);
  });

  test('pages with limit and skip', async () => {
    const first = await listRepoCommits(repo, { limit: 2 });
    expect(first.commits.map((commit) => commit.sha)).toEqual([c3, c2]);
    expect(first.hasMore).toBe(true);

    const second = await listRepoCommits(repo, { limit: 2, skip: 2 });
    expect(second.commits.map((commit) => commit.sha)).toEqual([c1]);
    expect(second.hasMore).toBe(false);
  });
});

function apiUrl(pathname: string, params: Record<string, string>): string {
  const url = new URL(`http://localhost${pathname}`);
  url.searchParams.set('repo', repo);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

describe('review commit API routes', () => {
  test('GET /api/commits returns the commit list', async () => {
    const response = await getCommitsRoute(
      new Request(apiUrl('/api/commits', {}))
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      commits: { sha: string }[];
      hasMore: boolean;
    };
    expect(body.commits).toHaveLength(3);
    expect(body.commits[0].sha).toBe(c3);
  });

  test('GET /api/diff?commit= streams a single commit with neighbor headers', async () => {
    const response = await getDiffRoute(
      new Request(apiUrl('/api/diff', { commit: c2 }))
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Review-Mode')).toBe('single');
    expect(response.headers.get('X-Review-Prev')).toBe(c1);
    expect(response.headers.get('X-Review-Next')).toBe(c3);
    const text = await response.text();
    expect(text).toContain('b/b.txt');
    expect(text).not.toContain('untracked.txt');
  });

  test('GET /api/diff?from=&to= reports range mode', async () => {
    const response = await getDiffRoute(
      new Request(apiUrl('/api/diff', { from: c2, to: c3 }))
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Review-Mode')).toBe('range');
    expect(response.headers.get('X-Review-From')).toBe(c2);
    expect(response.headers.get('X-Review-To')).toBe(c3);
  });
});
