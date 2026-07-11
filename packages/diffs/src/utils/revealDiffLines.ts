import type {
  AnnotationSide,
  ExpansionDirections,
  FileDiffMetadata,
  HunkExpansionRegion,
} from '../types';
import {
  getExpandedRegion,
  getTrailingExpandedRegion,
} from './virtualDiffLayout';

export interface RevealLinesRange {
  start: number;
  end: number;
}

// One expandHunk() call: `direction: 'up'` grows the slice rendered at the
// top of the collapsed region before `hunkIndex` (fromStart), `'down'` grows
// the slice rendered at its bottom (fromEnd). `hunkIndex === hunks.length`
// addresses the trailing region after the last hunk, which only supports
// 'up'.
export interface HunkExpansionStep {
  hunkIndex: number;
  direction: ExpansionDirections;
  lineCount: number;
}

export interface GetHunkExpansionsToRevealLinesProps {
  fileDiff: FileDiffMetadata;
  side: AnnotationSide;
  range: RevealLinesRange;
  // Extra unchanged lines to reveal around the range so it doesn't render
  // flush against a collapsed separator. Padding never triggers an expansion
  // by itself; it only widens one that the range itself requires.
  padding?: number;
  expandedHunks: Map<number, HunkExpansionRegion> | true | undefined;
  collapsedContextThreshold: number;
  errorPrefix: string;
}

// Computes the minimal expandHunk() steps that make a 1-based line range on
// one diff side visible in a full-context diff. Lines already rendered —
// inside hunk bodies, inside small auto-rendered regions, or inside
// previously expanded slices — produce no steps, so applying the result and
// recomputing always converges. Returns undefined when the range cannot be
// revealed: partial diffs carry no hidden lines to expand, and lines outside
// the file's bounds do not exist on the requested side.
export function getHunkExpansionsToRevealLines({
  fileDiff,
  side,
  range,
  padding = 0,
  expandedHunks,
  collapsedContextThreshold,
  errorPrefix,
}: GetHunkExpansionsToRevealLinesProps): HunkExpansionStep[] | undefined {
  if (fileDiff.isPartial || fileDiff.hunks.length === 0) {
    return undefined;
  }
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const sideLines =
    side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines;
  if (start < 1 || end > sideLines.length) {
    return undefined;
  }

  const steps: HunkExpansionStep[] = [];
  let previousHunkEnd = 0;
  for (const [hunkIndex, hunk] of fileDiff.hunks.entries()) {
    const hunkStart =
      side === 'additions' ? hunk.additionStart : hunk.deletionStart;
    const hunkCount =
      side === 'additions' ? hunk.additionCount : hunk.deletionCount;
    const step = getRegionExpansionStep({
      hunkIndex,
      region: getExpandedRegion({
        isPartial: false,
        rangeSize: hunk.collapsedBefore,
        expandedHunks,
        hunkIndex,
        collapsedContextThreshold,
      }),
      regionEnd: hunkStart - 1,
      start,
      end,
      padding,
      trailing: false,
    });
    if (step != null) {
      steps.push(step);
    }
    previousHunkEnd = hunkStart + hunkCount - 1;
    if (end <= previousHunkEnd) {
      return steps;
    }
  }

  // The range reaches past the last hunk into the trailing unchanged region.
  const trailingRegion = getTrailingExpandedRegion({
    fileDiff,
    hunkIndex: fileDiff.hunks.length - 1,
    expandedHunks,
    collapsedContextThreshold,
    errorPrefix,
  });
  if (trailingRegion == null) {
    return undefined;
  }
  const trailingStep = getRegionExpansionStep({
    hunkIndex: fileDiff.hunks.length,
    region: trailingRegion,
    regionEnd: previousHunkEnd + trailingRegion.rangeSize,
    start,
    end,
    padding,
    trailing: true,
  });
  if (trailingStep != null) {
    steps.push(trailingStep);
  }
  return steps;
}

interface GetRegionExpansionStepProps {
  hunkIndex: number;
  // The region's current render state: how many of its lines are already
  // shown at its top (fromStart) and bottom (fromEnd), and its full size.
  region: {
    fromStart: number;
    fromEnd: number;
    rangeSize: number;
    renderAll: boolean;
  };
  // Line number (on the requested side) of the region's last hidden-able line.
  regionEnd: number;
  start: number;
  end: number;
  padding: number;
  // Trailing regions render only a top slice, so bottom-anchored expansion is
  // unavailable there.
  trailing: boolean;
}

// Decides whether one collapsed region hides part of [start, end] and, if so,
// returns the single cheapest expansion that reveals that part (padded). The
// two rendered slices grow from opposite edges, so the step grows whichever
// slice needs fewer lines to cover the padded target.
function getRegionExpansionStep({
  hunkIndex,
  region,
  regionEnd,
  start,
  end,
  padding,
  trailing,
}: GetRegionExpansionStepProps): HunkExpansionStep | undefined {
  if (region.renderAll || region.rangeSize <= 0) {
    return undefined;
  }
  const regionStart = regionEnd - region.rangeSize + 1;
  if (end < regionStart || start > regionEnd) {
    return undefined;
  }
  const targetStart = Math.max(start - padding, regionStart);
  const targetEnd = Math.min(end + padding, regionEnd);
  const neededFromStart = targetEnd - regionStart + 1;
  const neededFromEnd = regionEnd - targetStart + 1;
  if (region.fromStart >= neededFromStart || region.fromEnd >= neededFromEnd) {
    return undefined;
  }
  const growStart = neededFromStart - region.fromStart;
  const growEnd = neededFromEnd - region.fromEnd;
  if (!trailing && growEnd < growStart) {
    return { hunkIndex, direction: 'down', lineCount: growEnd };
  }
  return { hunkIndex, direction: 'up', lineCount: growStart };
}
