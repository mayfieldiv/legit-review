import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

import type { FindMatch } from '../lib/diffFind';
import {
  collectLineRanges,
  locateActiveRange,
  repaintFind,
} from '../lib/diffFindHighlight';

const DEFAULT = { caseSensitive: false, wholeWord: false };

// Minimal CSS Custom Highlight API stand-in: JSDOM has no `CSS.highlights`, so
// repaintFind would no-op without it. A Map plus a Highlight that just records
// its ranges is enough to exercise the paint/clear bookkeeping and the
// active-painted return value.
const highlightRegistry = new Map<string, unknown>();
class FakeHighlight {
  ranges: unknown[];
  priority = 0;
  constructor(...ranges: unknown[]) {
    this.ranges = ranges;
  }
}
const fakeCSS = { highlights: highlightRegistry };

const originalGlobals = {
  document: Reflect.get(globalThis, 'document'),
  NodeFilter: Reflect.get(globalThis, 'NodeFilter'),
  Node: Reflect.get(globalThis, 'Node'),
  ShadowRoot: Reflect.get(globalThis, 'ShadowRoot'),
  window: Reflect.get(globalThis, 'window'),
  CSS: Reflect.get(globalThis, 'CSS'),
  Highlight: Reflect.get(globalThis, 'Highlight'),
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
});

beforeAll(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    NodeFilter: dom.window.NodeFilter,
    Node: dom.window.Node,
    ShadowRoot: dom.window.ShadowRoot,
    window: dom.window,
    CSS: fakeCSS,
    Highlight: FakeHighlight,
  });
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.assign(globalThis, { [key]: value });
    }
  }
  dom.window.close();
});

function lineElement(html: string): HTMLElement {
  const element = dom.window.document.createElement('div');
  element.innerHTML = html;
  return element;
}

describe('collectLineRanges', () => {
  test('stitches a match back together across token spans', () => {
    // A real rendered line is split into many text nodes by syntax-highlight
    // <span>s; the offset map must bridge them.
    const element = lineElement(
      '<span>const </span><span>foo</span><span> = foo;</span>'
    );
    const ranges: Range[] = [];
    collectLineRanges(element, 'foo', DEFAULT, ranges);
    expect(ranges.map((r) => r.toString())).toEqual(['foo', 'foo']);
  });

  test('a match spanning two token spans resolves correctly', () => {
    const element = lineElement('<span>par</span><span>se(x)</span>');
    const ranges: Range[] = [];
    collectLineRanges(element, 'parse', DEFAULT, ranges);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].toString()).toBe('parse');
  });

  test('empty line yields no ranges', () => {
    const ranges: Range[] = [];
    collectLineRanges(lineElement(''), 'foo', DEFAULT, ranges);
    expect(ranges).toHaveLength(0);
  });
});

// Builds an item element holding rendered diff rows, each addressed by the
// `data-line` / `data-line-type` attributes the diffs package emits.
function itemElement(
  rows: { line: number; type: string; html: string }[]
): HTMLElement {
  const element = dom.window.document.createElement('div');
  const content = dom.window.document.createElement('div');
  content.setAttribute('data-content', '');
  for (const row of rows) {
    const div = dom.window.document.createElement('div');
    div.setAttribute('data-line', String(row.line));
    div.setAttribute('data-line-type', row.type);
    div.innerHTML = row.html;
    content.append(div);
  }
  element.append(content);
  return element;
}

describe('locateActiveRange', () => {
  const element = itemElement([
    { line: 1, type: 'context', html: '<span>const stay = true;</span>' },
    {
      line: 2,
      type: 'change-deletion',
      html: '<span>const oldValue = 1;</span>',
    },
    {
      line: 2,
      type: 'change-addition',
      html: '<span>const newValue = 2;</span>',
    },
  ]);

  test('an additions-side match lands on the change-addition row', () => {
    const match: FindMatch = {
      itemId: 'x',
      side: 'additions',
      lineNumber: 2,
      columnStart: 6,
      length: 8,
    };
    expect(locateActiveRange(element, match)?.toString()).toBe('newValue');
  });

  test('a deletions-side match on the same line number lands on the deletion row', () => {
    const match: FindMatch = {
      itemId: 'x',
      side: 'deletions',
      lineNumber: 2,
      columnStart: 6,
      length: 8,
    };
    expect(locateActiveRange(element, match)?.toString()).toBe('oldValue');
  });

  test('returns null when the row is not rendered', () => {
    const match: FindMatch = {
      itemId: 'x',
      side: 'additions',
      lineNumber: 99,
      columnStart: 0,
      length: 3,
    };
    expect(locateActiveRange(element, match)).toBeNull();
  });

  test('columnStart selects the right occurrence on a multi-match line', () => {
    const repeated = itemElement([
      { line: 1, type: 'context', html: 'foo foo' },
    ]);
    const second: FindMatch = {
      itemId: 'x',
      side: 'additions',
      lineNumber: 1,
      columnStart: 4,
      length: 3,
    };
    const range = locateActiveRange(repeated, second);
    expect(range?.toString()).toBe('foo');
    expect(range?.startOffset).toBe(4);
  });
});

describe('repaintFind active-painted result', () => {
  // The reveal hydrate loop keeps re-painting until this returns true, so the
  // contract is: true only when the active match's row was actually painted.
  const scope = itemElement([
    { line: 1, type: 'change-addition', html: '<span>import foo;</span>' },
  ]);
  const present: FindMatch = {
    itemId: 'x',
    side: 'additions',
    lineNumber: 1,
    columnStart: 0,
    length: 6,
  };

  test('returns true when the active row is rendered and painted', () => {
    expect(
      repaintFind({
        scopes: [scope],
        query: 'import',
        options: DEFAULT,
        active: { element: scope, match: present },
      })
    ).toBe(true);
    expect(highlightRegistry.has('cv-find-active')).toBe(true);
  });

  test('returns false when the active row is not rendered yet', () => {
    // Same query (so the all-matches tint still paints) but the active match
    // points at a line that is not in this scope — the not-mounted-yet case.
    const offscreen: FindMatch = { ...present, lineNumber: 99 };
    expect(
      repaintFind({
        scopes: [scope],
        query: 'import',
        options: DEFAULT,
        active: { element: scope, match: offscreen },
      })
    ).toBe(false);
    expect(highlightRegistry.has('cv-find-active')).toBe(false);
  });

  test('returns false when there is no active match', () => {
    expect(
      repaintFind({
        scopes: [scope],
        query: 'import',
        options: DEFAULT,
        active: null,
      })
    ).toBe(false);
  });

  test('returns false for an empty query', () => {
    expect(
      repaintFind({
        scopes: [scope],
        query: '',
        options: DEFAULT,
        active: { element: scope, match: present },
      })
    ).toBe(false);
  });
});
