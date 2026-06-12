import {
  type ChangeTypes,
  type FileDiffMetadata,
  type Hunk,
  processFile,
} from '@pierre/diffs';

// A diff parsed from patch text alone is "partial": it only carries the lines
// printed in the patch, so the viewer cannot expand the unmodified context
// around hunks. Re-parsing the same patch text with both full file contents
// attached produces a non-partial diff where @pierre/diffs renders its
// built-in expand controls on hunk separators. This module decides which
// files qualify and performs that upgrade safely.

// Change types whose hunks can have unmodified context around them. New and
// deleted files are a single hunk covering the entire file, and pure renames
// have no hunks at all, so fetching their contents would buy nothing.
const EXPANDABLE_CHANGE_TYPES: ReadonlySet<ChangeTypes> = new Set([
  'change',
  'rename-changed',
]);
const DEFAULT_COMMENT_CONTEXT_LINES = 3;
const SPLIT_WITH_NEWLINES = /(?<=\n)/;

export function isFullContextCandidate(fileDiff: FileDiffMetadata): boolean {
  return (
    fileDiff.isPartial &&
    fileDiff.hunks.length > 0 &&
    EXPANDABLE_CHANGE_TYPES.has(fileDiff.type)
  );
}

export interface FullContextFileContents {
  path: string;
  oldContents: string | null;
  newContents: string | null;
}

// Response shape of POST /api/contents.
export interface FullContextResponse {
  mergeBase: string | null;
  files: FullContextFileContents[];
}

export interface BuildFullContextFileDiffInput {
  // The partial diff currently rendered for this file.
  partial: FileDiffMetadata;
  // The raw per-file patch text the partial diff was parsed from.
  fileText: string;
  // Must differ from the partial parse's cache key: worker tokenization
  // caches by key alone, and the full-context diff carries whole-file lines.
  cacheKey: string;
  oldContents: string;
  newContents: string;
}

export interface CommentContextRange {
  start: number;
  end: number;
}

export interface BuildCommentContextFileDiffInput {
  path: string;
  contents: string;
  cacheKey: string;
  ranges: readonly CommentContextRange[];
  contextLines?: number;
}

// Re-parses a file's patch text with full old/new contents attached, turning
// the partial diff into an expandable one. Returns null when the contents do
// not line up with the patch — the working tree (or merge base) changed
// between the diff fetch and the contents fetch — so the caller keeps the
// partial diff until the live-refresh reload delivers a consistent pair.
export function buildFullContextFileDiff({
  partial,
  fileText,
  cacheKey,
  oldContents,
  newContents,
}: BuildFullContextFileDiffInput): FileDiffMetadata | null {
  const full = processFile(fileText, {
    cacheKey,
    isGitDiff: true,
    oldFile: { name: partial.prevName ?? partial.name, contents: oldContents },
    newFile: { name: partial.name, contents: newContents },
  });
  if (full == null || full.isPartial) {
    return null;
  }
  return areHunkLinesAligned(partial, full) ? full : null;
}

// Builds a diff-shaped view for comments on files that have no actual diff.
// The hunks contain only unchanged context lines around the comment ranges;
// hidden file regions stay expandable through the normal diff controls.
export function buildCommentContextFileDiff({
  path,
  contents,
  cacheKey,
  ranges,
  contextLines = DEFAULT_COMMENT_CONTEXT_LINES,
}: BuildCommentContextFileDiffInput): FileDiffMetadata | null {
  const lines = splitFileContents(contents);
  if (lines.length === 0) {
    return null;
  }

  const windows = buildCommentContextWindows({
    contextLines,
    lineCount: lines.length,
    ranges,
  });
  if (windows.length === 0) {
    return null;
  }

  const hunks: Hunk[] = [];
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  let lastHunkEnd = 0;
  for (const window of windows) {
    const lineCount = window.end - window.start + 1;
    const collapsedBefore = Math.max(window.start - 1 - lastHunkEnd, 0);
    const lineIndex = window.start - 1;
    const hunk: Hunk = {
      collapsedBefore,
      additionStart: window.start,
      additionCount: lineCount,
      additionLines: 0,
      additionLineIndex: lineIndex,
      deletionStart: window.start,
      deletionCount: lineCount,
      deletionLines: 0,
      deletionLineIndex: lineIndex,
      hunkContent: [
        {
          type: 'context',
          lines: lineCount,
          additionLineIndex: lineIndex,
          deletionLineIndex: lineIndex,
        },
      ],
      hunkSpecs: `@@ -${window.start},${lineCount} +${window.start},${lineCount} @@`,
      splitLineStart: splitLineCount + collapsedBefore,
      splitLineCount: lineCount,
      unifiedLineStart: unifiedLineCount + collapsedBefore,
      unifiedLineCount: lineCount,
      noEOFCRDeletions: false,
      noEOFCRAdditions: false,
    };
    hunks.push(hunk);
    splitLineCount += collapsedBefore + lineCount;
    unifiedLineCount += collapsedBefore + lineCount;
    lastHunkEnd = window.end;
  }

  const trailingContext = Math.max(lines.length - lastHunkEnd, 0);
  splitLineCount += trailingContext;
  unifiedLineCount += trailingContext;

  return {
    name: path,
    type: 'change',
    hunks,
    splitLineCount,
    unifiedLineCount,
    isPartial: false,
    deletionLines: lines,
    additionLines: lines,
    cacheKey,
  };
}

// The full-contents parse trusts hunk headers to slice into the file lines;
// stale contents would silently render the wrong code in those slices. This
// verifies that every hunk's lines from the patch match the corresponding
// slices of the full files.
export function areHunkLinesAligned(
  partial: FileDiffMetadata,
  full: FileDiffMetadata
): boolean {
  if (partial.hunks.length !== full.hunks.length) {
    return false;
  }
  for (const [index, partialHunk] of partial.hunks.entries()) {
    const fullHunk = full.hunks[index];
    if (
      !areLineSlicesEqual(
        partial.additionLines,
        partialHunk.additionLineIndex,
        full.additionLines,
        fullHunk.additionLineIndex,
        partialHunk.additionCount
      ) ||
      !areLineSlicesEqual(
        partial.deletionLines,
        partialHunk.deletionLineIndex,
        full.deletionLines,
        fullHunk.deletionLineIndex,
        partialHunk.deletionCount
      )
    ) {
      return false;
    }
  }
  return true;
}

function areLineSlicesEqual(
  a: string[],
  aStart: number,
  b: string[],
  bStart: number,
  count: number
): boolean {
  for (let offset = 0; offset < count; offset++) {
    if (
      stripLineEnding(a[aStart + offset] ?? '') !==
      stripLineEnding(b[bStart + offset] ?? '')
    ) {
      return false;
    }
  }
  return true;
}

function buildCommentContextWindows({
  contextLines,
  lineCount,
  ranges,
}: {
  contextLines: number;
  lineCount: number;
  ranges: readonly CommentContextRange[];
}): CommentContextRange[] {
  const padding = Math.max(0, contextLines);
  const windows = ranges
    .flatMap((range) => {
      const start = toValidLineNumber(
        Math.min(range.start, range.end),
        lineCount
      );
      const end = toValidLineNumber(
        Math.max(range.start, range.end),
        lineCount
      );
      if (start == null || end == null) {
        return [];
      }
      return [
        {
          start: Math.max(start - padding, 1),
          end: Math.min(end + padding, lineCount),
        },
      ];
    })
    .sort((left, right) => {
      const startComparison = left.start - right.start;
      if (startComparison !== 0) {
        return startComparison;
      }
      return left.end - right.end;
    });

  const merged: CommentContextRange[] = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous == null || window.start > previous.end + 1) {
      merged.push({ ...window });
    } else if (window.end > previous.end) {
      previous.end = window.end;
    }
  }
  return merged;
}

function toValidLineNumber(
  lineNumber: number,
  lineCount: number
): number | null {
  if (
    !Number.isSafeInteger(lineNumber) ||
    lineNumber < 1 ||
    lineNumber > lineCount
  ) {
    return null;
  }
  return lineNumber;
}

function splitFileContents(contents: string): string[] {
  return contents !== '' ? contents.split(SPLIT_WITH_NEWLINES) : [];
}

// Parsed patch lines and split file contents both keep their trailing
// newlines except at EOF (and CRLF worktrees can pair with LF patch output),
// so lines are compared without their line endings.
function stripLineEnding(line: string): string {
  if (line.endsWith('\r\n')) {
    return line.slice(0, -2);
  }
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}
