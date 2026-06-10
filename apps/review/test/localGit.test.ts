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
  resolveLocalDiffSource,
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
