import type {
  AnnotationSide,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs';
import type { FileTreeGitStatusPatch, GitStatusEntry } from '@pierre/trees';

export type ViewerLoadState =
  | 'fetching'
  | 'streaming'
  | 'parsing'
  | 'ready'
  | 'error';

// Resolved identity of the local diff being reviewed, parsed from the
// X-Review-* response headers of /api/diff.
export interface ReviewSourceInfo {
  repoPath: string;
  branch: string;
  baseRef: string;
}

export interface SavedCommentMetadata {
  kind: 'saved';
  // The store id doubles as the annotation key.
  key: string;
  author: string;
  message: string;
  range: SelectedLineRange;
  resolved: boolean;
  resolvedBy?: string;
  resolutionNote?: string;
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

// Synthetic annotation pinned to each hunk's last line: the "Viewed" toggle
// for that hunk. `hunkHash` is the hunk-body content hash the mark is stored
// under, so an edited hunk automatically loses its mark.
export interface HunkViewedMetadata {
  kind: 'hunk-viewed';
  key: string;
  hunkHash: string;
  viewed: boolean;
}

export type CommentMetadata =
  | SavedCommentMetadata
  | DraftCommentMetadata
  | HunkViewedMetadata;

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
export interface PersistCommentInput {
  fileDiff: FileDiffMetadata;
  itemId: string;
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
  resolved: boolean;
  resolvedBy?: string;
  resolutionNote?: string;
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
  resolved: boolean;
  side: AnnotationSide;
}

export interface CodeViewSavedCommentItem {
  comments: CodeViewSavedCommentEntry[];
  fileOrder: number;
  itemId: string;
  path: string;
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
