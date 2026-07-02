import { stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveLocalDiffSource, traceRenamedPaths } from './git';
import { mutateState, type ReviewState } from './store';

// Review comments anchor to the file path captured when the comment was
// written. A later rename (say an agent renaming a file while addressing the
// review) leaves those threads pointing at a path that exists neither in the
// diff nor on disk, so the UI can't navigate to them or resolve them. Before
// state is served, remap comments whose file vanished from the working tree
// to wherever git says the file moved, so threads follow the file the way
// they do on hosted review tools. Viewed marks are keyed by path too and
// move along (their content hashes decide whether they still apply).
// Comments on files that were deleted rather than renamed stay untouched.

export interface ReconcileResult {
  state: ReviewState;
  changed: boolean;
}

export async function reconcileCommentRenames(
  repoPath: string,
  branch: string,
  state: ReviewState
): Promise<ReconcileResult> {
  // A reconcile failure must never take down state reads; serve the state
  // as stored instead.
  try {
    return await remapRenamedCommentPaths(repoPath, branch, state);
  } catch (error) {
    console.warn('Failed to reconcile renamed comment paths', error);
    return { state, changed: false };
  }
}

async function remapRenamedCommentPaths(
  repoPath: string,
  branch: string,
  state: ReviewState
): Promise<ReconcileResult> {
  const strandedPaths = await listStrandedCommentPaths(repoPath, state);
  if (strandedPaths.length === 0) {
    return { state, changed: false };
  }
  // Spawning git on this read path is acceptable: it only happens while a
  // stranded comment exists, and a successful remap removes the trigger.
  // Deleted (not renamed) files re-run the trace on every read, but a review
  // rarely holds comments on deleted files for long.
  const source = await resolveLocalDiffSource(repoPath, null);
  const renames = await traceRenamedPaths(
    repoPath,
    source.mergeBase,
    strandedPaths
  );
  const remaps = new Map<string, string>();
  for (const [oldPath, newPath] of renames) {
    // A rename target can itself be gone (renamed then deleted); remapping
    // to it would just strand the comment under a new name.
    if (await workingTreeFileExists(repoPath, newPath)) {
      remaps.set(oldPath, newPath);
    }
  }
  if (remaps.size === 0) {
    return { state, changed: false };
  }
  const next = await mutateState(repoPath, branch, (draft) => {
    for (const comment of draft.comments) {
      const newPath = remaps.get(comment.filePath);
      if (newPath != null) {
        comment.filePath = newPath;
      }
    }
    remapRecordKeys(draft.viewedHunks, remaps);
    remapRecordKeys(draft.viewedFiles, remaps);
  });
  return { state: next, changed: true };
}

// Unique comment paths that no longer exist as working-tree files. These are
// the only candidates worth a git rename trace.
async function listStrandedCommentPaths(
  repoPath: string,
  state: ReviewState
): Promise<string[]> {
  const uniquePaths = new Set(
    state.comments.map((comment) => comment.filePath)
  );
  const stranded: string[] = [];
  for (const filePath of uniquePaths) {
    if (!(await workingTreeFileExists(repoPath, filePath))) {
      stranded.push(filePath);
    }
  }
  return stranded;
}

async function workingTreeFileExists(
  repoPath: string,
  filePath: string
): Promise<boolean> {
  const absolutePath = path.resolve(repoPath, filePath);
  if (!absolutePath.startsWith(repoPath + path.sep)) {
    return false;
  }
  try {
    return (await stat(absolutePath)).isFile();
  } catch {
    return false;
  }
}

function remapRecordKeys<T>(
  record: Record<string, T>,
  remaps: Map<string, string>
): void {
  for (const [oldPath, newPath] of remaps) {
    const value = record[oldPath];
    if (value !== undefined && record[newPath] === undefined) {
      record[newPath] = value;
    }
    delete record[oldPath];
  }
}
