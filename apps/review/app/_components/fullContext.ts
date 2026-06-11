import {
  type ChangeTypes,
  type FileDiffMetadata,
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

// Parsed patch lines and split file contents both keep their trailing
// newlines except at EOF (and CRLF worktrees can pair with LF patch output),
// so lines are compared without their line endings.
function stripLineEnding(line: string): string {
  if (line.endsWith('\r\n')) {
    return line.slice(0, -2);
  }
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}
