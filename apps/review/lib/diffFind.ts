import type { CodeViewItem, SelectionSide } from '@pierre/diffs';

// In-app find for the virtualized diff view. The browser's native Cmd/Ctrl-F
// only searches DOM text, so it misses anything virtualized out of view or
// inside a collapsed file. These helpers search the in-memory model instead:
// every line of every loaded item, regardless of what is currently rendered.

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

// A single match, located in the model. `side` mirrors the diff's
// additions/deletions columns so the viewer's `scrollTo({type:'line'})` can
// resolve it to the correct rendered row; it is omitted for plain-file items.
// (itemId, side, lineNumber, columnStart) together locate the match's exact
// occurrence in the rendered DOM. The list order is document order, so a
// match's ordinal is just its index.
export interface FindMatch {
  itemId: string;
  side?: SelectionSide;
  lineNumber: number;
  columnStart: number;
  length: number;
}

// One enumerated line of an item, paired with the (lineNumber, side) address
// the viewer uses to scroll to it.
interface EnumeratedLine {
  side?: SelectionSide;
  lineNumber: number;
  text: string;
}

const WORD_CHAR = /[A-Za-z0-9_]/;

// Whole-word boundaries follow VS Code's rule: a boundary is only required on a
// side where both the matched edge char and its neighbour are word chars. This
// lets queries that themselves start/end with punctuation still match.
function isWholeWordMatch(text: string, start: number, end: number): boolean {
  const leftOk =
    start === 0 ||
    !WORD_CHAR.test(text[start - 1]) ||
    !WORD_CHAR.test(text[start]);
  const rightOk =
    end === text.length ||
    !WORD_CHAR.test(text[end]) ||
    !WORD_CHAR.test(text[end - 1]);
  return leftOk && rightOk;
}

// All non-overlapping matches of `query` within a single line of text.
export function matchLine(
  text: string,
  query: string,
  options: FindOptions
): { columnStart: number; length: number }[] {
  if (query === '') {
    return [];
  }
  const haystack = options.caseSensitive ? text : text.toLowerCase();
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matches: { columnStart: number; length: number }[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) {
      break;
    }
    const end = idx + needle.length;
    if (!options.wholeWord || isWholeWordMatch(text, idx, end)) {
      matches.push({ columnStart: idx, length: needle.length });
      from = end;
    } else {
      from = idx + 1;
    }
  }
  return matches;
}

// Walks an item into its searchable lines in display order. For diffs this
// mirrors the line-number bookkeeping in FileDiff's `getLineIndex`
// (packages/diffs) so each produced (lineNumber, side) round-trips through the
// viewer's scrollTo. Context lines are emitted once (they read identically on
// both sides), addressed on the additions side.
export function enumerateItemLines<T>(item: CodeViewItem<T>): EnumeratedLine[] {
  if (item.type === 'file') {
    const lines = item.file.contents.split('\n');
    // A trailing newline yields a phantom empty final element; drop it so line
    // numbers line up with the rendered rows.
    if (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.map((text, i) => ({ lineNumber: i + 1, text }));
  }

  const { hunks, additionLines, deletionLines } = item.fileDiff;
  const out: EnumeratedLine[] = [];
  for (const hunk of hunks) {
    let additionLine = hunk.additionStart;
    let deletionLine = hunk.deletionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let i = 0; i < content.lines; i++) {
          const text =
            additionLines[content.additionLineIndex + i] ??
            deletionLines[content.deletionLineIndex + i] ??
            '';
          out.push({ side: 'additions', lineNumber: additionLine + i, text });
        }
        additionLine += content.lines;
        deletionLine += content.lines;
      } else {
        for (let i = 0; i < content.deletions; i++) {
          out.push({
            side: 'deletions',
            lineNumber: deletionLine + i,
            text: deletionLines[content.deletionLineIndex + i] ?? '',
          });
        }
        for (let i = 0; i < content.additions; i++) {
          out.push({
            side: 'additions',
            lineNumber: additionLine + i,
            text: additionLines[content.additionLineIndex + i] ?? '',
          });
        }
        deletionLine += content.deletions;
        additionLine += content.additions;
      }
    }
  }
  return out;
}

// Flattens matches across every item into one ordered list (the order the
// items render in, then top-to-bottom within each item). This is the source of
// truth for the match count and next/prev navigation.
export function findMatches<T>(
  items: readonly CodeViewItem<T>[],
  query: string,
  options: FindOptions
): FindMatch[] {
  const out: FindMatch[] = [];
  if (query === '') {
    return out;
  }
  for (const item of items) {
    for (const line of enumerateItemLines(item)) {
      for (const m of matchLine(line.text, query, options)) {
        out.push({
          itemId: item.id,
          side: line.side,
          lineNumber: line.lineNumber,
          columnStart: m.columnStart,
          length: m.length,
        });
      }
    }
  }
  return out;
}
