import { describe, expect, test } from 'bun:test';

import {
  computeFileViewed,
  computeHunkViewedState,
} from '../app/_components/utils';

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

describe('computeHunkViewedState', () => {
  const FILE = 'src/app.ts';

  test('marks every hunk viewed when the file-level mark matches', () => {
    expect(
      computeHunkViewedState({ [FILE]: 'fh' }, {}, FILE, 'fh', 'h1')
    ).toEqual({
      hunkHash: 'h1',
      viewed: true,
    });
  });

  test('ignores stale file-level marks for edited hunks', () => {
    expect(
      computeHunkViewedState({ [FILE]: 'old' }, {}, FILE, 'fh', 'h1')
    ).toEqual({
      hunkHash: 'h1',
      viewed: false,
    });
  });

  test('uses per-hunk marks when no current file-level mark exists', () => {
    expect(
      computeHunkViewedState({}, { [FILE]: ['h1'] }, FILE, 'fh', 'h1')
    ).toEqual({
      hunkHash: 'h1',
      viewed: true,
    });
  });

  test('returns undefined when the hunk index has no hash', () => {
    expect(
      computeHunkViewedState({}, { [FILE]: ['h1'] }, FILE, 'fh', undefined)
    ).toBeUndefined();
  });
});
