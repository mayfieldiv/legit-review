import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Untracked files above this size are emitted as binary-style stubs instead of
// full text patches so a stray multi-gigabyte artifact can't stall the stream.
const MAX_UNTRACKED_BYTES = 10 * 1024 * 1024;
// Matches git's own heuristic: a NUL byte in the first 8000 bytes means binary.
const BINARY_SNIFF_BYTES = 8000;
// Full file contents (for hunk expansion) above this size are reported as
// unavailable instead of shipped to the browser.
const MAX_CONTEXT_FILE_BYTES = 10 * 1024 * 1024;

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

// Like runGit, but pipes `input` to the child's stdin (for `git cat-file
// --batch*`, which reads object specs from stdin).
function runGitWithInput(
  repoPath: string,
  args: string[],
  input: string
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
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
    child.stdin.on('error', () => {
      // The child can exit before consuming all input (e.g. bad spec);
      // surfacing EPIPE here would mask the real failure in `close`.
    });
    child.stdin.end(input);
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

export interface RepoWorktree {
  path: string;
  branch: string;
  head: string | null;
  isDetached: boolean;
}

// Repo paths arrive from a form/query param, not a shell, so `~` is never
// expanded by the time it reaches us. The server and reviewer are the same
// local user, so expanding against our own home dir is correct. $HOME is
// preferred over os.homedir() to match shell semantics (and because Bun
// caches homedir at startup, which would defeat test overrides).
function homeDirectory(): string {
  const home = process.env.HOME;
  return home != null && home !== '' ? home : os.homedir();
}

function expandTilde(input: string): string {
  if (input === '~') {
    return homeDirectory();
  }
  if (input.startsWith('~/')) {
    return path.join(homeDirectory(), input.slice(2));
  }
  return input;
}

// Reads the HEAD ref content for the repo rooted at `dir`, or undefined when
// `dir` is not a repo toplevel. Handles both layouts: `.git` as a directory
// (regular repo) and `.git` as a "gitdir: <path>" pointer file (linked
// worktrees, submodules).
async function tryReadHead(dir: string): Promise<string | undefined> {
  const gitEntry = path.join(dir, '.git');
  try {
    let gitDir: string;
    if ((await stat(gitEntry)).isDirectory()) {
      gitDir = gitEntry;
    } else {
      const pointer = (await readFile(gitEntry, 'utf8')).trim();
      if (!pointer.startsWith('gitdir:')) {
        return undefined;
      }
      const target = pointer.slice('gitdir:'.length).trim();
      gitDir = path.isAbsolute(target) ? target : path.resolve(dir, target);
    }
    return (await readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return undefined;
  }
}

// Walks from `startDir` toward the filesystem root looking for the nearest
// directory whose `.git` resolves to a readable git dir — the same upward
// discovery `git rev-parse --show-toplevel` performs. Implemented with file
// reads instead of spawning git because identity is resolved on every API
// request, and a process spawn from the loaded server costs orders of
// magnitude more than these reads (it is what made viewed toggles lag).
async function resolveGitToplevel(
  startDir: string
): Promise<{ repoPath: string; head: string } | undefined> {
  let dir = startDir;
  for (;;) {
    const head = await tryReadHead(dir);
    if (head != null) {
      return { repoPath: dir, head };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

// Resolves user input to the canonical repo toplevel + current branch. Used
// by every route so review state is keyed consistently no matter which
// subdirectory or symlinked path the caller passed.
export async function resolveRepoIdentity(
  repoInput: string
): Promise<RepoIdentity> {
  const expandedInput = expandTilde(repoInput);
  if (!path.isAbsolute(expandedInput)) {
    throw new GitRequestError(`Repo path must be absolute: ${repoInput}`);
  }

  let realRepoPath: string;
  try {
    realRepoPath = await realpath(expandedInput);
  } catch {
    throw new GitRequestError(`No such directory: ${repoInput}`, 404);
  }

  const resolved = await resolveGitToplevel(realRepoPath);
  if (resolved == null) {
    throw new GitRequestError(`Not a git repository: ${repoInput}`);
  }

  // HEAD is `ref: refs/heads/<branch>` on a branch; anything else (a bare
  // SHA when detached, or a non-branch symbolic ref) maps to the literal
  // name HEAD, matching what `git branch --show-current` reports as empty.
  const branch = resolved.head.startsWith('ref: refs/heads/')
    ? resolved.head.slice('ref: refs/heads/'.length)
    : 'HEAD';
  return { repoPath: resolved.repoPath, branch };
}

export async function resolveRepoCommonGitDir(
  repoPath: string
): Promise<string> {
  const commonDir = await gitText(repoPath, ['rev-parse', '--git-common-dir']);
  if (commonDir == null || commonDir === '') {
    throw new GitRequestError(`Not a git repository: ${repoPath}`);
  }
  return path.isAbsolute(commonDir)
    ? commonDir
    : path.resolve(repoPath, commonDir);
}

export async function listRepoWorktrees(
  repoPath: string
): Promise<RepoWorktree[]> {
  const result = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
  if (result.code !== 0) {
    throw new GitRequestError(
      `Unable to list worktrees for ${repoPath}: ${result.stderr.trim()}`
    );
  }
  return parseGitWorktreeList(result.stdout.toString('utf8'));
}

export function parseGitWorktreeList(output: string): RepoWorktree[] {
  const worktrees: (RepoWorktree & {
    isBare: boolean;
    isPrunable: boolean;
  })[] = [];
  let current:
    | (RepoWorktree & {
        isBare: boolean;
        isPrunable: boolean;
      })
    | undefined;

  const pushCurrent = () => {
    if (current != null && !current.isBare && !current.isPrunable) {
      worktrees.push(current);
    }
  };

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      pushCurrent();
      current = {
        path: line.slice('worktree '.length),
        branch: 'HEAD',
        head: null,
        isDetached: false,
        isBare: false,
        isPrunable: false,
      };
      continue;
    }
    if (current == null || line === '') {
      continue;
    }
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
      continue;
    }
    if (line.startsWith('branch ')) {
      const branch = line.slice('branch '.length);
      current.branch = branch.startsWith('refs/heads/')
        ? branch.slice('refs/heads/'.length)
        : branch;
      current.isDetached = false;
      continue;
    }
    if (line === 'detached') {
      current.branch = 'HEAD';
      current.isDetached = true;
      continue;
    }
    if (line === 'bare') {
      current.isBare = true;
      continue;
    }
    if (line.startsWith('prunable')) {
      current.isPrunable = true;
    }
  }
  pushCurrent();
  return worktrees.map((entry) => ({
    path: entry.path,
    branch: entry.branch,
    head: entry.head,
    isDetached: entry.isDetached,
  }));
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

export interface DiffFileContentsRequest {
  path: string;
  // Pre-rename path; the old-side blob lives under this name at the merge
  // base when the diff renamed the file.
  prevPath?: string;
}

export interface DiffFileContents {
  path: string;
  oldContents: string | null;
  newContents: string | null;
}

// Loads both sides of each diffed file in full, so the client can offer
// GitHub-style expansion of unmodified context around hunks. The old side is
// the blob at the merge base (what the review diff was computed against), the
// new side is the working tree. Either side is null when unavailable as text:
// missing path, non-blob (submodule), binary, or oversized.
export async function loadDiffFileContents(
  source: LocalDiffSource,
  files: DiffFileContentsRequest[]
): Promise<DiffFileContents[]> {
  const { mergeBase } = source;
  const oldTexts =
    mergeBase == null
      ? files.map(() => null)
      : await loadBlobTexts(
          source.repoPath,
          files.map((file) => {
            const sourcePath = file.prevPath ?? file.path;
            return isSafeRepoRelativePath(sourcePath)
              ? `${mergeBase}:${sourcePath}`
              : null;
          })
        );
  return Promise.all(
    files.map(async (file, index) => ({
      path: file.path,
      oldContents: oldTexts[index] ?? null,
      newContents: await readWorkingTreeText(source.repoPath, file.path),
    }))
  );
}

// Rejects paths git refuses to resolve inside `<rev>:<path>` specs: absolute
// paths and `..` traversal make `git cat-file` exit fatally, which would
// poison the entire batch instead of reporting one spec as missing.
function isSafeRepoRelativePath(filePath: string): boolean {
  return (
    !path.isAbsolute(filePath) &&
    filePath.split('/').every((segment) => segment !== '..')
  );
}

// Resolves blob texts for `<rev>:<path>` specs with one git spawn pair for the
// whole batch: `cat-file --batch-check` maps specs to oids and sizes without
// reading content, then `cat-file --batch` fetches only the text-sized blobs
// (by oid, so a repo mutation between the two spawns cannot skew the result).
// Null specs are passed through; per-spec null in the result means missing
// path, non-blob, oversized, or binary.
async function loadBlobTexts(
  repoPath: string,
  specs: (string | null)[]
): Promise<(string | null)[]> {
  const results: (string | null)[] = specs.map(() => null);
  // cat-file reads one spec per stdin line, so embedded newlines would smuggle
  // in extra specs and shift every following record.
  const inputIndexes: number[] = [];
  for (const [index, spec] of specs.entries()) {
    if (spec != null && !spec.includes('\n')) {
      inputIndexes.push(index);
    }
  }
  if (inputIndexes.length === 0) {
    return results;
  }

  const check = await runGitWithInput(
    repoPath,
    ['cat-file', '--batch-check'],
    `${inputIndexes.map((index) => specs[index]).join('\n')}\n`
  );
  if (check.code !== 0) {
    throw new Error(
      `git cat-file --batch-check exited with ${check.code}: ${check.stderr.trim()}`
    );
  }

  // One output line per input spec, in input order. Unresolvable specs print
  // `<spec> missing` instead of `<oid> <type> <size>`.
  const checkLines = check.stdout.toString('utf8').split('\n');
  const fetchIndexes: number[] = [];
  const fetchOids: string[] = [];
  for (const [lineIndex, specIndex] of inputIndexes.entries()) {
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(checkLines[lineIndex] ?? '');
    if (match != null && Number(match[2]) <= MAX_CONTEXT_FILE_BYTES) {
      fetchIndexes.push(specIndex);
      fetchOids.push(match[1]);
    }
  }
  if (fetchIndexes.length === 0) {
    return results;
  }

  const batch = await runGitWithInput(
    repoPath,
    ['cat-file', '--batch'],
    `${fetchOids.join('\n')}\n`
  );
  if (batch.code !== 0) {
    throw new Error(
      `git cat-file --batch exited with ${batch.code}: ${batch.stderr.trim()}`
    );
  }

  const blobs = parseCatFileBatchBlobs(batch.stdout, fetchOids.length);
  for (const [blobIndex, specIndex] of fetchIndexes.entries()) {
    const blob = blobs[blobIndex];
    if (blob != null && !isBinaryBuffer(blob)) {
      results[specIndex] = blob.toString('utf8');
    }
  }
  return results;
}

// Splits `git cat-file --batch` output into per-record content buffers. Each
// record is `<oid> <type> <size>\n` followed by exactly <size> content bytes
// and a trailing newline; records appear in input order.
function parseCatFileBatchBlobs(
  output: Buffer,
  count: number
): (Buffer | null)[] {
  const blobs: (Buffer | null)[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      blobs.push(null);
      continue;
    }
    const header = output.toString('utf8', offset, headerEnd);
    const match = /^[0-9a-f]+ \S+ (\d+)$/.exec(header);
    if (match == null) {
      blobs.push(null);
      offset = headerEnd + 1;
      continue;
    }
    const size = Number(match[1]);
    const contentStart = headerEnd + 1;
    blobs.push(output.subarray(contentStart, contentStart + size));
    offset = contentStart + size + 1;
  }
  return blobs;
}

// Reads a diffed file's current working-tree text. Null means expansion is
// unavailable for this side: path outside the repo, not a regular file,
// oversized, or binary.
async function readWorkingTreeText(
  repoPath: string,
  filePath: string
): Promise<string | null> {
  const absolutePath = path.resolve(repoPath, filePath);
  if (!absolutePath.startsWith(repoPath + path.sep)) {
    return null;
  }
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    return null;
  }
  if (!fileStat.isFile() || fileStat.size > MAX_CONTEXT_FILE_BYTES) {
    return null;
  }
  const content = await readFile(absolutePath);
  return isBinaryBuffer(content) ? null : content.toString('utf8');
}

function isBinaryBuffer(content: Buffer): boolean {
  return content.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}
