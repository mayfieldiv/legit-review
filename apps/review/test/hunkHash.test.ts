import { describe, expect, test } from 'bun:test';

import {
  findHunkAnchorInPatch,
  hashFileBlock,
  hashPatchFiles,
  sha1Hex,
  splitPatchIntoFileBlocks,
} from '../lib/hunkHash';

const FILE_BLOCK = `diff --git a/src/app.ts b/src/app.ts
index 26b8d7a..8baf4d2 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
-const a = 1;
+const a = 100;
 const b = 2;
@@ -10,2 +10,3 @@ function later() {
 const c = 3;
+const d = 4;
`;

// Same hunk bodies, but line numbers shifted as if unrelated code above moved.
const FILE_BLOCK_SHIFTED = `diff --git a/src/app.ts b/src/app.ts
index 26b8d7a..9caf001 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -5,3 +8,3 @@
-const a = 1;
+const a = 100;
 const b = 2;
@@ -14,2 +17,3 @@ function later() {
 const c = 3;
+const d = 4;
`;

const FILE_BLOCK_EDITED = FILE_BLOCK.replace('const a = 100;', 'const a = 7;');

const BINARY_BLOCK = `diff --git a/img.png b/img.png
new file mode 100644
Binary files /dev/null and b/img.png differ
`;

const MULTI_FILE_PATCH = `${FILE_BLOCK}${BINARY_BLOCK}diff --git a/empty.txt b/empty.txt
new file mode 100644
`;

describe('sha1Hex', () => {
  test('matches the standard SHA-1 digest', async () => {
    expect(await sha1Hex('abc')).toBe(
      'a9993e364706816aba3e25717850c26c9cd0d89d'
    );
  });

  test('falls back when Web Crypto subtle is unavailable', async () => {
    const originalCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: { subtle: undefined } as unknown as Crypto,
      });
      expect(await sha1Hex('abc')).toBe(
        'a9993e364706816aba3e25717850c26c9cd0d89d'
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});

describe('splitPatchIntoFileBlocks', () => {
  test('splits on diff --git boundaries', () => {
    const blocks = splitPatchIntoFileBlocks(MULTI_FILE_PATCH);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toStartWith('diff --git a/src/app.ts');
    expect(blocks[1]).toStartWith('diff --git a/img.png');
    expect(blocks[2]).toStartWith('diff --git a/empty.txt');
  });

  test('returns nothing for empty or non-diff text', () => {
    expect(splitPatchIntoFileBlocks('')).toHaveLength(0);
    expect(splitPatchIntoFileBlocks('hello\nworld\n')).toHaveLength(0);
  });
});

describe('hashFileBlock', () => {
  test('hashes per hunk and is stable across line-number shifts', async () => {
    const original = await hashFileBlock(FILE_BLOCK);
    const shifted = await hashFileBlock(FILE_BLOCK_SHIFTED);

    expect(original.filePath).toBe('src/app.ts');
    expect(original.hunkHashes).toHaveLength(2);
    // Shifting @@ line numbers must not change any hash — this is what keeps
    // viewed marks valid when unrelated code moves.
    expect(shifted.hunkHashes).toEqual(original.hunkHashes);
    expect(shifted.fileHash).toBe(original.fileHash);
  });

  test('changes hashes when hunk content changes', async () => {
    const original = await hashFileBlock(FILE_BLOCK);
    const edited = await hashFileBlock(FILE_BLOCK_EDITED);

    expect(edited.hunkHashes[0]).not.toBe(original.hunkHashes[0]);
    // Untouched second hunk keeps its hash.
    expect(edited.hunkHashes[1]).toBe(original.hunkHashes[1]);
    expect(edited.fileHash).not.toBe(original.fileHash);
  });

  test('same content in different files hashes differently', async () => {
    const other = await hashFileBlock(
      FILE_BLOCK.replaceAll('src/app.ts', 'src/other.ts')
    );
    const original = await hashFileBlock(FILE_BLOCK);
    expect(other.hunkHashes[0]).not.toBe(original.hunkHashes[0]);
  });

  test('hashes hunk-less blocks from their header lines', async () => {
    const binary = await hashFileBlock(BINARY_BLOCK);
    expect(binary.filePath).toBe('img.png');
    expect(binary.hunkHashes).toHaveLength(0);
    expect(binary.fileHash).not.toBe('');

    // A different binary payload changes the index line and thus the hash.
    const changed = await hashFileBlock(
      BINARY_BLOCK.replace('new file mode 100644', 'index 11111..22222 100644')
    );
    expect(changed.fileHash).not.toBe(binary.fileHash);
  });

  test('extracts deletion paths from the --- header', async () => {
    const deletion = await hashFileBlock(
      `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`
    );
    expect(deletion.filePath).toBe('gone.txt');
  });
});

describe('hashPatchFiles', () => {
  test('hashes every file in a multi-file patch', async () => {
    const files = await hashPatchFiles(MULTI_FILE_PATCH);
    expect(files.map((file) => file.filePath)).toEqual([
      'src/app.ts',
      'img.png',
      'empty.txt',
    ]);
  });
});

describe('findHunkAnchorInPatch', () => {
  test('anchors added and removed lines to their hunk hash', async () => {
    const { hunkHashes } = await hashFileBlock(FILE_BLOCK);

    const added = await findHunkAnchorInPatch(
      MULTI_FILE_PATCH,
      'src/app.ts',
      'additions',
      1
    );
    expect(added).toEqual({
      hunkHash: hunkHashes[0],
      lineSnippet: 'const a = 100;',
    });

    const removed = await findHunkAnchorInPatch(
      MULTI_FILE_PATCH,
      'src/app.ts',
      'deletions',
      1
    );
    expect(removed).toEqual({
      hunkHash: hunkHashes[0],
      lineSnippet: 'const a = 1;',
    });
  });

  test('context lines anchor on both sides with per-side numbering', async () => {
    const { hunkHashes } = await hashFileBlock(FILE_BLOCK_SHIFTED);

    // In FILE_BLOCK_SHIFTED the first hunk starts at old 5 / new 8, so the
    // trailing context line `const b = 2;` is old 6 / new 9.
    const onNewSide = await findHunkAnchorInPatch(
      FILE_BLOCK_SHIFTED,
      'src/app.ts',
      'additions',
      9
    );
    const onOldSide = await findHunkAnchorInPatch(
      FILE_BLOCK_SHIFTED,
      'src/app.ts',
      'deletions',
      6
    );
    expect(onNewSide?.lineSnippet).toBe('const b = 2;');
    expect(onOldSide?.lineSnippet).toBe('const b = 2;');
    expect(onNewSide?.hunkHash).toBe(hunkHashes[0]);
  });

  test('finds lines in later hunks', async () => {
    const { hunkHashes } = await hashFileBlock(FILE_BLOCK);
    const anchor = await findHunkAnchorInPatch(
      FILE_BLOCK,
      'src/app.ts',
      'additions',
      11
    );
    expect(anchor).toEqual({
      hunkHash: hunkHashes[1],
      lineSnippet: 'const d = 4;',
    });
  });

  test('returns null for lines and files outside the patch', async () => {
    expect(
      await findHunkAnchorInPatch(
        MULTI_FILE_PATCH,
        'src/app.ts',
        'additions',
        999
      )
    ).toBeNull();
    // Line 11 only exists on the additions side of the second hunk.
    expect(
      await findHunkAnchorInPatch(
        MULTI_FILE_PATCH,
        'src/app.ts',
        'deletions',
        11
      )
    ).toBeNull();
    expect(
      await findHunkAnchorInPatch(MULTI_FILE_PATCH, 'nope.ts', 'additions', 1)
    ).toBeNull();
    // img.png is in the patch but has no hunks.
    expect(
      await findHunkAnchorInPatch(MULTI_FILE_PATCH, 'img.png', 'additions', 1)
    ).toBeNull();
  });
});
