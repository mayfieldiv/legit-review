import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Durable review state, one JSON file per repo+branch. Lives outside the
// repository (XDG data dir) so reviews never dirty the working tree and
// survive restarts. Writes are atomic (temp file + rename) and serialized
// per state file so concurrent route handlers can't interleave read-modify-
// write cycles.

export type CommentSide = 'deletions' | 'additions';

export interface StoredCommentRange {
  start: number;
  side?: CommentSide;
  end: number;
  endSide?: CommentSide;
}

// A threaded reply under a comment. User-authored replies and resolution
// events share the parent's anchor; only the root comment carries the current
// resolved/unresolved state, GitHub-style.
export type StoredCommentReplyKind = 'reply' | 'resolution';

export interface StoredCommentReply {
  id: string;
  kind: StoredCommentReplyKind;
  author: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredComment {
  id: string;
  filePath: string;
  side: CommentSide;
  lineNumber: number;
  range: StoredCommentRange;
  // Text of the anchored line and hash of its containing hunk when the
  // comment was created — used to flag comments as outdated once the code
  // they refer to changes.
  lineSnippet: string;
  hunkHash: string;
  message: string;
  author: string;
  replies: StoredCommentReply[];
  resolved: boolean;
  resolvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewState {
  version: 1;
  repoPath: string;
  branch: string;
  comments: StoredComment[];
  // filePath -> hunk-body hashes the reviewer marked viewed. Invalidation is
  // implicit: an edited hunk gets a new hash that simply isn't in the list.
  viewedHunks: Record<string, string[]>;
  // filePath -> whole-file patch hash at the time the file was marked viewed.
  viewedFiles: Record<string, string>;
}

export interface CreateCommentInput {
  filePath: string;
  side: CommentSide;
  range: StoredCommentRange;
  lineSnippet?: string;
  hunkHash?: string;
  message: string;
  author?: string;
}

export interface UpdateCommentInput {
  message?: string;
  resolved?: boolean;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface CreateReplyInput {
  message: string;
  author?: string;
}

function dataDir(): string {
  const override = process.env.PIERRE_REVIEW_DATA_DIR;
  if (override != null && override !== '') {
    return override;
  }
  const xdgData = process.env.XDG_DATA_HOME;
  const dataHome =
    xdgData != null && xdgData !== ''
      ? xdgData
      : path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'pierre-review');
}

export function stateFilePath(repoPath: string, branch: string): string {
  const repoKey = createHash('sha1').update(repoPath).digest('hex');
  return path.join(dataDir(), repoKey, `${encodeURIComponent(branch)}.json`);
}

function createEmptyState(repoPath: string, branch: string): ReviewState {
  return {
    version: 1,
    repoPath,
    branch,
    comments: [],
    viewedHunks: {},
    viewedFiles: {},
  };
}

export async function readState(
  repoPath: string,
  branch: string
): Promise<ReviewState> {
  try {
    const raw = await readFile(stateFilePath(repoPath, branch), 'utf8');
    const parsed = JSON.parse(raw) as ReviewState;
    if (parsed.version !== 1) {
      return createEmptyState(repoPath, branch);
    }
    for (const comment of parsed.comments) {
      normalizeComment(comment);
    }
    return parsed;
  } catch {
    return createEmptyState(repoPath, branch);
  }
}

// Upgrades comments written before reply threads existed: gives them an empty
// reply list and converts the old free-form `resolutionNote` field into a
// reply from the resolver, so historical notes stay visible in threads.
function normalizeComment(
  comment: StoredComment & {
    replies?: (StoredCommentReply & { kind?: StoredCommentReplyKind })[];
    resolutionNote?: string;
  }
): void {
  comment.replies ??= [];
  for (const reply of comment.replies) {
    reply.kind ??= 'reply';
  }
  if (comment.resolutionNote != null) {
    if (comment.resolutionNote !== '') {
      comment.replies.push({
        // Deterministic id: the migration runs on every read until the next
        // write persists it, and the reply must keep its identity across
        // those reads for edit/delete to target it.
        id: `legacy-note-${comment.id}`,
        kind: 'resolution',
        author: comment.resolvedBy ?? 'agent',
        message: comment.resolutionNote,
        createdAt: comment.updatedAt,
        updatedAt: comment.updatedAt,
      });
    }
    delete comment.resolutionNote;
  }
}

async function writeStateFile(
  filePath: string,
  state: ReviewState
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

// Per-file promise chains that serialize read-modify-write cycles.
const mutationQueues = new Map<string, Promise<unknown>>();

export async function mutateState(
  repoPath: string,
  branch: string,
  mutate: (state: ReviewState) => void | Promise<void>
): Promise<ReviewState> {
  const filePath = stateFilePath(repoPath, branch);
  const previous = mutationQueues.get(filePath) ?? Promise.resolve();
  const task = previous.then(async () => {
    const state = await readState(repoPath, branch);
    await mutate(state);
    await writeStateFile(filePath, state);
    return state;
  });
  // Keep the chain alive even when a mutation rejects.
  mutationQueues.set(
    filePath,
    task.catch(() => undefined)
  );
  return task;
}

export async function createComment(
  repoPath: string,
  branch: string,
  input: CreateCommentInput
): Promise<StoredComment> {
  const now = new Date().toISOString();
  const comment: StoredComment = {
    id: randomUUID(),
    filePath: input.filePath,
    side: input.side,
    lineNumber: input.range.end,
    range: input.range,
    lineSnippet: input.lineSnippet ?? '',
    hunkHash: input.hunkHash ?? '',
    message: input.message,
    author: input.author ?? 'user',
    replies: [],
    resolved: false,
    createdAt: now,
    updatedAt: now,
  };
  await mutateState(repoPath, branch, (state) => {
    state.comments.push(comment);
  });
  return comment;
}

export async function updateComment(
  repoPath: string,
  branch: string,
  id: string,
  input: UpdateCommentInput
): Promise<StoredComment | undefined> {
  let updated: StoredComment | undefined;
  await mutateState(repoPath, branch, (state) => {
    const comment = state.comments.find((entry) => entry.id === id);
    if (comment == null) {
      return;
    }
    if (input.message != null) {
      comment.message = input.message;
    }
    if (input.resolved != null) {
      const wasResolved = comment.resolved;
      comment.resolved = input.resolved;
      if (input.resolved) {
        const resolvedBy = input.resolvedBy ?? comment.resolvedBy ?? 'user';
        const resolutionNote = input.resolutionNote?.trim() ?? '';
        comment.resolvedBy = resolvedBy;
        if (!wasResolved || resolutionNote !== '') {
          const now = new Date().toISOString();
          comment.replies.push({
            id: randomUUID(),
            kind: 'resolution',
            author: resolvedBy,
            message: resolutionNote,
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        delete comment.resolvedBy;
      }
    }
    comment.updatedAt = new Date().toISOString();
    updated = comment;
  });
  return updated;
}

export async function addCommentReply(
  repoPath: string,
  branch: string,
  commentId: string,
  input: CreateReplyInput
): Promise<StoredComment | undefined> {
  let updated: StoredComment | undefined;
  await mutateState(repoPath, branch, (state) => {
    const comment = state.comments.find((entry) => entry.id === commentId);
    if (comment == null) {
      return;
    }
    const now = new Date().toISOString();
    comment.replies.push({
      id: randomUUID(),
      kind: 'reply',
      author: input.author ?? 'user',
      message: input.message,
      createdAt: now,
      updatedAt: now,
    });
    comment.updatedAt = now;
    updated = comment;
  });
  return updated;
}

export async function updateCommentReply(
  repoPath: string,
  branch: string,
  commentId: string,
  replyId: string,
  message: string
): Promise<StoredComment | undefined> {
  let updated: StoredComment | undefined;
  await mutateState(repoPath, branch, (state) => {
    const comment = state.comments.find((entry) => entry.id === commentId);
    const reply = comment?.replies.find((entry) => entry.id === replyId);
    if (comment == null || reply == null) {
      return;
    }
    reply.message = message;
    reply.updatedAt = new Date().toISOString();
    updated = comment;
  });
  return updated;
}

export async function deleteCommentReply(
  repoPath: string,
  branch: string,
  commentId: string,
  replyId: string
): Promise<StoredComment | undefined> {
  let updated: StoredComment | undefined;
  await mutateState(repoPath, branch, (state) => {
    const comment = state.comments.find((entry) => entry.id === commentId);
    if (comment == null) {
      return;
    }
    const next = comment.replies.filter((entry) => entry.id !== replyId);
    if (next.length === comment.replies.length) {
      return;
    }
    comment.replies = next;
    updated = comment;
  });
  return updated;
}

export async function deleteComment(
  repoPath: string,
  branch: string,
  id: string
): Promise<boolean> {
  let deleted = false;
  await mutateState(repoPath, branch, (state) => {
    const next = state.comments.filter((entry) => entry.id !== id);
    deleted = next.length !== state.comments.length;
    state.comments = next;
  });
  return deleted;
}

export interface ViewedMarksInput {
  viewed: boolean;
  hunkHashes?: string[];
  fileHash?: string;
}

// Applies hunk- and file-level viewed marks for one file in a single
// serialized mutation, so a whole-file toggle is one write instead of two.
// Unviewing always clears the file-level mark: a file with any explicitly
// unviewed hunk is no longer "viewed", regardless of the stored file hash.
export async function setViewedMarks(
  repoPath: string,
  branch: string,
  filePath: string,
  input: ViewedMarksInput
): Promise<ReviewState> {
  return mutateState(repoPath, branch, (state) => {
    if (input.hunkHashes != null) {
      const current = new Set(state.viewedHunks[filePath] ?? []);
      for (const hash of input.hunkHashes) {
        if (input.viewed) {
          current.add(hash);
        } else {
          current.delete(hash);
        }
      }
      if (current.size === 0) {
        delete state.viewedHunks[filePath];
      } else {
        state.viewedHunks[filePath] = [...current].sort();
      }
    }
    if (input.viewed) {
      if (input.fileHash != null) {
        state.viewedFiles[filePath] = input.fileHash;
      }
    } else {
      delete state.viewedFiles[filePath];
    }
  });
}
