import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
  LineAnnotation,
  SelectedLineRange,
} from '@pierre/diffs';
import type { FileTreeGitStatusPatch, GitStatusEntry } from '@pierre/trees';

export type ViewerLoadState =
  | 'fetching'
  | 'streaming'
  | 'parsing'
  | 'ready'
  | 'error';

export type ReviewMode = 'working-tree' | 'range' | 'single';

// Resolved identity of the local diff being reviewed, parsed from the
// X-Review-* response headers of /api/diff. `baseRef` is set for working-tree
// review; the commit fields are set for range/single review, with prev/next
// neighbors present only in single-commit mode.
export interface ReviewSourceInfo {
  repoPath: string;
  branch: string;
  mode: ReviewMode;
  baseRef?: string;
  fromSha?: string;
  toSha?: string;
  fromSubject?: string;
  toSubject?: string;
  prevSha?: string | null;
  nextSha?: string | null;
}

// One non-root thread entry as the UI consumes it: either a discussion reply or
// a resolution event created when the thread is marked resolved.
export interface CommentReply {
  id: string;
  kind: 'reply' | 'resolution';
  author: string;
  message: string;
  createdAt: string;
}

export interface SavedCommentMetadata {
  kind: 'saved';
  // The store id doubles as the annotation key.
  key: string;
  author: string;
  message: string;
  createdAt: string;
  range: SelectedLineRange;
  replies: CommentReply[];
  resolved: boolean;
  resolvedBy?: string;
  // True when the hunk this comment was anchored to no longer exists in the
  // current diff (its content hash disappeared) — the code changed since the
  // comment was written.
  outdated: boolean;
}

export interface DraftCommentMetadata {
  kind: 'draft';
  key: string;
  message: string;
  range: SelectedLineRange;
}

export interface HunkViewedState {
  hunkHash: string;
  viewed: boolean;
}

export type CommentMetadata = SavedCommentMetadata | DraftCommentMetadata;

// An annotation on either item kind: diff items carry a side, while legacy
// plain file items don't.
export type CommentAnnotation<M extends CommentMetadata = CommentMetadata> =
  | DiffLineAnnotation<M>
  | LineAnnotation<M>;

export interface CodeViewCommentSidebarFile {
  fileOrder: number;
  path: string;
}

export type CodeViewCommentFileByItemId = ReadonlyMap<
  string,
  CodeViewCommentSidebarFile
>;

// Whether the line the comment is anchored to is a real addition/deletion or
// an unchanged context line shown in the diff. Tracked so the sidebar can
// render "Line N" without a misleading + / - sigil for context lines.
export type CommentLineType = 'change' | 'context';

// Everything the viewer knows about a draft when it is submitted; the
// container resolves the file path + hunk hash and POSTs to the store.
// `fileDiff` is absent for drafts on plain file items. Context-only diff
// snippets for unchanged files still pass a full-context diff and include a
// line snippet so they anchor with an empty hunk hash plus the line text.
export interface PersistCommentInput {
  fileDiff?: FileDiffMetadata;
  itemId: string;
  lineSnippet?: string;
  message: string;
  range: SelectedLineRange;
  side: AnnotationSide;
}

// A comment as returned by /api/state and /api/comments.
export interface ReviewStateComment {
  id: string;
  filePath: string;
  side: AnnotationSide;
  lineNumber: number;
  range: SelectedLineRange;
  lineSnippet: string;
  hunkHash: string;
  message: string;
  author: string;
  replies: CommentReply[];
  resolved: boolean;
  resolvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewStateResponse {
  repoPath: string;
  branch: string;
  comments: ReviewStateComment[];
  viewedHunks: Record<string, string[]>;
  viewedFiles: Record<string, string>;
}

export interface CodeViewSavedCommentEvent {
  author: string;
  itemId: string;
  key: string;
  lineNumber: number;
  lineType: CommentLineType;
  message: string;
  outdated: boolean;
  range: SelectedLineRange;
  replyCount: number;
  resolved: boolean;
  side: AnnotationSide;
}

export interface CodeViewDeletedCommentEvent {
  itemId: string;
  key: string;
}

export interface CodeViewSavedCommentEntry {
  author: string;
  itemId: string;
  key: string;
  lineNumber: number;
  lineType: CommentLineType;
  message: string;
  outdated: boolean;
  range: SelectedLineRange;
  replyCount: number;
  resolved: boolean;
  side: AnnotationSide;
  // True when the comment's file exists neither in the review diff nor as
  // readable working-tree contents (deleted, or renamed in a way git can't
  // trace). The viewer has no item to navigate to, so the sidebar card is
  // the thread's only surface and must offer resolve/reopen itself.
  stranded: boolean;
}

export interface CodeViewSavedCommentItem {
  comments: CodeViewSavedCommentEntry[];
  fileOrder: number;
  itemId: string;
  path: string;
}

export interface CodeViewFileTreeFileStats {
  addedLines: number;
  deletedLines: number;
}

// The fully pre-computed input this tree needs for a given fetch. It is built
// once at fetch time by snapshotCodeViewTreeSource and stored alongside the
// viewer items, so later per-item annotation updates do not feed into the
// tree and do not cause it to rebuild.
//
// Streamed publishes link successive snapshots through `previousSource` so the
// tree consumer can recognize append-only growth and apply the delta as
// `model.batch` adds instead of rebuilding the entire path store. The link is
// present only on snapshots that share the same underlying accumulator; the
// initial publish and any non-streamed source leave it undefined and force a
// full reset.
//
// `paths` and `pathToItemId` may alias the live accumulator state for
// streamed sources, so consumers must treat them as read-only and must use
// `pathCount` (captured at snapshot time) as the exclusive upper bound when
// iterating `paths`. The `readonly` markers and ReadonlyMap type enforce the
// read-only side; pathCount is what keeps later in-place growth invisible to
// this snapshot.
export interface CodeViewFileTreeSource {
  directoryStatsByPath: ReadonlyMap<string, CodeViewFileTreeFileStats>;
  fileStatsByPath: ReadonlyMap<string, CodeViewFileTreeFileStats>;
  gitStatus: readonly GitStatusEntry[];
  gitStatusPatch?: FileTreeGitStatusPatch;
  pathCount: number;
  paths: readonly string[];
  pathToItemId: ReadonlyMap<string, string>;
  previousSource?: CodeViewFileTreeSource;
}

export interface CodeViewDiffStats {
  addedLines: number;
  deletedLines: number;
  fileCount: number;
  totalLinesOfCode: number;
}
