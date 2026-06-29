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
// Git's well-known hash of the empty tree. Used as the old side when a range's
// start commit is a root commit (it has no parent to diff against), so a root
// commit reviews as an all-additions diff.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Request-mappable failure: `status` becomes the HTTP status of the response.
export class GitRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Working-tree review: the new side of every diff is the live working tree,
// the old side is `mergeBase`. This backs the branch-base/unpushed/uncommitted
// scopes and live-reloads as the tree changes.
export interface LocalDiffSource {
  kind: 'working-tree';
  repoPath: string;
  branch: string;
  baseRef: string;
  // Old side the tracked diff is computed against. For an ordinary review this
  // is `merge-base(baseRef, HEAD)`; for a merge-preview review (see
  // `mergedTree`) it is the resolved `baseRef` tip instead. Undefined when HEAD
  // has no commits yet (fresh repo) — only untracked files are emitted then.
  mergeBase: string | undefined;
  // Set only for a "merge preview" review: the new side is this merged tree
  // instead of the live working tree. Used when `baseRef` and HEAD share more
  // than one merge base (criss-cross / grafted histories), where a single
  // merge base sits far behind both sides and `git diff <merge-base>` balloons
  // with base content the branch merged in. `git merge-tree` instead computes
  // the tree a merge of the branch into `baseRef` would produce, so the review
  // shows exactly the patch that merge would apply. The merged tree is built
  // from the working-tree state (`git stash create`, or HEAD when clean) and
  // recomputed per request, so the review still live-reloads; untracked files
  // are synthesized on top, since they are absent from the merged tree.
  mergedTree?: string;
}

// Commit-range review: both sides are immutable commits, no working tree
// involved. The diff is `git diff <baseCommit> <toRef>`, where `baseCommit` is
// the parent of the (inclusive) start commit — so a single commit reviews as
// `git show` and a range includes both endpoints' changes.
export interface RangeDiffSource {
  kind: 'range';
  repoPath: string;
  branch: string;
  // Oldest and newest commits included in the review, resolved to full SHAs.
  fromRef: string;
  toRef: string;
  // Old side of the diff: parent of `fromRef`, or the empty tree when `fromRef`
  // is a root commit.
  baseCommit: string;
  // True when the range is a single commit (`fromRef === toRef`).
  single: boolean;
  fromSubject: string;
  toSubject: string;
}

export type ReviewDiffSource = LocalDiffSource | RangeDiffSource;

// Newest-first commit on a branch as the picker and navigation consume it.
// `body` is the message after the subject line (empty when there is none); the
// picker shows it in each row's hover tooltip.
export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorDate: string;
  body: string;
}

// Adjacent commits along HEAD's first-parent history, used by single-commit
// review's prev/next controls. `prevSha` is older (the parent), `nextSha` is
// newer (the child toward HEAD). Either is null at the ends of history.
export interface CommitNeighbors {
  prevSha: string | null;
  nextSha: string | null;
}

export type ReviewScopeId = 'branch-base' | 'unpushed' | 'uncommitted';

export interface ReviewScopeOption {
  id: ReviewScopeId;
  label: string;
  shortLabel: string;
  baseRef: string | null;
  refLabel: string;
  detail: string;
  badge: string;
  available: boolean;
  hasChanges: boolean;
  disabledReason?: string;
}

export interface RepoReviewScopes {
  repoPath: string;
  branch: string;
  defaultBaseRef: string;
  upstreamRef: string | null;
  aheadCount: number;
  behindCount: number;
  dirtyPathCount: number;
  untrackedPathCount: number;
  hasUncommittedChanges: boolean;
  hasUnpushedChanges: boolean;
  options: ReviewScopeOption[];
}

interface WorkingTreeSummary {
  dirtyPathCount: number;
  untrackedPathCount: number;
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

// Runs git and returns its stdout as non-empty trimmed lines (empty array when
// git exits non-zero or prints nothing). Used for commands like
// `merge-base --all` that emit one ref per line.
async function gitTextLines(
  repoPath: string,
  args: string[]
): Promise<string[]> {
  const text = await gitText(repoPath, args);
  if (text == null || text === '') {
    return [];
  }
  return text.split('\n').filter((line) => line !== '');
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

export async function resolveRepoReviewScopes(
  repoInput: string
): Promise<RepoReviewScopes> {
  const { repoPath, branch } = await resolveRepoIdentity(repoInput);
  const [defaultBaseRef, headSha, workingTree, upstreamRef] = await Promise.all(
    [
      resolveBaseRef(repoPath, null),
      gitText(repoPath, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
      summarizeWorkingTree(repoPath),
      resolveUpstreamRef(repoPath),
    ]
  );

  const hasHead = headSha != null && headSha !== '';
  const upstreamCounts =
    upstreamRef != null && hasHead
      ? await countUpstreamDelta(repoPath, upstreamRef)
      : { aheadCount: 0, behindCount: 0 };
  const hasUncommittedChanges = workingTree.dirtyPathCount > 0;
  const hasUnpushedChanges = upstreamCounts.aheadCount > 0;

  return {
    repoPath,
    branch,
    defaultBaseRef,
    upstreamRef,
    aheadCount: upstreamCounts.aheadCount,
    behindCount: upstreamCounts.behindCount,
    dirtyPathCount: workingTree.dirtyPathCount,
    untrackedPathCount: workingTree.untrackedPathCount,
    hasUncommittedChanges,
    hasUnpushedChanges,
    options: buildReviewScopeOptions({
      defaultBaseRef,
      upstreamRef,
      hasHead,
      hasUncommittedChanges,
      hasUnpushedChanges,
      dirtyPathCount: workingTree.dirtyPathCount,
      aheadCount: upstreamCounts.aheadCount,
      behindCount: upstreamCounts.behindCount,
    }),
  };
}

async function resolveUpstreamRef(repoPath: string): Promise<string | null> {
  const upstream = await gitText(repoPath, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{upstream}',
  ]);
  return upstream == null || upstream === '' ? null : upstream;
}

async function countUpstreamDelta(
  repoPath: string,
  upstreamRef: string
): Promise<{ aheadCount: number; behindCount: number }> {
  const output = await gitText(repoPath, [
    'rev-list',
    '--left-right',
    '--count',
    `${upstreamRef}...HEAD`,
  ]);
  if (output == null || output === '') {
    return { aheadCount: 0, behindCount: 0 };
  }

  const [behindRaw, aheadRaw] = output.split(/\s+/, 2);
  return {
    aheadCount: Number(aheadRaw ?? 0),
    behindCount: Number(behindRaw ?? 0),
  };
}

async function summarizeWorkingTree(
  repoPath: string
): Promise<WorkingTreeSummary> {
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

  let dirtyPathCount = 0;
  let untrackedPathCount = 0;
  const records = result.stdout.toString('utf8').split('\0');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!isPorcelainStatusRecord(record)) {
      continue;
    }

    dirtyPathCount++;
    const status = record.slice(0, 2);
    if (status === '??') {
      untrackedPathCount++;
    }
    if (status[0] === 'R' || status[0] === 'C') {
      index++;
    }
  }

  return { dirtyPathCount, untrackedPathCount };
}

function isPorcelainStatusRecord(record: string): boolean {
  if (record.length < 4 || record[2] !== ' ') {
    return false;
  }
  const x = record[0];
  const y = record[1];
  return x !== ' ' || y !== ' ';
}

function buildReviewScopeOptions({
  defaultBaseRef,
  upstreamRef,
  hasHead,
  hasUncommittedChanges,
  hasUnpushedChanges,
  dirtyPathCount,
  aheadCount,
  behindCount,
}: {
  defaultBaseRef: string;
  upstreamRef: string | null;
  hasHead: boolean;
  hasUncommittedChanges: boolean;
  hasUnpushedChanges: boolean;
  dirtyPathCount: number;
  aheadCount: number;
  behindCount: number;
}): ReviewScopeOption[] {
  const upstreamAvailable = upstreamRef != null && hasHead;

  return [
    {
      id: 'branch-base',
      label: 'Branch base',
      shortLabel: 'Base',
      baseRef: null,
      refLabel: defaultBaseRef,
      detail:
        defaultBaseRef === 'HEAD'
          ? 'Working tree against HEAD'
          : `All changes since ${defaultBaseRef}`,
      badge: defaultBaseRef,
      available: true,
      hasChanges: hasUncommittedChanges || hasUnpushedChanges,
    },
    {
      id: 'unpushed',
      label: 'Unpushed changes',
      shortLabel: 'Unpushed',
      baseRef: upstreamRef,
      refLabel: upstreamRef ?? 'No upstream',
      detail: upstreamDetail(upstreamRef, aheadCount, behindCount),
      badge:
        upstreamRef == null
          ? 'no upstream'
          : aheadCount === 0
            ? '0 ahead'
            : `${aheadCount} ahead`,
      available: upstreamAvailable,
      hasChanges: hasUnpushedChanges,
      disabledReason: upstreamAvailable ? undefined : 'No upstream branch',
    },
    {
      id: 'uncommitted',
      label: 'Uncommitted changes',
      shortLabel: 'Uncommitted',
      baseRef: 'HEAD',
      refLabel: 'HEAD',
      detail: hasUncommittedChanges
        ? `${dirtyPathCount} dirty ${dirtyPathCount === 1 ? 'path' : 'paths'}`
        : 'Working tree clean',
      badge: hasUncommittedChanges ? `${dirtyPathCount} dirty` : 'clean',
      available: hasHead,
      hasChanges: hasUncommittedChanges,
      disabledReason: hasHead ? undefined : 'Repository has no commits yet',
    },
  ];
}

function upstreamDetail(
  upstreamRef: string | null,
  aheadCount: number,
  behindCount: number
): string {
  if (upstreamRef == null) {
    return 'No upstream configured';
  }
  if (aheadCount === 0 && behindCount === 0) {
    return `No unpushed commits relative to ${upstreamRef}`;
  }
  const parts: string[] = [];
  if (aheadCount > 0) {
    parts.push(
      `${aheadCount} ${aheadCount === 1 ? 'commit' : 'commits'} ahead`
    );
  }
  if (behindCount > 0) {
    parts.push(
      `${behindCount} ${behindCount === 1 ? 'commit' : 'commits'} behind`
    );
  }
  return `${parts.join(', ')} relative to ${upstreamRef}`;
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
  let mergedTree: string | undefined;
  if (headSha != null && headSha !== '') {
    // Unrelated histories have no merge base; reviewing the working tree
    // against HEAD is the most useful fallback.
    mergeBase =
      (await gitText(repoPath, ['merge-base', baseRef, 'HEAD'])) ?? headSha;

    // When baseRef and HEAD share more than one merge base, the single base
    // above can sit far behind both sides (criss-cross / grafted histories),
    // ballooning the diff with base content the branch merged in. Switch to a
    // merge preview so the review shows only the patch a merge would apply.
    const mergeBases = await gitTextLines(repoPath, [
      'merge-base',
      '--all',
      baseRef,
      'HEAD',
    ]);
    if (mergeBases.length > 1) {
      const preview = await buildMergePreview(repoPath, baseRef);
      if (preview != null) {
        mergeBase = preview.baseSha;
        mergedTree = preview.mergedTree;
      }
    }
  }

  return {
    kind: 'working-tree',
    repoPath,
    branch,
    baseRef,
    mergeBase,
    mergedTree,
  };
}

// Computes the merge-preview new side for a criss-cross review: the tree a
// merge of the working-tree state into `baseRef` would produce. Returns the
// resolved `baseRef` tip (the diff's old side) and that merged tree, or null
// when the preview can't be built (merge-tree unsupported/failed) so the caller
// falls back to the single merge base. `git stash create` snapshots committed
// HEAD plus uncommitted tracked edits without touching the index, working tree,
// or refs (it returns empty for a clean tree, in which case HEAD is merged);
// untracked files are absent from the snapshot and synthesized separately.
async function buildMergePreview(
  repoPath: string,
  baseRef: string
): Promise<{ baseSha: string; mergedTree: string } | null> {
  const baseSha = await gitText(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${baseRef}^{commit}`,
  ]);
  if (baseSha == null || baseSha === '') {
    return null;
  }
  const stashCommit = await gitText(repoPath, ['stash', 'create']);
  const mergeInput =
    stashCommit != null && stashCommit !== '' ? stashCommit : 'HEAD';
  // merge-tree --write-tree writes the merged tree to the object store and
  // prints its OID on the first stdout line. Exit 0 is a clean merge and exit 1
  // a conflicted one; both still yield a usable tree (a conflicted tree carries
  // conflict-marker blobs, which surface in the diff as the conflict they are).
  // Any other exit (e.g. unrelated histories) prints no tree, so validate the
  // first line is a real tree object before trusting it.
  const result = await runGit(repoPath, [
    'merge-tree',
    '--write-tree',
    baseSha,
    mergeInput,
  ]);
  const firstLine = result.stdout.toString('utf8').split('\n', 1)[0]?.trim();
  if (firstLine == null || !/^[0-9a-f]{40,64}$/.test(firstLine)) {
    return null;
  }
  const objectType = await gitText(repoPath, ['cat-file', '-t', firstLine]);
  if (objectType !== 'tree') {
    return null;
  }
  return { baseSha, mergedTree: firstLine };
}

export interface ReviewDiffSourceParams {
  commit?: string | null;
  from?: string | null;
  to?: string | null;
  base?: string | null;
}

// Resolves the diff source a review request asks for from its query params:
// `commit` (single commit), `from`+`to` (commit range), or `base`/none
// (working-tree review). Single commit is a range whose endpoints are equal.
export async function resolveReviewDiffSource(
  repoInput: string,
  params: ReviewDiffSourceParams
): Promise<ReviewDiffSource> {
  const commit = nonEmptyParam(params.commit);
  const from = nonEmptyParam(params.from);
  const to = nonEmptyParam(params.to);
  if (commit != null) {
    return resolveRangeDiffSource(repoInput, commit, commit);
  }
  if (from != null || to != null) {
    if (from == null || to == null) {
      throw new GitRequestError(
        'Both from and to commits are required for a range review'
      );
    }
    return resolveRangeDiffSource(repoInput, from, to);
  }
  return resolveLocalDiffSource(repoInput, params.base ?? null);
}

function nonEmptyParam(value: string | null | undefined): string | null {
  return value != null && value !== '' ? value : null;
}

// Resolves a user-supplied ref to a full commit SHA, rejecting anything that
// is not a commit so a typo can't silently diff the wrong object.
async function resolveCommitSha(
  repoPath: string,
  ref: string,
  label: string
): Promise<string> {
  const sha = await gitText(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]);
  if (sha == null || sha === '') {
    throw new GitRequestError(`${label} commit not found: ${ref}`);
  }
  return sha;
}

async function commitSubject(repoPath: string, sha: string): Promise<string> {
  return (await gitText(repoPath, ['log', '-1', '--format=%s', sha])) ?? '';
}

// Resolves a commit-range review source. `from`/`to` may be given in either
// order; ancestry decides which is older. The diff baseline is the parent of
// the older commit (so both endpoints' changes are included), falling back to
// the empty tree for a root start commit. For commits on divergent histories
// (neither is an ancestor of the other) the user's `from` becomes the baseline
// directly, which still yields a valid tree-to-tree diff.
export async function resolveRangeDiffSource(
  repoInput: string,
  fromInput: string,
  toInput: string
): Promise<RangeDiffSource> {
  const { repoPath, branch } = await resolveRepoIdentity(repoInput);
  const [fromSha, toSha] = await Promise.all([
    resolveCommitSha(repoPath, fromInput, 'Start'),
    resolveCommitSha(repoPath, toInput, 'End'),
  ]);

  let olderSha = fromSha;
  let newerSha = toSha;
  let divergent = false;
  if (fromSha !== toSha) {
    if (await isAncestor(repoPath, fromSha, toSha)) {
      olderSha = fromSha;
      newerSha = toSha;
    } else if (await isAncestor(repoPath, toSha, fromSha)) {
      olderSha = toSha;
      newerSha = fromSha;
    } else {
      divergent = true;
    }
  }

  // Inclusive of the older commit: diff against its parent. Divergent picks
  // can't be made inclusive coherently, so the older commit is the baseline.
  const baseCommit = divergent
    ? olderSha
    : ((await gitText(repoPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${olderSha}^`,
      ])) ?? EMPTY_TREE_SHA);

  const [fromSubject, toSubject] = await Promise.all([
    commitSubject(repoPath, olderSha),
    commitSubject(repoPath, newerSha),
  ]);

  return {
    kind: 'range',
    repoPath,
    branch,
    fromRef: olderSha,
    toRef: newerSha,
    baseCommit,
    single: olderSha === newerSha,
    fromSubject,
    toSubject,
  };
}

async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  const result = await runGit(repoPath, [
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  ]);
  return result.code === 0;
}

// Lists commits newest-first along HEAD for the commit picker. `limit` caps the
// page; `skip` pages further back. `hasMore` is true when a full page came
// back, so the caller can offer a "load more".
export async function listRepoCommits(
  repoInput: string,
  { limit = 100, skip = 0 }: { limit?: number; skip?: number } = {}
): Promise<{ commits: CommitSummary[]; hasMore: boolean }> {
  const { repoPath } = await resolveRepoIdentity(repoInput);
  const headSha = await gitText(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    'HEAD^{commit}',
  ]);
  if (headSha == null || headSha === '') {
    return { commits: [], hasMore: false };
  }

  // Records are NUL-terminated (-z) and fields unit-separated (US, 0x1f), so
  // the last field — the body (%b) — can hold newlines without ambiguity.
  const result = await runGit(repoPath, [
    'log',
    '--no-color',
    '-z',
    `--max-count=${limit}`,
    `--skip=${skip}`,
    '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b',
    'HEAD',
  ]);
  if (result.code !== 0) {
    throw new GitRequestError(
      `Unable to list commits: ${result.stderr.trim()}`
    );
  }

  const text = result.stdout.toString('utf8');
  const commits: CommitSummary[] = [];
  for (const record of text.split('\0')) {
    if (record === '') {
      continue;
    }
    const [sha, shortSha, authorName, authorDate, subject, body] =
      record.split('\x1f');
    if (sha == null) {
      continue;
    }
    commits.push({
      sha,
      shortSha: shortSha ?? sha.slice(0, 7),
      subject: subject ?? '',
      authorName: authorName ?? '',
      authorDate: authorDate ?? '',
      body: (body ?? '').trim(),
    });
  }
  return { commits, hasMore: commits.length === limit };
}

// Finds the commits adjacent to `commit` along HEAD's first-parent history.
// `prevSha` (older) is the commit's first parent. `nextSha` (newer) is the
// first commit on the ancestry path from `commit` to HEAD — bounded to that
// path, so it never walks the whole history.
export async function resolveCommitNeighbors(
  repoInput: string,
  commit: string
): Promise<CommitNeighbors> {
  const { repoPath } = await resolveRepoIdentity(repoInput);
  const sha = await resolveCommitSha(repoPath, commit, 'Commit');

  const prevSha =
    (await gitText(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${sha}^`,
    ])) ?? null;

  const ancestryPath = await gitText(repoPath, [
    'rev-list',
    '--ancestry-path',
    '--first-parent',
    '--reverse',
    `${sha}..HEAD`,
  ]);
  const nextSha =
    ancestryPath == null || ancestryPath === ''
      ? null
      : (ancestryPath.split('\n')[0] ?? null);

  return { prevSha, nextSha };
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

// Streams the full review patch. Working-tree review emits `git diff
// <merge-base>` (working tree included) followed by synthesized new-file
// patches for untracked files, which git diff does not emit on its own.
// Range review emits `git diff <baseCommit> <toRef>` only — both sides are
// committed, so there are no untracked files to synthesize.
export function createLocalDiffStream(
  source: ReviewDiffSource
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  let killDiffProcess: (() => void) | undefined;
  const registerKill = (kill: () => void) => {
    killDiffProcess = kill;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (source.kind === 'range') {
          await pumpGitDiff(
            source.repoPath,
            [source.baseCommit, source.toRef],
            controller,
            registerKill,
            () => cancelled
          );
        } else {
          if (source.mergeBase != null) {
            // Ordinary review diffs the old side against the live working tree
            // (one rev). A merge-preview review diffs the old side against the
            // precomputed merged tree (two revs); its untracked files are still
            // absent from that tree, so they are synthesized below as usual.
            const diffRevs =
              source.mergedTree != null
                ? [source.mergeBase, source.mergedTree]
                : [source.mergeBase];
            await pumpGitDiff(
              source.repoPath,
              diffRevs,
              controller,
              registerKill,
              () => cancelled
            );
          }
          if (!cancelled) {
            await pumpUntrackedFiles(
              source.repoPath,
              controller,
              encoder,
              () => cancelled
            );
          }
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

// Runs `git diff <...diffRevs>` and pumps its stdout to the stream. `diffRevs`
// is a single rev (diff against the working tree) for working-tree review, or
// two commits (old then new) for range review.
function pumpGitDiff(
  repoPath: string,
  diffRevs: string[],
  controller: ReadableStreamDefaultController<Uint8Array>,
  registerKill: (kill: () => void) => void,
  isCancelled: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'git',
      [
        '-C',
        repoPath,
        'diff',
        '--find-renames',
        '--no-color',
        '--no-ext-diff',
        ...diffRevs,
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
  repoPath: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  isCancelled: () => boolean
): Promise<void> {
  const untrackedPaths = await listUntrackedFiles(repoPath);
  for (const filePath of untrackedPaths) {
    if (isCancelled()) {
      return;
    }
    const patch = await synthesizeUntrackedPatch(repoPath, filePath);
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
// GitHub-style expansion of unmodified context around hunks. Either side is
// null when unavailable as text: missing path, non-blob (submodule), binary,
// or oversized. For working-tree review the old side is the merge-base blob and
// the new side is the working tree (or, for a merge-preview review, the merged
// tree blob with a working-tree fallback); for range review both sides are
// commit blobs (`baseCommit` and `toRef`).
export async function loadDiffFileContents(
  source: ReviewDiffSource,
  files: DiffFileContentsRequest[]
): Promise<DiffFileContents[]> {
  if (source.kind === 'range') {
    const [oldTexts, newTexts] = await Promise.all([
      loadBlobTexts(
        source.repoPath,
        files.map((file) => {
          const sourcePath = file.prevPath ?? file.path;
          return isSafeRepoRelativePath(sourcePath)
            ? `${source.baseCommit}:${sourcePath}`
            : null;
        })
      ),
      loadBlobTexts(
        source.repoPath,
        files.map((file) =>
          isSafeRepoRelativePath(file.path)
            ? `${source.toRef}:${file.path}`
            : null
        )
      ),
    ]);
    return files.map((file, index) => ({
      path: file.path,
      oldContents: oldTexts[index] ?? null,
      newContents: newTexts[index] ?? null,
    }));
  }

  const { mergeBase, mergedTree } = source;
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
  // Merge-preview review reads the new side from the merged tree, falling back
  // to the working tree for paths absent from it (untracked files, or comment
  // anchors outside the diff). Ordinary review reads the working tree directly.
  const treeNewTexts =
    mergedTree == null
      ? null
      : await loadBlobTexts(
          source.repoPath,
          files.map((file) =>
            isSafeRepoRelativePath(file.path)
              ? `${mergedTree}:${file.path}`
              : null
          )
        );
  return Promise.all(
    files.map(async (file, index) => ({
      path: file.path,
      oldContents: oldTexts[index] ?? null,
      newContents:
        treeNewTexts?.[index] ??
        (await readWorkingTreeText(source.repoPath, file.path)),
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
