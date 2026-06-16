import { describe, expect, test } from 'bun:test';

import { selectCommentContextPathsToFetch } from '../app/_components/utils';

// Helper builds only the fields the selector reads.
function comment(filePath: string, resolved: boolean) {
  return { filePath, resolved };
}

const none = () => false;

describe('selectCommentContextPathsToFetch', () => {
  test('fetches files that have an open out-of-diff comment', () => {
    const paths = selectCommentContextPathsToFetch(
      [comment('src/a.ts', false)],
      none,
      none
    );
    expect([...paths]).toEqual(['src/a.ts']);
  });

  test('skips files whose only comment is resolved', () => {
    const paths = selectCommentContextPathsToFetch(
      [comment('src/a.ts', true)],
      none,
      none
    );
    expect(paths.size).toBe(0);
  });

  test('fetches a file with both a resolved and an open comment', () => {
    const paths = selectCommentContextPathsToFetch(
      [comment('src/a.ts', true), comment('src/a.ts', false)],
      none,
      none
    );
    expect([...paths]).toEqual(['src/a.ts']);
  });

  test('skips files already loaded as a diff item', () => {
    const paths = selectCommentContextPathsToFetch(
      [comment('src/a.ts', false)],
      (path) => path === 'src/a.ts',
      none
    );
    expect(paths.size).toBe(0);
  });

  test('skips files already fetched, including unreadable misses', () => {
    const paths = selectCommentContextPathsToFetch(
      [comment('src/a.ts', false)],
      none,
      (path) => path === 'src/a.ts'
    );
    expect(paths.size).toBe(0);
  });

  test('dedupes multiple open comments on the same file', () => {
    const paths = selectCommentContextPathsToFetch(
      [comment('src/a.ts', false), comment('src/a.ts', false)],
      none,
      none
    );
    expect([...paths]).toEqual(['src/a.ts']);
  });
});
