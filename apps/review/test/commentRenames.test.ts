import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GET as getStateRoute } from '../app/api/state/route';
import { reconcileCommentRenames } from '../lib/commentRenames';
import { resolveLocalDiffSource, traceRenamedPaths } from '../lib/git';
import { createComment, readState, setViewedMarks } from '../lib/store';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
}

let baseDir: string;

beforeAll(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'review-rename-test-'));
  process.env.PIERRE_REVIEW_DATA_DIR = path.join(baseDir, 'data');
});

afterAll(() => {
  delete process.env.PIERRE_REVIEW_DATA_DIR;
  rmSync(baseDir, { recursive: true, force: true });
});

// Builds the reported failure shape: a file added on the review branch,
// commented on, then renamed by a later branch commit — so the diff against
// main only ever shows the new name and the old path exists nowhere.
async function initRenameRepo(name: string): Promise<string> {
  const repo = path.join(baseDir, name);
  await initRepo(repo);
  await writeFile(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  git(repo, 'checkout', '-qb', 'feature');
  await writeFile(path.join(repo, 'Old.swift'), 'line1\nline2\nline3\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'add Old.swift');
  git(repo, 'mv', 'Old.swift', 'Mid.swift');
  git(repo, 'commit', '-qm', 'rename to Mid.swift');
  return repo;
}

describe('traceRenamedPaths', () => {
  test('follows a rename chain across commits and the index', async () => {
    const repo = await initRenameRepo('trace-chain');
    // Second hop is only staged, not committed.
    git(repo, 'mv', 'Mid.swift', 'New.swift');

    const source = await resolveLocalDiffSource(repo, 'main');
    const renames = await traceRenamedPaths(repo, source.mergeBase, [
      'Old.swift',
      'Mid.swift',
      'base.txt',
    ]);
    expect(renames.get('Old.swift')).toBe('New.swift');
    expect(renames.get('Mid.swift')).toBe('New.swift');
    expect(renames.has('base.txt')).toBe(false);
  });

  test('reports nothing for deleted or unknown paths', async () => {
    const repo = await initRenameRepo('trace-deleted');
    git(repo, 'rm', '-q', 'Mid.swift');
    git(repo, 'commit', '-qm', 'delete Mid.swift');

    const source = await resolveLocalDiffSource(repo, 'main');
    const renames = await traceRenamedPaths(repo, source.mergeBase, [
      'Mid.swift',
      'never-existed.txt',
    ]);
    expect(renames.size).toBe(0);
  });

  test('handles rename-heavy paths with spaces', async () => {
    const repo = await initRenameRepo('trace-spaces');
    git(repo, 'mv', 'Mid.swift', 'has space.swift');
    git(repo, 'commit', '-qm', 'rename with space');

    const source = await resolveLocalDiffSource(repo, 'main');
    const renames = await traceRenamedPaths(repo, source.mergeBase, [
      'Old.swift',
    ]);
    expect(renames.get('Old.swift')).toBe('has space.swift');
  });
});

describe('reconcileCommentRenames', () => {
  test('remaps comments and viewed marks to the renamed file', async () => {
    const repo = await initRenameRepo('reconcile-rename');
    const branch = 'feature';
    await createComment(repo, branch, {
      filePath: 'Old.swift',
      side: 'additions',
      range: { start: 2, end: 2 },
      message: 'On the old name',
      lineSnippet: 'line2',
      hunkHash: 'hash-old',
    });
    await createComment(repo, branch, {
      filePath: 'base.txt',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'Untouched file',
      lineSnippet: 'base',
      hunkHash: '',
    });
    await setViewedMarks(repo, branch, 'Old.swift', {
      viewed: true,
      hunkHashes: ['hunk-1'],
      fileHash: 'file-1',
    });

    const { state, changed } = await reconcileCommentRenames(
      repo,
      branch,
      await readState(repo, branch)
    );
    expect(changed).toBe(true);
    expect(state.comments.map((comment) => comment.filePath).sort()).toEqual([
      'Mid.swift',
      'base.txt',
    ]);
    expect(state.viewedHunks['Mid.swift']).toEqual(['hunk-1']);
    expect(state.viewedFiles['Mid.swift']).toBe('file-1');
    expect(state.viewedHunks['Old.swift']).toBeUndefined();

    // The remap is persisted, so the next read needs no reconciliation.
    const persisted = await readState(repo, branch);
    expect(persisted.comments[0]?.filePath).toBe('Mid.swift');
    const again = await reconcileCommentRenames(repo, branch, persisted);
    expect(again.changed).toBe(false);
  });

  test('leaves comments on deleted files untouched', async () => {
    const repo = await initRenameRepo('reconcile-deleted');
    const branch = 'feature';
    await rm(path.join(repo, 'Mid.swift'));
    await createComment(repo, branch, {
      filePath: 'Mid.swift',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'File is gone',
      lineSnippet: 'line1',
      hunkHash: '',
    });

    const { state, changed } = await reconcileCommentRenames(
      repo,
      branch,
      await readState(repo, branch)
    );
    expect(changed).toBe(false);
    expect(state.comments[0]?.filePath).toBe('Mid.swift');
  });

  test('GET /api/state serves the remapped paths', async () => {
    const repo = await initRenameRepo('reconcile-route');
    await createComment(repo, 'feature', {
      filePath: 'Old.swift',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'Route-level check',
      lineSnippet: 'line1',
      hunkHash: 'hash-old',
    });

    const url = new URL('http://localhost/api/state');
    url.searchParams.set('repo', repo);
    const response = await getStateRoute(new Request(url));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      comments: { filePath: string }[];
    };
    expect(body.comments[0]?.filePath).toBe('Mid.swift');
  });
});
