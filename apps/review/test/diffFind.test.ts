import { describe, expect, test } from 'bun:test';

import { buildCodeViewData } from '../app/_components/codeViewDataAccumulator';
import {
  findClosestMatchIndex,
  type FindMatch,
  findMatches,
  matchLine,
} from '../lib/diffFind';

const DEFAULT = { caseSensitive: false, wholeWord: false };

describe('matchLine', () => {
  test('finds all non-overlapping occurrences', () => {
    expect(matchLine('foo bar foo', 'foo', DEFAULT)).toEqual([
      { columnStart: 0, length: 3 },
      { columnStart: 8, length: 3 },
    ]);
  });

  test('is case-insensitive by default', () => {
    expect(matchLine('Foo FOO', 'foo', DEFAULT)).toEqual([
      { columnStart: 0, length: 3 },
      { columnStart: 4, length: 3 },
    ]);
  });

  test('case-sensitive toggle respects case', () => {
    expect(
      matchLine('Foo foo', 'foo', { caseSensitive: true, wholeWord: false })
    ).toEqual([{ columnStart: 4, length: 3 }]);
  });

  test('whole-word excludes matches inside larger identifiers', () => {
    const opts = { caseSensitive: false, wholeWord: true };
    // `parse` is part of `parseFile` (rejected) but a standalone token in
    // `parse(` (accepted).
    expect(matchLine('parseFile parse(x)', 'parse', opts)).toEqual([
      { columnStart: 10, length: 5 },
    ]);
    // Underscores are word chars, so `my_parse` is not a whole-word match.
    expect(matchLine('my_parse', 'parse', opts)).toEqual([]);
  });

  test('empty query yields nothing', () => {
    expect(matchLine('anything', '', DEFAULT)).toEqual([]);
  });
});

const SINGLE_FILE_PATCH = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 const stay = true;
-const oldValue = 1;
+const newValue = 2;
+const extra = 3;
 export const done = true;
`;

describe('findMatches diff enumeration', () => {
  const items = buildCodeViewData(SINGLE_FILE_PATCH, 'single').items;

  test('addition lands on the additions side with the new line number', () => {
    const matches = findMatches(items, 'newValue', DEFAULT);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      side: 'additions',
      lineNumber: 2,
      columnStart: 6,
      length: 8,
    });
  });

  test('deletion lands on the deletions side with the old line number', () => {
    const matches = findMatches(items, 'oldValue', DEFAULT);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ side: 'deletions', lineNumber: 2 });
  });

  test('second added line keeps its own new line number', () => {
    const matches = findMatches(items, 'extra', DEFAULT);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ side: 'additions', lineNumber: 3 });
  });

  test('trailing context line is addressed on the additions side', () => {
    const matches = findMatches(items, 'done', DEFAULT);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ side: 'additions', lineNumber: 4 });
  });

  test('document order: context, then deletions before additions', () => {
    const matches = findMatches(items, 'const', DEFAULT);
    // const appears on: context l1, deletion l2, addition l2, addition l3,
    // trailing context l4.
    expect(
      matches.map((m) => ({ side: m.side, lineNumber: m.lineNumber }))
    ).toEqual([
      { side: 'additions', lineNumber: 1 },
      { side: 'deletions', lineNumber: 2 },
      { side: 'additions', lineNumber: 2 },
      { side: 'additions', lineNumber: 3 },
      { side: 'additions', lineNumber: 4 },
    ]);
  });
});

describe('findClosestMatchIndex', () => {
  // Synthetic matches across three items (a, b, c) at known line numbers, in
  // document order. Only itemId + lineNumber matter to the ranking.
  const match = (itemId: string, lineNumber: number): FindMatch => ({
    itemId,
    lineNumber,
    columnStart: 0,
    length: 1,
  });
  const ORDER = new Map([
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ]);
  const orderIndex = (id: string) => ORDER.get(id) ?? -1;

  test('returns 0 when there is no anchor', () => {
    const matches = [match('b', 10), match('a', 5)];
    expect(findClosestMatchIndex(matches, null, orderIndex)).toBe(0);
  });

  test('returns 0 when the anchor item has dropped out', () => {
    const matches = [match('a', 5), match('b', 10)];
    const anchor = { itemId: 'gone', lineNumber: 5 };
    expect(findClosestMatchIndex(matches, anchor, orderIndex)).toBe(0);
  });

  test('picks the nearest line within the same item', () => {
    const matches = [match('a', 5), match('a', 40), match('a', 80)];
    const anchor = { itemId: 'a', lineNumber: 45 };
    expect(findClosestMatchIndex(matches, anchor, orderIndex)).toBe(1);
  });

  test('prefers the same item over an adjacent item', () => {
    // The anchor is in item b; the b match is 500 lines away but the a match is
    // a closer line number in a different item. Same-item wins by document
    // order (fewer items away).
    const matches = [match('a', 10), match('b', 600)];
    const anchor = { itemId: 'b', lineNumber: 100 };
    expect(findClosestMatchIndex(matches, anchor, orderIndex)).toBe(1);
  });

  test('across items, the nearest item index wins', () => {
    const matches = [match('a', 999), match('c', 1)];
    const anchor = { itemId: 'b', lineNumber: 50 };
    // Both items are one away from b; line distance breaks the tie toward c.
    expect(findClosestMatchIndex(matches, anchor, orderIndex)).toBe(1);
  });

  test('exact tie prefers the match at or after the anchor', () => {
    // Same item, anchor at line 100, matches equidistant before (90) and after
    // (110). The forward one is chosen.
    const matches = [match('a', 90), match('a', 110)];
    const anchor = { itemId: 'a', lineNumber: 100 };
    expect(findClosestMatchIndex(matches, anchor, orderIndex)).toBe(1);
  });

  test('skips matches whose item has dropped out', () => {
    const matches = [match('gone', 100), match('a', 7)];
    const anchor = { itemId: 'a', lineNumber: 8 };
    expect(findClosestMatchIndex(matches, anchor, orderIndex)).toBe(1);
  });
});

const MULTI_FILE_PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const target = 1;
+const target = 2;
 const tail = target;
diff --git a/b.ts b/b.ts
new file mode 100644
--- /dev/null
+++ b/b.ts
@@ -0,0 +1 @@
+const target = 3;
`;

describe('findMatches across files', () => {
  const items = buildCodeViewData(MULTI_FILE_PATCH, 'multi').items;

  test('orders by file then position within each item', () => {
    const matches = findMatches(items, 'target', DEFAULT);
    // a.ts: deletion l1, addition l1, context l2 ; b.ts: addition l1.
    expect(matches).toHaveLength(4);
    expect(
      matches.map((m) => ({ side: m.side, lineNumber: m.lineNumber }))
    ).toEqual([
      { side: 'deletions', lineNumber: 1 },
      { side: 'additions', lineNumber: 1 },
      { side: 'additions', lineNumber: 2 },
      { side: 'additions', lineNumber: 1 },
    ]);
    // First three share the same item (a.ts); the last belongs to b.ts.
    const firstItemId = matches[0].itemId;
    expect(matches[1].itemId).toBe(firstItemId);
    expect(matches[2].itemId).toBe(firstItemId);
    expect(matches[3].itemId).not.toBe(firstItemId);
  });
});
