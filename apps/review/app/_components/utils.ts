import type {
  AnnotationSide,
  ChangeTypes,
  CodeViewDiffItem,
  CodeViewItem,
  FileDiffMetadata,
} from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import type { GitStatus } from '@pierre/trees';

import type {
  CodeViewCommentFileByItemId,
  CodeViewDeletedCommentEvent,
  CodeViewSavedCommentEntry,
  CodeViewSavedCommentEvent,
  CodeViewSavedCommentItem,
  CommentAnnotation,
  CommentLineType,
  CommentMetadata,
  DraftCommentMetadata,
  HunkViewedState,
  SavedCommentMetadata,
} from './types';

export function incrementItemVersion(item: CodeViewItem<CommentMetadata>) {
  item.version = typeof item.version === 'number' ? item.version + 1 : 1;
}

// Expands a collapsed item and pushes the change into the viewer, e.g. before
// scrolling to or revealing content inside it. No-op for items that are
// already expanded. Returns false only when the viewer rejected the update.
export function expandItemIfCollapsed(
  viewer: CodeViewHandle<CommentMetadata>,
  item: CodeViewItem<CommentMetadata>
): boolean {
  if (item.collapsed !== true) {
    return true;
  }
  item.collapsed = false;
  incrementItemVersion(item);
  return viewer.updateItem(item);
}

export function isDiffItem(
  item: CodeViewItem<CommentMetadata>
): item is CodeViewDiffItem<CommentMetadata> {
  return item.type === 'diff';
}

export function isDraftMetadata(
  metadata: CommentMetadata
): metadata is DraftCommentMetadata {
  return metadata.kind === 'draft';
}

export function isDraftAnnotation(
  annotation: CommentAnnotation
): annotation is CommentAnnotation<DraftCommentMetadata> {
  return isDraftMetadata(annotation.metadata);
}

export function isSavedAnnotation(
  annotation: CommentAnnotation
): annotation is CommentAnnotation<SavedCommentMetadata> {
  return annotation.metadata.kind === 'saved';
}

// Reads the 1-based line from raw file contents, ignoring the empty string a
// trailing newline produces. Returns undefined beyond EOF. Used to snippet
// and outdated-check comments on plain file items, which have no diff hunks
// to anchor against.
export function getFileContentsLine(
  contents: string,
  lineNumber: number
): string | undefined {
  const lines = contents.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lineNumber >= 1 && lineNumber <= lines.length
    ? lines[lineNumber - 1]
    : undefined;
}

// Reads a 1-based line from a full-context diff side. Partial patch diffs do
// not carry complete file contents, so callers only use this as an optional
// snippet source for comments that anchor outside real changed hunks.
export function getFullFileDiffLine(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number
): string | undefined {
  if (fileDiff.isPartial) {
    return undefined;
  }
  const lines =
    side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines;
  if (lineNumber < 1 || lineNumber > lines.length) {
    return undefined;
  }
  return stripLineEnding(lines[lineNumber - 1] ?? '');
}

// A file counts as viewed when its file-level mark matches the current file
// hash, or when every hunk in the current diff is individually marked viewed.
export function computeFileViewed(
  viewedFiles: Record<string, string>,
  viewedHunks: Record<string, string[]>,
  filePath: string,
  fileHash: string,
  hunkHashes: readonly string[]
): boolean {
  if (viewedFiles[filePath] === fileHash) {
    return true;
  }
  if (hunkHashes.length === 0) {
    return false;
  }
  const viewed = new Set(viewedHunks[filePath] ?? []);
  return hunkHashes.every((hash) => viewed.has(hash));
}

export function computeHunkViewedState(
  viewedFiles: Record<string, string>,
  viewedHunks: Record<string, string[]>,
  filePath: string,
  fileHash: string,
  hunkHash: string | undefined
): HunkViewedState | undefined {
  if (hunkHash == null) {
    return undefined;
  }
  return {
    hunkHash,
    viewed:
      viewedFiles[filePath] === fileHash ||
      (viewedHunks[filePath] ?? []).includes(hunkHash),
  };
}

// Finds the index of the hunk containing the given 1-based line on a diff
// side, or -1 when no hunk covers it. Used to attach the containing hunk's
// content hash to new comments so they can be flagged outdated later.
export function getHunkIndexForLine(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number
): number {
  for (const [index, hunk] of fileDiff.hunks.entries()) {
    const start =
      side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    const count =
      side === 'additions' ? hunk.additionCount : hunk.deletionCount;
    if (lineNumber >= start && lineNumber < start + count) {
      return index;
    }
  }
  return -1;
}

// Translates the diff-level change type surfaced by @pierre/diffs into the
// git-status vocabulary the file tree understands. Both rename variants fold
// into 'renamed' so the tree shows a consistent rename badge regardless of
// whether content also changed.
export function mapChangeTypeToGitStatus(type: ChangeTypes): GitStatus {
  switch (type) {
    case 'new':
      return 'added';
    case 'deleted':
      return 'deleted';
    case 'rename-pure':
    case 'rename-changed':
      return 'renamed';
    case 'change':
      return 'modified';
  }
}

function insertCommentInLineOrder(
  comments: readonly CodeViewSavedCommentEntry[],
  entry: CodeViewSavedCommentEntry
): CodeViewSavedCommentEntry[] {
  let existingIndex = -1;
  for (let index = 0; index < comments.length; index++) {
    if (comments[index]?.key === entry.key) {
      existingIndex = index;
      break;
    }
  }

  const nextComments =
    existingIndex === -1
      ? [...comments]
      : comments.filter((_, index) => index !== existingIndex);

  let insertIndex = nextComments.length;
  for (let index = 0; index < nextComments.length; index++) {
    const comment = nextComments[index];
    if (comment != null && entry.lineNumber < comment.lineNumber) {
      insertIndex = index;
      break;
    }
  }

  nextComments.splice(insertIndex, 0, entry);
  return nextComments;
}

function stripLineEnding(line: string): string {
  if (line.endsWith('\r\n')) {
    return line.slice(0, -2);
  }
  return line.endsWith('\n') || line.endsWith('\r') ? line.slice(0, -1) : line;
}

// Decides which commented files outside the current diff must have their
// working-tree contents fetched so the comment can render with surrounding
// code as a compact context-only item. Only open (unresolved) comments
// qualify: a file whose comments are all resolved stays sidebar-only and never
// gets pulled into the diff view just to host resolved threads. Files already
// loaded as an item, or already fetched (including unreadable paths cached as a
// miss), are skipped so the projection stays idempotent and never refetches.
export function selectCommentContextPathsToFetch(
  comments: readonly { filePath: string; resolved: boolean }[],
  isPathLoaded: (path: string) => boolean,
  isPathFetched: (path: string) => boolean
): Set<string> {
  const paths = new Set<string>();
  for (const comment of comments) {
    if (comment.resolved) {
      continue;
    }
    if (isPathLoaded(comment.filePath) || isPathFetched(comment.filePath)) {
      continue;
    }
    paths.add(comment.filePath);
  }
  return paths;
}

export function upsertSavedCommentSidebarEntry(
  sections: readonly CodeViewSavedCommentItem[],
  commentFileByItemId: CodeViewCommentFileByItemId | null,
  entry: CodeViewSavedCommentEvent
): CodeViewSavedCommentItem[] {
  const file = commentFileByItemId?.get(entry.itemId);
  if (file == null) {
    return [...sections];
  }

  const nextEntry: CodeViewSavedCommentEntry = {
    author: entry.author,
    itemId: entry.itemId,
    key: entry.key,
    lineNumber: entry.lineNumber,
    lineType: entry.lineType,
    message: entry.message,
    outdated: entry.outdated,
    range: entry.range,
    replyCount: entry.replyCount,
    resolved: entry.resolved,
    side: entry.side,
    // Saved-comment events come from an annotation in a mounted viewer item,
    // so the file is present by construction.
    stranded: false,
  };

  const nextSections = [...sections];
  let sectionIndex = -1;
  for (let index = 0; index < nextSections.length; index++) {
    if (nextSections[index]?.itemId === entry.itemId) {
      sectionIndex = index;
      break;
    }
  }

  if (sectionIndex === -1) {
    const nextSection: CodeViewSavedCommentItem = {
      comments: [nextEntry],
      fileOrder: file.fileOrder,
      itemId: entry.itemId,
      path: file.path,
    };

    let insertIndex = nextSections.length;
    for (let index = 0; index < nextSections.length; index++) {
      const section = nextSections[index];
      if (section != null && file.fileOrder < section.fileOrder) {
        insertIndex = index;
        break;
      }
    }

    nextSections.splice(insertIndex, 0, nextSection);
    return nextSections;
  }

  const section = nextSections[sectionIndex];
  if (section == null) {
    return sections.slice();
  }

  nextSections[sectionIndex] = {
    ...section,
    comments: insertCommentInLineOrder(section.comments, nextEntry),
  };
  return nextSections;
}

export function removeSavedCommentSidebarEntry(
  sections: readonly CodeViewSavedCommentItem[],
  entry: CodeViewDeletedCommentEvent
): CodeViewSavedCommentItem[] {
  let sectionIndex = -1;
  for (let index = 0; index < sections.length; index++) {
    if (sections[index]?.itemId === entry.itemId) {
      sectionIndex = index;
      break;
    }
  }

  if (sectionIndex === -1) {
    return sections.slice();
  }

  const section = sections[sectionIndex];
  if (section == null) {
    return sections.slice();
  }

  const nextComments = section.comments.filter(
    (comment) => comment.key !== entry.key
  );
  if (nextComments.length === section.comments.length) {
    return sections.slice();
  }

  if (nextComments.length === 0) {
    return sections.filter((_, index) => index !== sectionIndex);
  }

  const nextSections = [...sections];
  nextSections[sectionIndex] = {
    ...section,
    comments: nextComments,
  };
  return nextSections;
}

// Classifies a 1-based line number on a given diff side as either an actual
// addition/deletion or an unchanged context line. The sidebar uses this to
// avoid rendering "+13" / "-13" for comments anchored to lines that are
// rendered as context (and therefore weren't actually added or removed).
//
// Walks each hunk's ordered `hunkContent` while tracking the running line
// number on the requested side. A context block of N lines advances by N on
// both sides; a change block advances by `additions` on the addition side and
// `deletions` on the deletion side. Mirrors the walk pattern used by
// FileDiff.getLineIndex inside `@pierre/diffs`.
export function classifyCommentLineType(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number
): CommentLineType {
  for (const hunk of fileDiff.hunks) {
    let currentLineNumber =
      side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    const hunkCount =
      side === 'additions' ? hunk.additionCount : hunk.deletionCount;
    if (
      lineNumber < currentLineNumber ||
      lineNumber >= currentLineNumber + hunkCount
    ) {
      continue;
    }
    for (const content of hunk.hunkContent) {
      const blockLength =
        content.type === 'context'
          ? content.lines
          : side === 'additions'
            ? content.additions
            : content.deletions;
      if (blockLength === 0) {
        continue;
      }
      if (lineNumber < currentLineNumber + blockLength) {
        return content.type === 'context' ? 'context' : 'change';
      }
      currentLineNumber += blockLength;
    }
  }
  return 'change';
}
