import { processFile } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import {
  buildCommentContextFileDiff,
  buildFullContextFileDiff,
  isFullContextCandidate,
} from '../app/_components/fullContext';

function makeLines(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

const OLD_LINES = makeLines(30);
const NEW_LINES = makeLines(30).map((line) =>
  line === 'line 15' ? 'line fifteen' : line
);
const OLD_CONTENTS = `${OLD_LINES.join('\n')}\n`;
const NEW_CONTENTS = `${NEW_LINES.join('\n')}\n`;

const PATCH_TEXT = `diff --git a/sample.txt b/sample.txt
index 1111111..2222222 100644
--- a/sample.txt
+++ b/sample.txt
@@ -12,7 +12,7 @@
 line 12
 line 13
 line 14
-line 15
+line fifteen
 line 16
 line 17
 line 18
`;

function parsePartial() {
  const partial = processFile(PATCH_TEXT, { isGitDiff: true });
  if (partial == null) {
    throw new Error('failed to parse test patch');
  }
  return partial;
}

describe('isFullContextCandidate', () => {
  test('accepts a partial changed file and rejects an upgraded one', () => {
    const partial = parsePartial();
    expect(isFullContextCandidate(partial)).toBe(true);

    const full = buildFullContextFileDiff({
      partial,
      fileText: PATCH_TEXT,
      cacheKey: 'test-full',
      oldContents: OLD_CONTENTS,
      newContents: NEW_CONTENTS,
    });
    expect(full).not.toBeNull();
    expect(isFullContextCandidate(full!)).toBe(false);
  });

  test('rejects new-file diffs (nothing to expand)', () => {
    const newFilePatch = `diff --git a/fresh.txt b/fresh.txt
new file mode 100644
--- /dev/null
+++ b/fresh.txt
@@ -0,0 +1,2 @@
+hello
+world
`;
    const fileDiff = processFile(newFilePatch, { isGitDiff: true });
    expect(fileDiff).not.toBeNull();
    expect(isFullContextCandidate(fileDiff!)).toBe(false);
  });
});

describe('buildFullContextFileDiff', () => {
  test('produces an expandable diff carrying the complete file lines', () => {
    const full = buildFullContextFileDiff({
      partial: parsePartial(),
      fileText: PATCH_TEXT,
      cacheKey: 'test-full',
      oldContents: OLD_CONTENTS,
      newContents: NEW_CONTENTS,
    });
    expect(full).not.toBeNull();
    expect(full!.isPartial).toBe(false);
    expect(full!.additionLines).toHaveLength(30);
    expect(full!.deletionLines).toHaveLength(30);
    expect(full!.cacheKey).toBe('test-full');
  });

  test('rejects contents that drifted from the patch', () => {
    // An extra line at the top shifts every hunk slice off by one — exactly
    // what a mid-review edit produces between the diff and contents fetches.
    const drifted = `inserted\n${NEW_CONTENTS}`;
    const full = buildFullContextFileDiff({
      partial: parsePartial(),
      fileText: PATCH_TEXT,
      cacheKey: 'test-full',
      oldContents: OLD_CONTENTS,
      newContents: drifted,
    });
    expect(full).toBeNull();
  });

  test('tolerates line-ending differences between patch and contents', () => {
    const crlfNewContents = NEW_LINES.join('\r\n') + '\r\n';
    const full = buildFullContextFileDiff({
      partial: parsePartial(),
      fileText: PATCH_TEXT,
      cacheKey: 'test-full',
      oldContents: OLD_CONTENTS,
      newContents: crlfNewContents,
    });
    expect(full).not.toBeNull();
  });
});

describe('buildCommentContextFileDiff', () => {
  test('renders only the comment line and surrounding context by default', () => {
    const fileDiff = buildCommentContextFileDiff({
      path: 'calm.txt',
      contents: `${makeLines(20).join('\n')}\n`,
      cacheKey: 'calm-context',
      ranges: [{ start: 10, end: 10 }],
    });

    expect(fileDiff).not.toBeNull();
    expect(fileDiff!.isPartial).toBe(false);
    expect(fileDiff!.additionLines).toHaveLength(20);
    expect(fileDiff!.hunks).toHaveLength(1);
    expect(fileDiff!.hunks[0]).toMatchObject({
      collapsedBefore: 6,
      additionStart: 7,
      additionCount: 7,
      deletionStart: 7,
      deletionCount: 7,
      splitLineStart: 6,
      unifiedLineStart: 6,
    });

    expect(getVisibleContextLineNumbers(fileDiff!)).toEqual([
      7, 8, 9, 10, 11, 12, 13,
    ]);
    expect(getTrailingContextLineCount(fileDiff!)).toBe(7);
  });

  test('keeps leading and trailing hidden lines expandable by renderer contract', () => {
    const fileDiff = buildCommentContextFileDiff({
      path: 'calm.txt',
      contents: `${makeLines(20).join('\n')}\n`,
      cacheKey: 'calm-context',
      ranges: [{ start: 10, end: 10 }],
    });
    expect(fileDiff).not.toBeNull();

    const hunk = fileDiff!.hunks[0];
    expect(fileDiff!.isPartial).toBe(false);
    expect(hunk?.collapsedBefore).toBe(6);
    expect(getTrailingContextLineCount(fileDiff!)).toBe(7);
    expect(fileDiff!.additionLines[4]?.trim()).toBe('line 5');
    expect(fileDiff!.additionLines[15]?.trim()).toBe('line 16');
  });

  test('merges overlapping comment context windows', () => {
    const fileDiff = buildCommentContextFileDiff({
      path: 'calm.txt',
      contents: `${makeLines(30).join('\n')}\n`,
      cacheKey: 'calm-context',
      ranges: [
        { start: 10, end: 10 },
        { start: 13, end: 13 },
      ],
    });

    expect(fileDiff).not.toBeNull();
    expect(fileDiff!.hunks).toHaveLength(1);
    expect(fileDiff!.hunks[0]).toMatchObject({
      additionStart: 7,
      additionCount: 10,
    });
    expect(getVisibleContextLineNumbers(fileDiff!)).toEqual([
      7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });

  test('returns null when no comment range points at an existing line', () => {
    expect(
      buildCommentContextFileDiff({
        path: 'calm.txt',
        contents: `${makeLines(5).join('\n')}\n`,
        cacheKey: 'calm-context',
        ranges: [{ start: 10, end: 10 }],
      })
    ).toBeNull();
  });
});

function getVisibleContextLineNumbers(
  fileDiff: NonNullable<ReturnType<typeof buildCommentContextFileDiff>>
): number[] {
  return fileDiff.hunks.flatMap((hunk) =>
    Array.from(
      { length: hunk.additionCount },
      (_, index) => hunk.additionStart + index
    )
  );
}

function getTrailingContextLineCount(
  fileDiff: NonNullable<ReturnType<typeof buildCommentContextFileDiff>>
): number {
  const lastHunk = fileDiff.hunks.at(-1);
  if (lastHunk == null) {
    return 0;
  }
  return Math.max(
    fileDiff.additionLines.length -
      (lastHunk.additionLineIndex + lastHunk.additionCount),
    0
  );
}
