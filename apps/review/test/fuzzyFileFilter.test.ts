import { describe, expect, test } from 'bun:test';

import { filterPaths, scorePath } from '../lib/fuzzyFileFilter';

describe('scorePath', () => {
  test('empty query is a trivial, zero-score match', () => {
    expect(scorePath('app/page.tsx', '')).toEqual({ score: 0, positions: [] });
  });

  test('returns null when the query is not a subsequence', () => {
    expect(scorePath('app/page.tsx', 'xyz')).toBeNull();
  });

  test('matches a contiguous basename prefix and reports its positions', () => {
    const result = scorePath('app/page.tsx', 'page');
    expect(result).not.toBeNull();
    expect(result?.positions).toEqual([4, 5, 6, 7]);
  });

  test('is case-insensitive but still matches', () => {
    const lower = scorePath('app/_components/ReviewUI.tsx', 'reviewui');
    expect(lower).not.toBeNull();
    // The 8 query chars bind to the "ReviewUI" run, which starts at index 16.
    expect(lower?.positions).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
  });

  test('a basename match outscores a scattered directory match', () => {
    const basename = scorePath('app/page.tsx', 'page');
    const scattered = scorePath(
      'app/_components/PreloadHighlighter.tsx',
      'page'
    );
    expect(basename).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(basename!.score).toBeGreaterThan(scattered!.score);
  });

  test('a consecutive run outscores the same chars spread apart', () => {
    // Both match the query in the basename starting at the same boundary, so
    // the only difference is whether the chars run together.
    const run = scorePath('x/abc.ts', 'abc');
    const spread = scorePath('x/axbxc.ts', 'abc');
    expect(run).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(run!.score).toBeGreaterThan(spread!.score);
  });

  test('rewards a camelCase boundary', () => {
    const result = scorePath('ReviewUI.tsx', 'ui');
    expect(result?.positions).toEqual([6, 7]);
  });
});

describe('filterPaths', () => {
  const PATHS = [
    'app/page.tsx',
    'app/review/page.tsx',
    'app/_components/ReviewUI.tsx',
    'app/_components/DiffFindBar.tsx',
    'lib/diffFind.ts',
    'lib/fuzzyFileFilter.ts',
    'lib/utils.ts',
  ];

  test('empty query keeps original order and respects the limit', () => {
    const result = filterPaths(PATHS, '', 3);
    expect(result.map((m) => m.path)).toEqual([
      'app/page.tsx',
      'app/review/page.tsx',
      'app/_components/ReviewUI.tsx',
    ]);
  });

  test('drops non-matching paths', () => {
    const result = filterPaths(PATHS, 'zzz', 10);
    expect(result).toEqual([]);
  });

  test('ranks the best basename match first', () => {
    const result = filterPaths(PATHS, 'difffind', 10);
    expect(result[0].path).toBe('lib/diffFind.ts');
  });

  test('"review" surfaces the review files', () => {
    const result = filterPaths(PATHS, 'review', 10);
    expect(result[0].path).toBe('app/_components/ReviewUI.tsx');
    expect(result.map((m) => m.path)).toContain('app/review/page.tsx');
  });

  test('caps the result count at the limit', () => {
    const result = filterPaths(PATHS, 't', 2);
    expect(result.length).toBe(2);
  });
});
