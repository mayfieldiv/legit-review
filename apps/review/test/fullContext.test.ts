import { processFile } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import {
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
