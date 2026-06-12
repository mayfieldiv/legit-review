'use client';

import { useStableCallback } from '@pierre/diffs/react';
import type {
  FileTreeBatchOperation,
  FileTree as FileTreeModel,
  FileTreeOptions,
  FileTreeRowDecoration,
  FileTreeRowDecorationContext,
  FileTreeRowDecorationTextPart,
} from '@pierre/trees';
import { useFileTree } from '@pierre/trees/react';
import {
  type CSSProperties,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { FileTreePublicId } from '../../../../packages/trees/dist/model/publicTypes';
import { ThemedFileTree } from './_theming/react/ThemedFileTree';
import {
  BASE_FILE_TREE_OPTIONS,
  CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
  CODE_VIEW_THREAD_ICON_NAME,
  CODE_VIEW_THREAD_ICON_VIEW_BOX,
  getInitialBatchSize,
} from './constants';
import type {
  CodeViewFileTreeFileStats,
  CodeViewFileTreeSource,
} from './types';
type FileTreeSortComparator = Exclude<
  NonNullable<FileTreeOptions['sort']>,
  'default'
>;
// Keeps @pierre/trees from applying its default semantic sort so the sidebar
// follows the same patch path sequence that drives the code view.
const PRESERVE_INPUT_ORDER_SORT: FileTreeSortComparator = () => 0;

// Layout-only overrides. Colors flow through from the resolved Shiki theme
// (via themeToTreeStyles) so the sidebar matches the diff theme, but the
// density and padding stay tuned for the diffshub layout regardless of
// which theme the user picks. `--trees-git-renamed-color-override` is kept
// because most Shiki themes don't define a "renamed" decoration color.
const DENSITY_OVERRIDE_STYLES = {
  '--trees-density-override': 0.8,
  '--trees-git-lane-width-override': '32px',
  '--trees-padding-inline-override': 8,
  '--trees-git-renamed-color-override': 'light-dark(#007aff, #007aff)',
} as CSSProperties;

const FILE_DECORATION_CSS = `
  [data-item-section='decoration'] > span {
    font-variant-numeric: tabular-nums;
  }

  [data-file-tree-decoration-tone='added'] {
    color: var(--trees-git-added-color);
    font-weight: var(--trees-font-weight-semibold);
  }

  [data-file-tree-decoration-tone='deleted'] {
    color: var(--trees-git-deleted-color);
    font-weight: var(--trees-font-weight-semibold);
  }

  [data-file-tree-decoration-tone='threads'] {
    color: var(--trees-fg-muted);
    font-weight: var(--trees-font-weight-semibold);
  }

  [data-file-tree-decoration-tone='threads'] svg {
    opacity: 0.85;
  }
`;

interface CodeViewFileTreeProps {
  // Callback invoked with the underlying tree model once it's mounted, and
  // again with `null` on unmount. Lets parents drive imperative APIs like
  // search open/close without owning the model creation.
  onModelReady(model: FileTreeModel | null): void;
  onSelectItem(itemId: string): void;
  source: CodeViewFileTreeSource;
  unresolvedThreadCountsByItemId: ReadonlyMap<string, number>;
}

export const CodeViewFileTree = memo(function CodeViewFileTree({
  onModelReady,
  onSelectItem,
  source,
  unresolvedThreadCountsByItemId,
}: CodeViewFileTreeProps) {
  const sourceRef = useRef(source);
  const unresolvedThreadCountsByItemIdRef = useRef(
    unresolvedThreadCountsByItemId
  );
  const previousSourceRef = useRef(source);
  const [initialVisibleRowCount] = useState(getInitialBatchSize);
  sourceRef.current = source;
  unresolvedThreadCountsByItemIdRef.current = unresolvedThreadCountsByItemId;
  // `source.paths` aliases the streaming accumulator's live array, so it keeps
  // growing on later publishes. The FileTree model consumes its path list
  // exactly once via useFileTree's useState initializer; capture a bounded
  // snapshot here so the first model build uses only what `pathCount`
  // describes and so subsequent streaming re-renders don't re-slice the
  // ever-growing live array.
  const initialPathsRef = useRef<readonly string[] | null>(null);
  initialPathsRef.current ??= source.paths.slice(0, source.pathCount);
  const onSelectionChange = useStableCallback(
    (selectedPaths: readonly FileTreePublicId[]) => {
      if (selectedPaths.length !== 1 || onSelectItem == null) {
        return;
      }
      const [path] = selectedPaths;
      const itemId = sourceRef.current.pathToItemId.get(path);
      if (itemId != null) {
        onSelectItem(itemId);
      }
    }
  );
  const renderRowDecoration = useStableCallback(
    ({
      item,
      row,
    }: FileTreeRowDecorationContext): FileTreeRowDecoration | null => {
      if (row.kind !== 'file') {
        return null;
      }

      const currentSource = sourceRef.current;
      const fileStats = currentSource.fileStatsByPath.get(item.path);
      if (fileStats == null) {
        return null;
      }

      const parts = formatFileTreeDecorationParts(fileStats);
      if (parts.length === 0) {
        return null;
      }

      return {
        parts,
        title: formatFileTreeDecorationTitle(fileStats),
      };
    }
  );
  const renderRowEndDecoration = useStableCallback(
    ({
      item,
      row,
    }: FileTreeRowDecorationContext): FileTreeRowDecoration | null => {
      if (row.kind !== 'file') {
        return null;
      }

      const itemId = sourceRef.current.pathToItemId.get(item.path);
      const unresolvedThreadCount =
        itemId == null
          ? 0
          : (unresolvedThreadCountsByItemIdRef.current.get(itemId) ?? 0);
      if (unresolvedThreadCount <= 0) {
        return null;
      }

      const title = `${unresolvedThreadCount} unresolved ${pluralize(
        'thread',
        unresolvedThreadCount
      )}`;
      return {
        parts: [
          {
            icon: {
              height: 12,
              name: CODE_VIEW_THREAD_ICON_NAME,
              viewBox: CODE_VIEW_THREAD_ICON_VIEW_BOX,
              width: 14,
            },
            text: String(unresolvedThreadCount),
            title,
            tone: 'threads',
          },
        ],
        title,
      };
    }
  );
  const unresolvedThreadCountsSignature = useMemo(
    () => formatUnresolvedThreadCountsSignature(unresolvedThreadCountsByItemId),
    [unresolvedThreadCountsByItemId]
  );

  const { model } = useFileTree({
    ...BASE_FILE_TREE_OPTIONS,
    gitStatus: source.gitStatus,
    paths: initialPathsRef.current,
    sort: PRESERVE_INPUT_ORDER_SORT,
    onSelectionChange,
    renderRowDecoration,
    renderRowEndDecoration,
    itemHeight: CODE_VIEW_FILE_TREE_ITEM_HEIGHT,
    initialVisibleRowCount,
    unsafeCSS: FILE_DECORATION_CSS,
  });

  useEffect(() => {
    const previousSource = previousSourceRef.current;
    if (previousSource === source) {
      return;
    }

    previousSourceRef.current = source;
    // The streaming patch loader links each tree-source snapshot to the prior
    // one through `previousSource`. When the link matches what this component
    // last applied, the new paths array is guaranteed to extend the previous
    // one, so we apply the delta as add() operations instead of asking the
    // model to throw itself away and rebuild against the full path list. This
    // turns tree publishes from O(N) each (where N is the total accumulated
    // path count) into O(delta), which keeps the Diff Stats counter fast as
    // more files stream in.
    //
    // Both snapshots alias the live accumulator's paths array, so we read the
    // delta bounds from each snapshot's captured `pathCount` instead of the
    // shared array's current length.
    if (
      source.previousSource != null &&
      source.previousSource === previousSource
    ) {
      const previousPathCount = previousSource.pathCount;
      if (source.pathCount > previousPathCount) {
        const operations: FileTreeBatchOperation[] = [];
        for (let index = previousPathCount; index < source.pathCount; index++) {
          operations.push({ type: 'add', path: source.paths[index] });
        }
        if (operations.length > 0) {
          model.batch(operations);
        }
      }
      if (source.gitStatusPatch != null) {
        model.applyGitStatusPatch(source.gitStatusPatch);
      }
      // A repeated tree path can publish new line stats without adding a row
      // or changing git status; refresh so the decoration lane catches up.
      if (
        source.pathCount === previousPathCount &&
        source.gitStatusPatch == null &&
        model.getFileTreeContainer() != null
      ) {
        model.render({});
      }
    } else {
      model.resetPaths(source.paths.slice(0, source.pathCount));
      model.setGitStatus(source.gitStatus);
    }
  }, [model, source]);

  useEffect(() => {
    onModelReady(model);
    return () => onModelReady(null);
  }, [model, onModelReady]);

  // useFileTree keeps one model instance and ignores later option changes, so
  // the decoration callback reads refs and thread-count changes explicitly
  // refresh the mounted tree.
  useEffect(() => {
    if (model.getFileTreeContainer() == null) {
      return;
    }
    model.render({});
  }, [model, unresolvedThreadCountsSignature]);

  return (
    <ThemedFileTree
      className="h-full min-h-0 overflow-auto overscroll-contain md:ml-3"
      model={model}
      reconcileForegroundFromChrome
      style={DENSITY_OVERRIDE_STYLES}
    />
  );
});

function formatFileTreeDecorationParts(
  stats: CodeViewFileTreeFileStats | undefined
): FileTreeRowDecorationTextPart[] {
  const parts: FileTreeRowDecorationTextPart[] = [];
  if (stats != null && stats.addedLines > 0) {
    parts.push({
      text: `+${stats.addedLines}`,
      title: `${stats.addedLines} ${pluralize('addition', stats.addedLines)}`,
      tone: 'added',
    });
  }
  if (stats != null && stats.deletedLines > 0) {
    parts.push({
      text: `-${stats.deletedLines}`,
      title: `${stats.deletedLines} ${pluralize(
        'deletion',
        stats.deletedLines
      )}`,
      tone: 'deleted',
    });
  }
  return parts;
}

function formatFileTreeDecorationTitle(
  stats: CodeViewFileTreeFileStats | undefined
): string {
  const parts: string[] = [];
  if (stats != null && stats.addedLines > 0) {
    parts.push(
      `${stats.addedLines} ${pluralize('addition', stats.addedLines)}`
    );
  }
  if (stats != null && stats.deletedLines > 0) {
    parts.push(
      `${stats.deletedLines} ${pluralize('deletion', stats.deletedLines)}`
    );
  }
  return parts.join(', ');
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function formatUnresolvedThreadCountsSignature(
  counts: ReadonlyMap<string, number>
): string {
  if (counts.size === 0) {
    return '';
  }

  return [...counts]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([itemId, count]) => `${itemId}:${count}`)
    .join('\n');
}
