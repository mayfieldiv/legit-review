import { describe, expect, test } from 'bun:test';

import { parseDiffFromFile } from '../src';
import type {
  AnnotationSide,
  FileDiffMetadata,
  HunkExpansionRegion,
} from '../src/types';
import {
  getHunkExpansionsToRevealLines,
  type RevealLinesRange,
} from '../src/utils/revealDiffLines';

function buildLines(count: number, changed: Record<number, string> = {}) {
  const lines: string[] = [];
  for (let lineNumber = 1; lineNumber <= count; lineNumber++) {
    lines.push(changed[lineNumber] ?? `line ${lineNumber}`);
  }
  return lines.join('\n');
}

// 100-line file with single-line changes at lines 10 and 60. With 3 context
// lines this parses into two hunks covering lines 7-13 and 57-63, a 6-line
// collapsed region before hunk 0, a 43-line region between the hunks
// (14-56), and a 37-line trailing region (64-100).
const diff = parseDiffFromFile(
  { name: 'test.txt', contents: buildLines(100) },
  {
    name: 'test.txt',
    contents: buildLines(100, { 10: 'changed 10', 60: 'changed 60' }),
  },
  { context: 3 }
);

interface RevealProps {
  range: RevealLinesRange;
  side?: AnnotationSide;
  padding?: number;
  expandedHunks?: Map<number, HunkExpansionRegion> | true;
  collapsedContextThreshold?: number;
  fileDiff?: FileDiffMetadata;
}

function reveal({
  range,
  side = 'additions',
  padding = 0,
  expandedHunks,
  collapsedContextThreshold = 0,
  fileDiff = diff,
}: RevealProps) {
  return getHunkExpansionsToRevealLines({
    fileDiff,
    side,
    range,
    padding,
    expandedHunks,
    collapsedContextThreshold,
    errorPrefix: 'test',
  });
}

describe('getHunkExpansionsToRevealLines', () => {
  test('parses the fixture into the expected shape', () => {
    expect(diff.isPartial).toBe(false);
    expect(diff.hunks.length).toBe(2);
    expect(diff.hunks[0].additionStart).toBe(7);
    expect(diff.hunks[1].additionStart).toBe(57);
    expect(diff.hunks[1].collapsedBefore).toBe(43);
  });

  test('lines inside a hunk need no expansion', () => {
    expect(reveal({ range: { start: 10, end: 10 } })).toEqual([]);
    expect(reveal({ range: { start: 7, end: 13 } })).toEqual([]);
  });

  test('expands from the top of a region for lines near the previous hunk', () => {
    // Region between hunks covers 14-56; line 20 is 7 lines from its top and
    // 37 from its bottom, so the top slice grows: fromStart = 20 - 14 + 1.
    expect(reveal({ range: { start: 20, end: 20 } })).toEqual([
      { hunkIndex: 1, direction: 'up', lineCount: 7 },
    ]);
  });

  test('expands from the bottom of a region for lines near the next hunk', () => {
    // Line 50 is 7 lines from the region bottom (56): fromEnd = 56 - 50 + 1.
    expect(reveal({ range: { start: 50, end: 50 } })).toEqual([
      { hunkIndex: 1, direction: 'down', lineCount: 7 },
    ]);
  });

  test('padding widens the revealed slice', () => {
    expect(reveal({ range: { start: 20, end: 20 }, padding: 3 })).toEqual([
      { hunkIndex: 1, direction: 'up', lineCount: 10 },
    ]);
  });

  test('padding alone never triggers an expansion', () => {
    // Line 13 is a hunk line; padding would poke into the region above and
    // below, but the range itself is fully visible.
    expect(reveal({ range: { start: 13, end: 13 }, padding: 3 })).toEqual([]);
  });

  test('reveals lines before the first hunk', () => {
    expect(reveal({ range: { start: 2, end: 3 } })).toEqual([
      { hunkIndex: 0, direction: 'up', lineCount: 3 },
    ]);
  });

  test('reveals lines in the trailing region after the last hunk', () => {
    // Trailing region covers 64-100 and only supports top-anchored expansion:
    // fromStart = 90 - 64 + 1.
    expect(reveal({ range: { start: 90, end: 90 } })).toEqual([
      { hunkIndex: 2, direction: 'up', lineCount: 27 },
    ]);
  });

  test('accounts for existing expansion state', () => {
    const expandedHunks = new Map<number, HunkExpansionRegion>([
      [1, { fromStart: 5, fromEnd: 0 }],
    ]);
    expect(reveal({ range: { start: 20, end: 20 }, expandedHunks })).toEqual([
      { hunkIndex: 1, direction: 'up', lineCount: 2 },
    ]);
    expandedHunks.set(1, { fromStart: 7, fromEnd: 0 });
    expect(reveal({ range: { start: 20, end: 20 }, expandedHunks })).toEqual(
      []
    );
  });

  test('applying the returned steps converges', () => {
    const expandedHunks = new Map<number, HunkExpansionRegion>();
    const steps = reveal({ range: { start: 30, end: 34 }, padding: 3 });
    expect(steps).not.toBeUndefined();
    expect(steps!.length).toBe(1);
    for (const step of steps!) {
      const region = expandedHunks.get(step.hunkIndex) ?? {
        fromStart: 0,
        fromEnd: 0,
      };
      if (step.direction === 'up') {
        region.fromStart += step.lineCount;
      } else {
        region.fromEnd += step.lineCount;
      }
      expandedHunks.set(step.hunkIndex, region);
    }
    expect(
      reveal({ range: { start: 30, end: 34 }, padding: 3, expandedHunks })
    ).toEqual([]);
  });

  test('a range spanning two regions expands both', () => {
    // 50-64 crosses the region below hunk 0's neighbor (up to 56), all of
    // hunk 1 (57-63), and the first trailing line (64).
    expect(reveal({ range: { start: 50, end: 64 } })).toEqual([
      { hunkIndex: 1, direction: 'down', lineCount: 7 },
      { hunkIndex: 2, direction: 'up', lineCount: 1 },
    ]);
  });

  test('regions at or below the collapsed-context threshold are already rendered', () => {
    expect(
      reveal({ range: { start: 2, end: 3 }, collapsedContextThreshold: 6 })
    ).toEqual([]);
  });

  test('expandUnchanged (expandedHunks: true) renders everything', () => {
    expect(
      reveal({ range: { start: 30, end: 30 }, expandedHunks: true })
    ).toEqual([]);
  });

  test('uses side-specific line numbering', () => {
    // Insert two lines after line 60 so addition numbering runs ahead of
    // deletion numbering in the trailing region.
    const insertionDiff = parseDiffFromFile(
      { name: 'test.txt', contents: buildLines(100) },
      {
        name: 'test.txt',
        contents: `${buildLines(60)}\nnew a\nnew b\n${buildLines(100)
          .split('\n')
          .slice(60)
          .join('\n')}`,
      },
      { context: 3 }
    );
    const deletionSteps = reveal({
      fileDiff: insertionDiff,
      side: 'deletions',
      range: { start: 80, end: 80 },
    });
    const additionSteps = reveal({
      fileDiff: insertionDiff,
      side: 'additions',
      range: { start: 82, end: 82 },
    });
    // Deletion line 80 and addition line 82 are the same physical row, so
    // both need the same expansion.
    expect(deletionSteps).toEqual(additionSteps);
    expect(deletionSteps!.length).toBe(1);
  });

  test('returns undefined for unreachable ranges', () => {
    expect(reveal({ range: { start: 0, end: 3 } })).toBeUndefined();
    expect(reveal({ range: { start: 99, end: 101 } })).toBeUndefined();
    const partial = { ...diff, isPartial: true };
    expect(
      reveal({ fileDiff: partial, range: { start: 30, end: 30 } })
    ).toBeUndefined();
  });
});
