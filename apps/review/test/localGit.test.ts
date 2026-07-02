import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createLocalDiffStream,
  GitRequestError,
  listUntrackedFiles,
  loadDiffFileContents,
  resolveLocalDiffSource,
  resolveRepoReviewScopes,
  synthesizeUntrackedPatch,
} from '../lib/git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
}

async function collectDiffText(repo: string, base?: string): Promise<string> {
  const source = await resolveLocalDiffSource(repo, base ?? null);
  return new Response(createLocalDiffStream(source)).text();
}

let baseDir: string;

beforeAll(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'review-git-test-'));
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('resolveLocalDiffSource', () => {
  test('resolves repo toplevel, branch, and explicit base', async () => {
    const repo = path.join(baseDir, 'resolve');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'checkout', '-b', 'feature');
    await mkdir(path.join(repo, 'sub'), { recursive: true });

    const source = await resolveLocalDiffSource(path.join(repo, 'sub'), 'main');
    expect(source.repoPath).toBe(repo);
    expect(source.branch).toBe('feature');
    expect(source.baseRef).toBe('main');
    expect(source.mergeBase).toBe(git(repo, 'rev-parse', 'main'));
  });

  test('expands ~ against the home directory', async () => {
    const repo = path.join(baseDir, 'tilde');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');

    // os.homedir() reads $HOME on POSIX, so pointing it at the test dir
    // makes `~/tilde` resolve to the repo above.
    const previousHome = process.env.HOME;
    process.env.HOME = baseDir;
    try {
      const source = await resolveLocalDiffSource('~/tilde', null);
      expect(source.repoPath).toBe(repo);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  test('falls back to main when no base is requested', async () => {
    const repo = path.join(baseDir, 'fallback-main');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');

    const source = await resolveLocalDiffSource(repo, null);
    expect(source.baseRef).toBe('main');
  });

  test('falls back to HEAD when no default branch name exists', async () => {
    const repo = path.join(baseDir, 'fallback-head');
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-b', 'trunk');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');

    const source = await resolveLocalDiffSource(repo, null);
    expect(source.baseRef).toBe('HEAD');
  });

  test('resolves identity inside a linked worktree (.git pointer file)', async () => {
    const repo = path.join(baseDir, 'worktree-main');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    const linked = path.join(baseDir, 'worktree-linked');
    git(repo, 'worktree', 'add', '-qb', 'wt-branch', linked);

    const source = await resolveLocalDiffSource(linked, 'main');
    expect(source.repoPath).toBe(linked);
    expect(source.branch).toBe('wt-branch');
  });

  test('reports detached HEAD as branch HEAD', async () => {
    const repo = path.join(baseDir, 'detached');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'checkout', '--detach');

    const source = await resolveLocalDiffSource(repo, null);
    expect(source.branch).toBe('HEAD');
  });

  test('rejects relative paths, missing dirs, non-repos, bad base refs', async () => {
    expect(resolveLocalDiffSource('relative/path', null)).rejects.toThrow(
      GitRequestError
    );
    expect(
      resolveLocalDiffSource(path.join(baseDir, 'does-not-exist'), null)
    ).rejects.toThrow('No such directory');

    const notRepo = path.join(baseDir, 'not-a-repo');
    await mkdir(notRepo, { recursive: true });
    expect(resolveLocalDiffSource(notRepo, null)).rejects.toThrow(
      'Not a git repository'
    );

    const repo = path.join(baseDir, 'bad-base');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    expect(resolveLocalDiffSource(repo, 'no-such-ref')).rejects.toThrow(
      'Base ref not found'
    );
  });
});

describe('resolveRepoReviewScopes', () => {
  test('reports default base, upstream delta, and dirty working tree', async () => {
    const remote = path.join(baseDir, 'scope-remote.git');
    await mkdir(remote, { recursive: true });
    git(remote, 'init', '--bare', '-b', 'main');

    const repo = path.join(baseDir, 'scope-repo');
    await initRepo(repo);
    await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, 'push', '-u', 'origin', 'main');
    git(repo, 'checkout', '-b', 'feature');
    git(repo, 'push', '-u', 'origin', 'feature');

    await writeFile(path.join(repo, 'committed.txt'), 'unpushed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'unpushed');
    await writeFile(path.join(repo, 'tracked.txt'), 'dirty\n');
    await writeFile(path.join(repo, 'scratch.txt'), 'untracked\n');

    const scopes = await resolveRepoReviewScopes(repo);

    expect(scopes.branch).toBe('feature');
    expect(scopes.defaultBaseRef).toBe('main');
    expect(scopes.upstreamRef).toBe('origin/feature');
    expect(scopes.aheadCount).toBe(1);
    expect(scopes.dirtyPathCount).toBe(2);
    expect(scopes.untrackedPathCount).toBe(1);
    expect(scopes.hasUncommittedChanges).toBe(true);
    expect(scopes.hasUnpushedChanges).toBe(true);
    expect(
      scopes.options.find((option) => option.id === 'branch-base')
    ).toMatchObject({
      available: true,
      baseRef: null,
      badge: 'main',
    });
    expect(
      scopes.options.find((option) => option.id === 'unpushed')
    ).toMatchObject({
      available: true,
      baseRef: 'origin/feature',
      badge: '1 ahead',
      hasChanges: true,
    });
    expect(
      scopes.options.find((option) => option.id === 'uncommitted')
    ).toMatchObject({
      available: true,
      baseRef: 'HEAD',
      badge: '2 dirty',
      hasChanges: true,
    });
  });

  test('marks unpushed scope unavailable without an upstream', async () => {
    const repo = path.join(baseDir, 'scope-no-upstream');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');

    const scopes = await resolveRepoReviewScopes(repo);

    expect(scopes.upstreamRef).toBeNull();
    expect(scopes.hasUnpushedChanges).toBe(false);
    expect(scopes.hasUncommittedChanges).toBe(false);
    expect(
      scopes.options.find((option) => option.id === 'unpushed')
    ).toMatchObject({
      available: false,
      badge: 'no upstream',
    });
    expect(
      scopes.options.find((option) => option.id === 'uncommitted')
    ).toMatchObject({
      available: true,
      badge: 'clean',
    });
  });
});

describe('createLocalDiffStream', () => {
  test('streams tracked changes, renames, and untracked files', async () => {
    const repo = path.join(baseDir, 'stream');
    await initRepo(repo);
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(
      path.join(repo, 'src/app.ts'),
      'const one = 1;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\nconst six = 6;\n'
    );
    await writeFile(
      path.join(repo, 'src/util.ts'),
      'export function add(a: number, b: number) {\n  return a + b;\n}\nexport function sub(a: number, b: number) {\n  return a - b;\n}\n'
    );
    await writeFile(path.join(repo, 'stale.md'), '# stale\n');
    await writeFile(path.join(repo, '.gitignore'), 'ignored.log\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'baseline');
    git(repo, 'checkout', '-b', 'feature');

    // Committed change on the branch.
    await writeFile(
      path.join(repo, 'src/app.ts'),
      'const one = 100;\nconst two = 2;\nconst three = 3;\nconst four = 4;\nconst five = 5;\nconst six = 600;\n'
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'change app');

    // Working tree: rename + delete, plus untracked files.
    git(repo, 'mv', 'src/util.ts', 'src/helpers.ts');
    git(repo, 'rm', '-q', 'stale.md');
    await writeFile(path.join(repo, 'notes.txt'), 'hello\nworld\n');
    await writeFile(path.join(repo, 'no-newline.txt'), 'no trailing newline');
    await writeFile(path.join(repo, 'empty.txt'), '');
    await writeFile(
      path.join(repo, 'bin.dat'),
      Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a])
    );
    await writeFile(path.join(repo, 'ignored.log'), 'should not appear\n');

    const text = await collectDiffText(repo, 'main');

    // Committed branch change vs merge base.
    expect(text).toContain('-const one = 1;');
    expect(text).toContain('+const one = 100;');
    // Pure rename staged in the working tree.
    expect(text).toContain('rename from src/util.ts');
    expect(text).toContain('rename to src/helpers.ts');
    // Deletion.
    expect(text).toContain('deleted file mode');
    expect(text).toContain('--- a/stale.md');
    // Untracked text file becomes a new-file patch.
    expect(text).toContain('diff --git a/notes.txt b/notes.txt');
    expect(text).toContain('new file mode 100644');
    expect(text).toContain('+hello');
    expect(text).toContain('@@ -0,0 +1,2 @@');
    // Missing trailing newline is marked like git does.
    expect(text).toContain(
      '+no trailing newline\n\\ No newline at end of file'
    );
    // Empty untracked file gets a header-only patch.
    expect(text).toContain('diff --git a/empty.txt b/empty.txt');
    // Binary untracked file gets a stub.
    expect(text).toContain('Binary files /dev/null and b/bin.dat differ');
    // Ignored files stay out.
    expect(text).not.toContain('ignored.log');
  });

  test('emits only untracked files in a repo with no commits', async () => {
    const repo = path.join(baseDir, 'unborn');
    await initRepo(repo);
    await writeFile(path.join(repo, 'fresh.txt'), 'brand new\n');

    const text = await collectDiffText(repo);
    expect(text).toContain('diff --git a/fresh.txt b/fresh.txt');
    expect(text).toContain('+brand new');
  });

  test('produces an empty stream for a clean tree', async () => {
    const repo = path.join(baseDir, 'clean');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');

    const text = await collectDiffText(repo);
    expect(text).toBe('');
  });

  test('uses HEAD as the uncommitted-only base', async () => {
    const repo = path.join(baseDir, 'uncommitted-base');
    await initRepo(repo);
    await writeFile(path.join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'base');
    git(repo, 'checkout', '-b', 'feature');
    await writeFile(path.join(repo, 'committed.txt'), 'committed\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'committed');
    await writeFile(path.join(repo, 'scratch.txt'), 'dirty\n');

    const text = await collectDiffText(repo, 'HEAD');

    expect(text).not.toContain('committed.txt');
    expect(text).toContain('scratch.txt');
    expect(text).toContain('+dirty');
  });

  // Builds a classic criss-cross history with two merge bases between `main`
  // and `feature`, so a single merge base sits behind content both sides share:
  //
  //   C0 ── A (shared.txt) ─────┐
  //    └─── B (other.txt) ──┐   │
  //   main = merge(A, B) ───┘   │  (has base+shared+other)
  //   feature = merge(B, A) ────┘  then + feature.txt
  //
  // Diffing against either single merge base reports the file from the *other*
  // base as a spurious addition; the merge preview reports only feature.txt.
  async function buildCrissCrossRepo(repo: string): Promise<void> {
    await initRepo(repo);
    await writeFile(path.join(repo, 'base.txt'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'C0');

    git(repo, 'checkout', '-b', 'brancha');
    await writeFile(path.join(repo, 'shared.txt'), 'from-A\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'A');

    git(repo, 'checkout', '-b', 'branchb', 'main');
    await writeFile(path.join(repo, 'other.txt'), 'from-B\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'B');

    // main = merge(A, B): fast-forward to A, then a real merge of B.
    git(repo, 'checkout', 'main');
    git(repo, 'merge', '--no-edit', 'brancha');
    git(repo, 'merge', '--no-edit', 'branchb');

    // feature = merge(B, A) + its own contribution.
    git(repo, 'checkout', '-b', 'feature', 'branchb');
    git(repo, 'merge', '--no-edit', 'brancha');
    await writeFile(path.join(repo, 'feature.txt'), 'feature change\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'feature work');
  }

  test('uses a merge preview when base and HEAD have multiple merge bases', async () => {
    const repo = path.join(baseDir, 'criss-cross');
    await buildCrissCrossRepo(repo);

    // Sanity-check the fixture really is criss-cross.
    expect(
      git(repo, 'merge-base', '--all', 'main', 'HEAD').split('\n')
    ).toHaveLength(2);

    // An uncommitted tracked edit and an untracked file, to confirm both still
    // surface in the preview (via `git stash create` and synthesis).
    await writeFile(path.join(repo, 'base.txt'), 'base modified\n');
    await writeFile(path.join(repo, 'scratch.txt'), 'dirty\n');

    const source = await resolveLocalDiffSource(repo, 'main');
    expect(source.mergedTree).toBeTypeOf('string');
    // Old side is the base tip itself, not one of the stale merge bases.
    expect(source.mergeBase).toBe(git(repo, 'rev-parse', 'main'));

    const text = await new Response(createLocalDiffStream(source)).text();

    // The branch's real contribution shows.
    expect(text).toContain('feature.txt');
    expect(text).toContain('+feature change');
    // Content the branch merged in from the other base is already in main, so
    // the merge would not re-apply it — it must not appear.
    expect(text).not.toContain('shared.txt');
    expect(text).not.toContain('other.txt');
    // Uncommitted tracked edit (via stash create) and untracked file still show.
    expect(text).toContain('+base modified');
    expect(text).toContain('scratch.txt');
    expect(text).toContain('+dirty');
  });

  test('merge-preview contents read old side from base and new side from the merge', async () => {
    const repo = path.join(baseDir, 'criss-cross-contents');
    await buildCrissCrossRepo(repo);
    await writeFile(path.join(repo, 'base.txt'), 'base modified\n');

    const source = await resolveLocalDiffSource(repo, 'main');
    const files = await loadDiffFileContents(source, [
      { path: 'base.txt' },
      { path: 'feature.txt' },
    ]);

    expect(files).toEqual([
      // Old side from the base tip, new side from the merged tree.
      {
        path: 'base.txt',
        oldContents: 'base\n',
        newContents: 'base modified\n',
      },
      // New-only file: absent from the base, present in the merge.
      {
        path: 'feature.txt',
        oldContents: null,
        newContents: 'feature change\n',
      },
    ]);
  });

  test('falls back to the single merge base when the working tree cannot be snapshotted', async () => {
    const repo = path.join(baseDir, 'criss-cross-unmerged');
    await buildCrissCrossRepo(repo);

    // Leave the index unmerged so `git stash create` fails: a side branch and
    // `feature` change the same file, and merging the side branch conflicts.
    git(repo, 'checkout', '-b', 'sidewedge');
    await writeFile(path.join(repo, 'feature.txt'), 'side change\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'side change');

    git(repo, 'checkout', 'feature');
    await writeFile(path.join(repo, 'feature.txt'), 'feature side\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'conflicting feature change');

    // The conflicting merge exits non-zero and leaves unmerged index entries.
    expect(() => git(repo, 'merge', '--no-edit', 'sidewedge')).toThrow();
    expect(git(repo, 'status', '--porcelain')).toContain('UU feature.txt');

    // Still criss-cross against main, so the preview path is still attempted.
    const mergeBases = git(repo, 'merge-base', '--all', 'main', 'HEAD').split(
      '\n'
    );
    expect(mergeBases.length).toBeGreaterThan(1);

    // `git stash create` fails on the unmerged index, so no merge preview is
    // built; we fall back to the single merge base rather than silently merging
    // HEAD and dropping the working-tree state from the diff.
    const source = await resolveLocalDiffSource(repo, 'main');
    expect(source.mergedTree).toBeUndefined();
    expect(source.mergeBase).toBe(mergeBases[0]);
  });
});

describe('untracked file synthesis', () => {
  test('lists untracked files recursively and sorted', async () => {
    const repo = path.join(baseDir, 'untracked-list');
    await initRepo(repo);
    await mkdir(path.join(repo, 'dir/nested'), { recursive: true });
    await writeFile(path.join(repo, 'dir/nested/b.txt'), 'b\n');
    await writeFile(path.join(repo, 'a.txt'), 'a\n');

    expect(await listUntrackedFiles(repo)).toEqual([
      'a.txt',
      'dir/nested/b.txt',
    ]);
  });

  test('marks executable files with mode 100755', async () => {
    const repo = path.join(baseDir, 'untracked-exec');
    await initRepo(repo);
    const script = path.join(repo, 'run.sh');
    await writeFile(script, '#!/bin/sh\necho hi\n');
    await chmod(script, 0o755);

    const patch = await synthesizeUntrackedPatch(repo, 'run.sh');
    expect(patch).toContain('new file mode 100755');
  });

  test('skips paths the diff format cannot represent unambiguously', async () => {
    const repo = path.join(baseDir, 'untracked-skip');
    await initRepo(repo);
    expect(
      await synthesizeUntrackedPatch(repo, 'has"quote.txt')
    ).toBeUndefined();
    expect(await synthesizeUntrackedPatch(repo, 'gone.txt')).toBeUndefined();
  });
});

describe('loadDiffFileContents', () => {
  test('returns merge-base and working-tree sides for modified and renamed files', async () => {
    const repo = path.join(baseDir, 'contents');
    await initRepo(repo);
    await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
    await writeFile(path.join(repo, 'old-name.txt'), 'alpha\nbeta\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'checkout', '-b', 'feature');

    await writeFile(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
    git(repo, 'mv', 'old-name.txt', 'new-name.txt');
    await writeFile(path.join(repo, 'new-name.txt'), 'alpha\nBETA\n');

    const source = await resolveLocalDiffSource(repo, 'main');
    const files = await loadDiffFileContents(source, [
      { path: 'a.txt' },
      { path: 'new-name.txt', prevPath: 'old-name.txt' },
    ]);

    expect(files).toEqual([
      {
        path: 'a.txt',
        oldContents: 'one\ntwo\nthree\n',
        newContents: 'one\nTWO\nthree\n',
      },
      {
        path: 'new-name.txt',
        oldContents: 'alpha\nbeta\n',
        newContents: 'alpha\nBETA\n',
      },
    ]);
  });

  test('reports unavailable sides as null', async () => {
    const repo = path.join(baseDir, 'contents-null');
    await initRepo(repo);
    await writeFile(
      path.join(repo, 'bin.dat'),
      Buffer.from([0x00, 0x01, 0x02])
    );
    await writeFile(path.join(repo, 'kept.txt'), 'kept\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-m', 'init');
    git(repo, 'checkout', '-b', 'feature');
    git(repo, 'rm', '-q', 'kept.txt');

    const outside = path.join(baseDir, 'contents-outside.txt');
    await writeFile(outside, 'outside the repo\n');

    const source = await resolveLocalDiffSource(repo, 'main');
    const files = await loadDiffFileContents(source, [
      // Binary on both sides.
      { path: 'bin.dat' },
      // Deleted from the working tree: old side still resolves.
      { path: 'kept.txt' },
      // Never existed.
      { path: 'missing.txt' },
      // Path traversal must not read outside the repo.
      { path: '../contents-outside.txt' },
    ]);

    expect(files).toEqual([
      { path: 'bin.dat', oldContents: null, newContents: null },
      { path: 'kept.txt', oldContents: 'kept\n', newContents: null },
      { path: 'missing.txt', oldContents: null, newContents: null },
      {
        path: '../contents-outside.txt',
        oldContents: null,
        newContents: null,
      },
    ]);
  });

  test('returns null old sides in a repo with no commits', async () => {
    const repo = path.join(baseDir, 'contents-unborn');
    await initRepo(repo);
    await writeFile(path.join(repo, 'fresh.txt'), 'brand new\n');

    const source = await resolveLocalDiffSource(repo, null);
    const files = await loadDiffFileContents(source, [{ path: 'fresh.txt' }]);
    expect(files).toEqual([
      { path: 'fresh.txt', oldContents: null, newContents: 'brand new\n' },
    ]);
  });
});
