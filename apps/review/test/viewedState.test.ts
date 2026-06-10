import { describe, expect, test } from 'bun:test';

import {
  computeFileViewed,
  getHunkViewedAnchor,
} from '../app/_components/utils';

describe('getHunkViewedAnchor', () => {
  test('anchors to the last addition line when additions exist', () => {
    expect(
      getHunkViewedAnchor({
        additionStart: 10,
        additionCount: 5,
        deletionStart: 9,
        deletionCount: 2,
      })
    ).toEqual({ side: 'additions', lineNumber: 14 });
  });

  test('falls back to the deletions side for pure deletions', () => {
    expect(
      getHunkViewedAnchor({
        additionStart: 0,
        additionCount: 0,
        deletionStart: 4,
        deletionCount: 3,
      })
    ).toEqual({ side: 'deletions', lineNumber: 6 });
  });

  test('returns undefined when the hunk has no lines on either side', () => {
    expect(
      getHunkViewedAnchor({
        additionStart: 0,
        additionCount: 0,
        deletionStart: 0,
        deletionCount: 0,
      })
    ).toBeUndefined();
  });
});

describe('computeFileViewed', () => {
  const FILE = 'src/app.ts';

  test('true when the file-level mark matches the current hash', () => {
    expect(
      computeFileViewed({ [FILE]: 'fh' }, {}, FILE, 'fh', ['h1', 'h2'])
    ).toBe(true);
  });

  test('false when the file-level mark is stale', () => {
    expect(
      computeFileViewed({ [FILE]: 'old' }, {}, FILE, 'fh', ['h1', 'h2'])
    ).toBe(false);
  });

  test('true when every current hunk is marked viewed', () => {
    expect(
      computeFileViewed({}, { [FILE]: ['h1', 'h2', 'stale'] }, FILE, 'fh', [
        'h1',
        'h2',
      ])
    ).toBe(true);
  });

  test('false when any hunk is unviewed (e.g. its content changed)', () => {
    expect(
      computeFileViewed({}, { [FILE]: ['h1'] }, FILE, 'fh', ['h1', 'h2-edited'])
    ).toBe(false);
  });

  test('hunk-less files rely on the file-level mark only', () => {
    expect(computeFileViewed({}, {}, FILE, 'fh', [])).toBe(false);
    expect(computeFileViewed({ [FILE]: 'fh' }, {}, FILE, 'fh', [])).toBe(true);
  });
});
