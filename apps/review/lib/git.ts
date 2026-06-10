import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// Untracked files above this size are emitted as binary-style stubs instead of
// full text patches so a stray multi-gigabyte artifact can't stall the stream.
const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;
// Matches git's own heuristic: a NUL byte in the first 8000 bytes means binary.
const BINARY_SNIFF_BYTES = 8000;

// Request-mappable failure: `status` becomes the HTTP status of the response.
export class GitRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface LocalDiffSource {
  repoPath: string;
  branch: string;
  baseRef: string;
  // Commit the tracked diff is computed against. Undefined when HEAD has no
  // commits yet (fresh repo) — only untracked files are emitted then.
  mergeBase: string | undefined;
}

interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function runGit(repoPath: string | null, args: string[]): Promise<GitResult> {
  const fullArgs = repoPath == null ? args : ['-C', repoPath, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('git', fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

// Runs git and returns trimmed stdout, or undefined when git exits non-zero.
async function gitText(
  repoPath: string,
  args: string[]
): Promise<string | undefined> {
  const result = await runGit(repoPath, args);
  return result.code === 0 ? result.stdout.toString('utf8').trim() : undefined;
}

async function revExists(repoPath: string, rev: string): Promise<boolean> {
  const result = await runGit(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${rev}^{commit}`,
  ]);
  return result.code === 0;
}

// Resolves the ref the review diff is computed against. An explicit request
// must exist; otherwise prefer the remote default branch, then main/master,
// then HEAD itself (working-tree-only review).
async function resolveBaseRef(
  repoPath: string,
  requested: string | null
): Promise<string> {
  if (requested != null && requested !== '') {
    if (await revExists(repoPath, requested)) {
      return requested;
    }
    throw new GitRequestError(`Base ref not found: ${requested}`);
  }

  const originHead = await gitText(repoPath, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]);
  for (const candidate of [originHead, 'main', 'master']) {
    if (
      candidate != null &&
      candidate !== '' &&
      (await revExists(repoPath, candidate))
    ) {
      return candidate;
    }
  }
  return 'HEAD';
}

export interface RepoIdentity {
  repoPath: string;
  branch: string;
}

// Resolves user input to the canonical repo toplevel + current branch. Used
// by every route so review state is keyed consistently no matter which
// subdirectory or symlinked path the caller passed.
export async function resolveRepoIdentity(
  repoInput: string
): Promise<RepoIdentity> {
  if (!path.isAbsolute(repoInput)) {
    throw new GitRequestError(`Repo path must be absolute: ${repoInput}`);
  }

  let realRepoPath: string;
  try {
    realRepoPath = await realpath(repoInput);
  } catch {
    throw new GitRequestError(`No such directory: ${repoInput}`, 404);
  }

  const repoPath = await gitText(realRepoPath, [
    'rev-parse',
    '--show-toplevel',
  ]);
  if (repoPath == null || repoPath === '') {
    throw new GitRequestError(`Not a git repository: ${repoInput}`);
  }

  // Empty when HEAD is detached; fall back to the literal ref name.
  const branch = await gitText(repoPath, ['branch', '--show-current']);
  return {
    repoPath,
    branch: branch == null || branch === '' ? 'HEAD' : branch,
  };
}

export async function resolveLocalDiffSource(
  repoInput: string,
  baseInput: string | null
): Promise<LocalDiffSource> {
  const { repoPath, branch } = await resolveRepoIdentity(repoInput);
  const baseRef = await resolveBaseRef(repoPath, baseInput);

  const headSha = await gitText(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD^{commit}',
  ]);
  let mergeBase: string | undefined;
  if (headSha != null && headSha !== '') {
    // Unrelated histories have no merge base; reviewing the working tree
    // against HEAD is the most useful fallback.
    mergeBase =
      (await gitText(repoPath, ['merge-base', baseRef, 'HEAD'])) ?? headSha;
  }

  return { repoPath, branch, baseRef, mergeBase };
}

// Cheap fingerprint of everything the review diff depends on: the current
// commit plus the porcelain status of tracked and untracked files. The
// watcher polls this; a changed signature means the diff needs reloading.
export async function computeRepoSignature(repoPath: string): Promise<string> {
  const headSha =
    (await gitText(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD'])) ??
    'unborn';
  const status = await runGit(repoPath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  const hash = createHash('sha1');
  hash.update(headSha);
  hash.update('\0');
  hash.update(status.stdout);
  // Content changes to modified/untracked files don't always alter porcelain
  // output, so fold in the mtimes+sizes of every dirty path.
  const dirtyPaths: string[] = [];
  for (const entry of status.stdout.toString('utf8').split('\0')) {
    if (entry.length > 3) {
      dirtyPaths.push(entry.slice(3));
    }
  }
  for (const dirtyPath of dirtyPaths.sort()) {
    try {
      const fileStat = await stat(path.join(repoPath, dirtyPath));
      hash.update(`${dirtyPath}:${fileStat.mtimeMs}:${fileStat.size};`);
    } catch {
      hash.update(`${dirtyPath}:gone;`);
    }
  }
  return hash.digest('hex');
}

// Streams the full review patch: `git diff <merge-base>` (working tree
// included) followed by synthesized new-file patches for untracked files,
// which git diff does not emit on its own.
export function createLocalDiffStream(
  source: LocalDiffSource
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  let killDiffProcess: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (source.mergeBase != null) {
          await pumpTrackedDiff(
            source,
            controller,
            (kill) => {
              killDiffProcess = kill;
            },
            () => cancelled
          );
        }
        if (!cancelled) {
          await pumpUntrackedFiles(
            source,
            controller,
            encoder,
            () => cancelled
          );
        }
        if (!cancelled) {
          controller.close();
        }
      } catch (error) {
        if (!cancelled) {
          controller.error(error);
        }
      }
    },
    cancel() {
      cancelled = true;
      killDiffProcess?.();
    },
  });
}

function pumpTrackedDiff(
  source: LocalDiffSource,
  controller: ReadableStreamDefaultController<Uint8Array>,
  registerKill: (kill: () => void) => void,
  isCancelled: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-C',
        source.repoPath,
        'diff',
        '--find-renames',
        '--no-color',
        '--no-ext-diff',
        source.mergeBase as string,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    registerKill(() => child.kill());

    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      if (!isCancelled()) {
        controller.enqueue(new Uint8Array(chunk));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || isCancelled()) {
        resolve();
      } else {
        reject(
          new Error(
            `git diff exited with ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`
          )
        );
      }
    });
  });
}

async function pumpUntrackedFiles(
  source: LocalDiffSource,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  isCancelled: () => boolean
): Promise<void> {
  const untrackedPaths = await listUntrackedFiles(source.repoPath);
  for (const filePath of untrackedPaths) {
    if (isCancelled()) {
      return;
    }
    const patch = await synthesizeUntrackedPatch(source.repoPath, filePath);
    if (patch != null && !isCancelled()) {
      controller.enqueue(encoder.encode(patch));
    }
  }
}

export async function listUntrackedFiles(repoPath: string): Promise<string[]> {
  const result = await runGit(repoPath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--no-renames',
  ]);
  if (result.code !== 0) {
    throw new Error(`git status exited with ${result.code}: ${result.stderr}`);
  }

  const paths: string[] = [];
  for (const entry of result.stdout.toString('utf8').split('\0')) {
    if (entry.startsWith('?? ')) {
      paths.push(entry.slice(3));
    }
  }
  return paths.sort();
}

// Builds a unified-diff "new file" patch for one untracked file, mirroring
// git's output format so the client parser treats it like any other file.
// Returns undefined for paths the unified diff format cannot represent
// unambiguously without C-style quoting (control chars / quotes), which git
// itself quotes but our synthesizer intentionally does not implement.
export async function synthesizeUntrackedPatch(
  repoPath: string,
  filePath: string
): Promise<string | undefined> {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f"\\]/.test(filePath)) {
    return undefined;
  }

  const absolutePath = path.join(repoPath, filePath);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    // Deleted between `git status` and now (the watcher refreshes soon after).
    return undefined;
  }
  if (!fileStat.isFile()) {
    return undefined;
  }

  const mode = (fileStat.mode & 0o111) !== 0 ? '100755' : '100644';
  const header = `diff --git a/${filePath} b/${filePath}\nnew file mode ${mode}\n`;

  if (fileStat.size === 0) {
    return header;
  }

  const handle = await open(absolutePath, 'r');
  try {
    const sniff = Buffer.alloc(Math.min(fileStat.size, BINARY_SNIFF_BYTES));
    await handle.read(sniff, 0, sniff.length, 0);
    if (fileStat.size > MAX_UNTRACKED_BYTES || sniff.includes(0)) {
      return `${header}Binary files /dev/null and b/${filePath} differ\n`;
    }

    const content = (await handle.readFile()).toString('utf8');
    const hasTrailingNewline = content.endsWith('\n');
    const body = hasTrailingNewline ? content.slice(0, -1) : content;
    const lines = body.split('\n');
    const noNewlineMarker = hasTrailingNewline
      ? ''
      : '\n\\ No newline at end of file';
    return `${header}--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n+${lines.join('\n+')}${noNewlineMarker}\n`;
  } finally {
    await handle.close();
  }
}
