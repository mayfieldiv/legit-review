// Quick-open file filter for the Ctrl/Cmd-P palette. Ranks file paths against a
// typed query using a VS Code-style subsequence fuzzy match: every query
// character must appear in the path in order (case-insensitive), and the score
// rewards matches that fall on a path/word boundary, run consecutively, or land
// in the file's basename. Each result also carries the matched character
// indices so the palette can highlight them.

export interface FuzzyFileMatch {
  path: string;
  score: number;
  // Indices into `path` of the characters matched by the query, ascending.
  positions: number[];
}

// Characters that begin a new path or word segment. A query char that lands
// immediately after one of these reads as the start of a meaningful token
// (a directory, a filename, an extension, a snake/kebab part) and is rewarded.
const SEGMENT_SEPARATORS = new Set(['/', '\\', '.', '-', '_', ' ']);

// Scoring weights, tuned so that — all else equal — a basename hit beats a
// directory-only hit, a contiguous run beats scattered chars, and a
// boundary-aligned char beats one buried mid-token.
const SCORE_BASE = 1; // every matched char is worth at least this
const SCORE_FIRST_CHAR = 8; // matched char is the very first char of the path
const SCORE_BOUNDARY = 10; // matched char starts a path/word segment
const SCORE_CAMEL = 7; // matched char is an uppercase camelCase boundary
const SCORE_BASENAME = 6; // matched char lies within the file's basename
const SCORE_CONSECUTIVE = 9; // matched char immediately follows the prior match

function isLowerOrDigit(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
}

function isUpper(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

// The standalone bonus for matching a query char at path index `j`, ignoring
// how it relates to the previous match. Captures "where in the path is this
// char" — first char, segment start, camelCase hump, or inside the basename.
function positionalBonus(
  path: string,
  j: number,
  basenameStart: number
): number {
  let bonus = SCORE_BASE;
  const previousChar = j > 0 ? path[j - 1] : '';
  if (j === 0) {
    bonus += SCORE_FIRST_CHAR + SCORE_BOUNDARY;
  } else if (SEGMENT_SEPARATORS.has(previousChar)) {
    bonus += SCORE_BOUNDARY;
  } else if (isLowerOrDigit(previousChar) && isUpper(path[j])) {
    bonus += SCORE_CAMEL;
  }
  if (j >= basenameStart) {
    bonus += SCORE_BASENAME;
  }
  return bonus;
}

// Whether `query` appears in `path` as a subsequence (case-insensitive). A cheap
// O(path) gate so scorePath only runs the quadratic alignment on real matches.
function isSubsequence(lowerPath: string, lowerQuery: string): boolean {
  let q = 0;
  for (let i = 0; i < lowerPath.length && q < lowerQuery.length; i++) {
    if (lowerPath[i] === lowerQuery[q]) {
      q++;
    }
  }
  return q === lowerQuery.length;
}

// Scores how well `query` fuzzy-matches `path`. Returns null when `query` is not
// a subsequence of `path`. An empty query is a trivial match worth nothing, so
// the palette can list every file in its natural order before the user types.
//
// Unlike a greedy left-to-right scan — which would bind "page" to the leading
// "p" of "app/page.tsx" and highlight the wrong characters — this finds the
// maximum-scoring alignment via dynamic programming. `best[i][j]` is the best
// score for matching the first i+1 query chars with query char i landing on
// path index j; each cell extends the best earlier-query-char cell to its left,
// adding the consecutive bonus when the chosen predecessor sits immediately
// before j. Backtracking the recorded predecessors recovers the matched
// indices for highlighting.
export function scorePath(
  path: string,
  query: string
): { score: number; positions: number[] } | null {
  if (query === '') {
    return { score: 0, positions: [] };
  }
  const lowerPath = path.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!isSubsequence(lowerPath, lowerQuery)) {
    return null;
  }
  const n = lowerQuery.length;
  const m = lowerPath.length;
  const basenameStart =
    Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1;

  // best[i][j]: best score with query[i] matched at path[j] (-Infinity if
  // query[i] !== path[j]). from[i][j]: the path index query[i-1] matched at on
  // the best path into this cell, for backtracking (-1 for the first row).
  const best: number[][] = Array.from({ length: n }, () =>
    new Array<number>(m).fill(-Infinity)
  );
  const from: number[][] = Array.from({ length: n }, () =>
    new Array<number>(m).fill(-1)
  );

  for (let i = 0; i < n; i++) {
    // Running best of the previous query row over path indices strictly left of
    // j, with its argmax, so each cell can attach to the best earlier match in
    // O(1). Reset per row.
    let prevRowBest = -Infinity;
    let prevRowBestAt = -1;
    for (let j = 0; j < m; j++) {
      if (i > 0) {
        const candidate = best[i - 1][j - 1];
        if (candidate > prevRowBest) {
          prevRowBest = candidate;
          prevRowBestAt = j - 1;
        }
      }
      if (lowerPath[j] !== lowerQuery[i]) {
        continue;
      }
      const bonus = positionalBonus(path, j, basenameStart);
      if (i === 0) {
        best[i][j] = bonus;
        continue;
      }
      // Attach to the best earlier-row match left of j. If that predecessor is
      // exactly j-1 the two matched chars are adjacent, so add the run bonus.
      if (prevRowBestAt < 0) {
        continue;
      }
      const consecutive = prevRowBestAt === j - 1 ? SCORE_CONSECUTIVE : 0;
      best[i][j] = prevRowBest + bonus + consecutive;
      from[i][j] = prevRowBestAt;
    }
  }

  // The answer is the best cell in the last query row; walk `from` back to
  // collect the matched indices.
  let endAt = -1;
  let score = -Infinity;
  for (let j = 0; j < m; j++) {
    if (best[n - 1][j] > score) {
      score = best[n - 1][j];
      endAt = j;
    }
  }
  if (endAt < 0) {
    return null;
  }
  const positions = new Array<number>(n);
  let j = endAt;
  for (let i = n - 1; i >= 0; i--) {
    positions[i] = j;
    j = from[i][j];
  }
  return { score, positions };
}

// Filters and ranks `paths` against `query`, returning at most `limit` matches
// best-first. With an empty query the original order is preserved (so the
// palette opens on a stable, navigable list); otherwise results are sorted by
// score, breaking ties toward the shorter path and then alphabetically so the
// order is deterministic across renders.
export function filterPaths(
  paths: readonly string[],
  query: string,
  limit: number
): FuzzyFileMatch[] {
  if (query === '') {
    const out: FuzzyFileMatch[] = [];
    for (let i = 0; i < paths.length && out.length < limit; i++) {
      out.push({ path: paths[i], score: 0, positions: [] });
    }
    return out;
  }

  const matches: FuzzyFileMatch[] = [];
  for (const path of paths) {
    const scored = scorePath(path, query);
    if (scored != null) {
      matches.push({ path, score: scored.score, positions: scored.positions });
    }
  }
  matches.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    if (a.path.length !== b.path.length) {
      return a.path.length - b.path.length;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return matches.length > limit ? matches.slice(0, limit) : matches;
}
