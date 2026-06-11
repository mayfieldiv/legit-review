import { afterAll, describe, expect, test } from 'bun:test';
import type { ElementContent } from 'hast';

import {
  DiffHunksRenderer,
  disposeHighlighter,
  parseDiffFromFile,
} from '../src';
import { mockDiffs } from './mocks';
import {
  assertDefined,
  collectAllElements,
  countSplitRows,
  getHastLineIndex,
  isHastElement,
  isHastLineElement,
} from './testUtils';

afterAll(async () => {
  await disposeHighlighter();
});

function countInlineDiffSpans(
  result: Awaited<ReturnType<DiffHunksRenderer['asyncRender']>>
) {
  const additions = result.additionsContentAST ?? [];
  const deletions = result.deletionsContentAST ?? [];
  return [
    ...collectAllElements(additions),
    ...collectAllElements(deletions),
  ].filter((element) => element.properties?.['data-diff-span'] != null).length;
}

function hasSlotNamed(element: ElementContent, name: string): boolean {
  if (!isHastElement(element)) {
    return false;
  }
  return collectAllElements([element]).some(
    (child) => child.tagName === 'slot' && child.properties?.name === name
  );
}

function findSlotIndex(nodes: ElementContent[], slotName: string): number {
  return nodes.findIndex((node) => hasSlotNamed(node, slotName));
}

function findLineIndex(nodes: ElementContent[], lineIndex: string): number {
  return nodes.findIndex(
    (node) => isHastLineElement(node) && getHastLineIndex(node) === lineIndex
  );
}

function createTwoHunkDiff() {
  const oldLines = Array.from({ length: 140 }, (_, index) => `${index + 1}`);
  const newLines = oldLines.map((line, index) => {
    if (index === 39) return 'changed-40';
    if (index === 99) return 'changed-100';
    return line;
  });

  return parseDiffFromFile(
    {
      name: 'two-hunks.ts',
      contents: `${oldLines.join('\n')}\n`,
    },
    {
      name: 'two-hunks.ts',
      contents: `${newLines.join('\n')}\n`,
    }
  );
}

describe('DiffHunksRenderer', () => {
  test('proper buffers should be prepended to additions colum in split style', async () => {
    const instance = new DiffHunksRenderer(mockDiffs.diffRowBufferTest.options);
    const diff = parseDiffFromFile(
      mockDiffs.diffRowBufferTest.oldFile,
      mockDiffs.diffRowBufferTest.newFile
    );
    expect(diff).toMatchSnapshot('parsed diff');
    const result = await instance.asyncRender(diff);
    assertDefined(
      result.additionsContentAST,
      'result.additionsContentAST should be defined'
    );
    assertDefined(
      result.deletionsContentAST,
      'result.deletionsContentAST should be defined'
    );
    expect(result.unifiedContentAST).toBeUndefined();
    expect(result).toMatchSnapshot('rendered result');
  });

  test('proper buffers should be prepended to deletions colum in split style', async () => {
    const instance = new DiffHunksRenderer(mockDiffs.diffRowBufferTest.options);
    const diff = parseDiffFromFile(
      mockDiffs.diffRowBufferTest.newFile,
      mockDiffs.diffRowBufferTest.oldFile
    );
    expect(diff).toMatchSnapshot('parsed diff');
    const result = await instance.asyncRender(diff);
    assertDefined(
      result.additionsContentAST,
      'result.additionsContentAST should be defined'
    );
    assertDefined(
      result.deletionsContentAST,
      'result.deletionsContentAST should be defined'
    );
    expect(result.unifiedContentAST).toBeUndefined();
    expect(result).toMatchSnapshot('rendered result');
  });

  test('additions and deletions should be empty when unified', async () => {
    const instance = new DiffHunksRenderer({
      ...mockDiffs.diffRowBufferTest.options,
      diffStyle: 'unified',
    });
    const diff = parseDiffFromFile(
      mockDiffs.diffRowBufferTest.oldFile,
      mockDiffs.diffRowBufferTest.newFile
    );
    expect(diff).toMatchSnapshot('parsed diff');
    const result = await instance.asyncRender(diff);
    expect(result.additionsContentAST).toBeUndefined();
    expect(result.deletionsContentAST).toBeUndefined();
    assertDefined(
      result.unifiedContentAST,
      'result.unifiedContentAST should be defined'
    );
    expect(result).toMatchSnapshot('rendered result');
  });

  test('a diff with only additions should have an empty deletions column', async () => {
    const instance = new DiffHunksRenderer(mockDiffs.diffRowBufferTest.options);
    const diff = parseDiffFromFile(
      { ...mockDiffs.diffRowBufferTest.oldFile, contents: '' },
      mockDiffs.diffRowBufferTest.newFile
    );
    expect(diff.hunks[0]?.collapsedBefore).toBe(0);
    expect(diff).toMatchSnapshot('parsed diff');
    const result = await instance.asyncRender(diff);
    expect(result.preNode.properties?.['data-diff-type']).toBe('single');
    assertDefined(
      result.additionsContentAST,
      'result.additionsContentAST should be defined'
    );
    expect(countSplitRows(result)).toBe(diff.splitLineCount);
    expect(result.deletionsContentAST).toBeUndefined();
    expect(result.unifiedContentAST).toBeUndefined();
    expect(result).toMatchSnapshot('rendered result');
  });

  test('a diff with only deletions should have an empty additions column', async () => {
    const instance = new DiffHunksRenderer(mockDiffs.diffRowBufferTest.options);
    const diff = parseDiffFromFile(mockDiffs.diffRowBufferTest.oldFile, {
      ...mockDiffs.diffRowBufferTest.newFile,
      contents: '',
    });
    expect(diff.hunks[0]?.collapsedBefore).toBe(0);
    expect(diff).toMatchSnapshot('parsed diff');
    const result = await instance.asyncRender(diff);
    expect(result.preNode.properties?.['data-diff-type']).toBe('single');
    assertDefined(
      result.deletionsContentAST,
      'result.deletionsContentAST should be defined'
    );
    expect(countSplitRows(result)).toBe(diff.splitLineCount);
    expect(result.additionsContentAST).toBeUndefined();
    expect(result.unifiedContentAST).toBeUndefined();
    expect(result).toMatchSnapshot('rendered result');
  });

  test('adds data-container-size for line-info separators', async () => {
    const instance = new DiffHunksRenderer({ hunkSeparators: 'line-info' });
    const diff = parseDiffFromFile(
      mockDiffs.diffRowBufferTest.oldFile,
      mockDiffs.diffRowBufferTest.newFile
    );
    const result = await instance.asyncRender(diff);
    const html = instance.renderFullHTML(result);
    expect(html).toContain('data-container-size');
  });

  test('does not add data-container-size for non line-info separators', async () => {
    const instance = new DiffHunksRenderer({
      hunkSeparators: 'line-info-basic',
    });
    const diff = parseDiffFromFile(
      mockDiffs.diffRowBufferTest.oldFile,
      mockDiffs.diffRowBufferTest.newFile
    );
    const result = await instance.asyncRender(diff);
    const html = instance.renderFullHTML(result);
    expect(html).not.toContain('data-container-size');
  });

  test('renders hunk separator slots above a hunk at the start of a file', async () => {
    const instance = new DiffHunksRenderer({
      diffStyle: 'unified',
      hunkSeparators: 'line-info-basic',
      hunkSeparatorSlots: true,
    });
    const diff = parseDiffFromFile(
      {
        name: 'example.ts',
        contents: 'const value = 1;\n',
      },
      {
        name: 'example.ts',
        contents: 'const value = 2;\n',
      }
    );

    expect(diff.hunks[0]?.collapsedBefore).toBe(0);

    const result = await instance.asyncRender(diff);
    assertDefined(
      result.unifiedContentAST,
      'result.unifiedContentAST should be defined'
    );

    const slotName = 'hunk-separator-unified-0';
    const separatorIndex = findSlotIndex(result.unifiedContentAST, slotName);
    const firstLineIndex =
      result.unifiedContentAST.findIndex(isHastLineElement);

    expect(separatorIndex).toBeGreaterThanOrEqual(0);
    expect(firstLineIndex).toBeGreaterThanOrEqual(0);
    expect(separatorIndex).toBeLessThan(firstLineIndex);
    expect(result.hunkData).toContainEqual(
      expect.objectContaining({
        slotName,
        hunkSlot: true,
        hunkIndex: 0,
        lines: 0,
        type: 'unified',
      })
    );
  });

  test('renders split hunk separator slots above both sides at the start of a file', async () => {
    const instance = new DiffHunksRenderer({
      diffStyle: 'split',
      hunkSeparators: 'line-info-basic',
      hunkSeparatorSlots: true,
    });
    const diff = parseDiffFromFile(
      {
        name: 'example.ts',
        contents: 'const value = 1;\n',
      },
      {
        name: 'example.ts',
        contents: 'const value = 2;\n',
      }
    );

    expect(diff.hunks[0]?.collapsedBefore).toBe(0);

    const result = await instance.asyncRender(diff);
    assertDefined(
      result.deletionsContentAST,
      'result.deletionsContentAST should be defined'
    );
    assertDefined(
      result.additionsContentAST,
      'result.additionsContentAST should be defined'
    );

    const deletionsSlotName = 'hunk-separator-deletions-0';
    const additionsSlotName = 'hunk-separator-additions-0';
    const deletionsSeparatorIndex = findSlotIndex(
      result.deletionsContentAST,
      deletionsSlotName
    );
    const additionsSeparatorIndex = findSlotIndex(
      result.additionsContentAST,
      additionsSlotName
    );
    const firstDeletionLineIndex =
      result.deletionsContentAST.findIndex(isHastLineElement);
    const firstAdditionLineIndex =
      result.additionsContentAST.findIndex(isHastLineElement);

    expect(deletionsSeparatorIndex).toBeGreaterThanOrEqual(0);
    expect(additionsSeparatorIndex).toBeGreaterThanOrEqual(0);
    expect(deletionsSeparatorIndex).toBeLessThan(firstDeletionLineIndex);
    expect(additionsSeparatorIndex).toBeLessThan(firstAdditionLineIndex);
    expect(result.hunkData).toContainEqual(
      expect.objectContaining({
        slotName: deletionsSlotName,
        hunkSlot: true,
        hunkIndex: 0,
        lines: 0,
        type: 'deletions',
      })
    );
    expect(result.hunkData).toContainEqual(
      expect.objectContaining({
        slotName: additionsSlotName,
        hunkSlot: true,
        hunkIndex: 0,
        lines: 0,
        type: 'additions',
      })
    );
  });

  test('keeps a hunk separator slot when expansion removes the gap before a later hunk', async () => {
    const instance = new DiffHunksRenderer({
      diffStyle: 'unified',
      hunkSeparators: 'line-info-basic',
      hunkSeparatorSlots: true,
    });
    const diff = createTwoHunkDiff();
    const secondHunk = diff.hunks[1];

    assertDefined(secondHunk, 'expected a second hunk');
    expect(secondHunk.collapsedBefore).toBeGreaterThan(0);

    instance.expandHunk(1, 'both', Number.POSITIVE_INFINITY);

    const result = await instance.asyncRender(diff);
    assertDefined(
      result.unifiedContentAST,
      'result.unifiedContentAST should be defined'
    );

    const slotName = 'hunk-separator-unified-1';
    const separatorIndex = findSlotIndex(result.unifiedContentAST, slotName);
    const hunkBodyIndex = findLineIndex(
      result.unifiedContentAST,
      `${secondHunk.unifiedLineStart},${secondHunk.splitLineStart}`
    );

    expect(separatorIndex).toBeGreaterThanOrEqual(0);
    expect(hunkBodyIndex).toBeGreaterThanOrEqual(0);
    expect(separatorIndex).toBeLessThan(hunkBodyIndex);
    expect(result.hunkData).toContainEqual(
      expect.objectContaining({
        slotName,
        hunkSlot: true,
        hunkIndex: 1,
        lines: 0,
        type: 'unified',
      })
    );
  });

  test('skips inline diff decorations for changed lines above maxLineDiffLength', async () => {
    const instance = new DiffHunksRenderer({
      diffStyle: 'split',
      maxLineDiffLength: 5,
    });
    const diff = parseDiffFromFile(
      {
        name: 'example.ts',
        contents: 'const value = "aaaaaaaaaaaa";\n',
      },
      {
        name: 'example.ts',
        contents: 'const value = "bbbbbbbbbbbb";\n',
      }
    );
    const result = await instance.asyncRender(diff);

    expect(countInlineDiffSpans(result)).toBe(0);
    expect(result).toMatchSnapshot('rendered result without inline diff spans');
  });

  test('keeps inline diff decorations for changed lines below maxLineDiffLength', async () => {
    const instance = new DiffHunksRenderer({
      diffStyle: 'split',
      maxLineDiffLength: 50,
    });
    const diff = parseDiffFromFile(
      {
        name: 'example.ts',
        contents: 'const x = 1;\n',
      },
      {
        name: 'example.ts',
        contents: 'const x = 2;\n',
      }
    );
    const result = await instance.asyncRender(diff);

    expect(countInlineDiffSpans(result)).toBeGreaterThan(0);
    expect(result).toMatchSnapshot('rendered result with inline diff spans');
  });
});
