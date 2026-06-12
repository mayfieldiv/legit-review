import {
  areSelectionsEqual,
  type CodeViewItem,
  type CodeViewLineSelection,
  type CodeViewOptions,
  type DiffIndicators,
  type DiffLineAnnotation,
  type HunkData,
  type LineAnnotation,
  type SelectedLineRange,
  type ThemeTypes,
} from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { IconChevronSm } from '@pierre/icons';
import {
  type CSSProperties,
  memo,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from 'react';

import { diffshubChromeMapping } from './_theming/js/diffshubChromeMapping';
import { ThemedCodeView } from './_theming/react/ThemedCodeView';
import { useChromeThemeProps } from './_theming/react/useChromeThemeProps';
import { CODE_VIEW_CUSTOM_CSS, CODE_VIEW_LAYOUT } from './constants';
import { DraftAnnotation } from './DraftAnnotation';
import { SavedAnnotation } from './SavedAnnotation';
import type {
  CodeViewDeletedCommentEvent,
  CodeViewSavedCommentEvent,
  CommentAnnotation,
  CommentMetadata,
  DraftCommentMetadata,
  HunkViewedState,
  PersistCommentInput,
  SavedCommentMetadata,
} from './types';
import {
  classifyCommentLineType,
  getFileContentsLine,
  getFullFileDiffLine,
  isDraftAnnotation,
  isDraftMetadata,
  isSavedAnnotation,
} from './utils';
import { FileViewedCheckbox, HunkViewedPill } from './ViewedControls';
import { cn } from '@/lib/utils';

function getNextItemVersion(item: CodeViewItem<CommentMetadata>): number {
  return typeof item.version === 'number' ? item.version + 1 : 1;
}

// Rewrites an item's annotation list and pushes the bumped version to the
// viewer; returning null from the callback leaves the item untouched. The
// callbacks only filter elements or remap their metadata, so each item kind
// keeps its own annotation element type (diff annotations carry a side,
// plain-file annotations don't) — TS can't see that through the union,
// hence the per-branch assertions.
function updateViewerItemAnnotations(
  viewer: CodeViewHandle<CommentMetadata>,
  itemId: string,
  update: (
    annotations: readonly CommentAnnotation[]
  ) => CommentAnnotation[] | null
): CodeViewItem<CommentMetadata> | undefined {
  const item = viewer.getItem(itemId);
  if (item == null) {
    return undefined;
  }

  const next = update(item.annotations ?? []);
  if (next == null) {
    return undefined;
  }
  if (item.type === 'diff') {
    item.annotations = next as DiffLineAnnotation<CommentMetadata>[];
  } else {
    item.annotations = next as LineAnnotation<CommentMetadata>[];
  }

  item.version = getNextItemVersion(item);
  return viewer.updateItem(item) ? item : undefined;
}

interface ActiveDraftComment {
  itemId: string;
  key: string;
}

interface CodeViewWrapperProps {
  className?: string;
  diffStyle: 'split' | 'unified';
  getHunkViewedState(
    itemId: string,
    hunkIndex: number
  ): HunkViewedState | undefined;
  canToggleFileViewed(itemId: string): boolean;
  isFileViewed(itemId: string): boolean;
  onCommentDeleted(comment: CodeViewDeletedCommentEvent): void;
  onCommentSaved(comment: CodeViewSavedCommentEvent): void;
  // Thread mutations (root edit, replies). All resolve false on failure so
  // the card keeps its editor open; the metadata re-renders via the
  // review-state refresh the container performs on success.
  onDeleteReply(key: string, replyId: string): Promise<boolean>;
  onEditComment(key: string, message: string): Promise<boolean>;
  onEditReply(key: string, replyId: string, message: string): Promise<boolean>;
  onReplyToComment(key: string, message: string): Promise<boolean>;
  onToggleFileViewed(itemId: string, viewed: boolean): void;
  onToggleHunkViewed(itemId: string, hunkHash: string, viewed: boolean): void;
  onToggleResolved(itemId: string, key: string, resolved: boolean): void;
  // Persists a submitted draft to the review store; null means the save
  // failed (the caller surfaces the error) and the draft stays open.
  persistComment(
    input: PersistCommentInput
  ): Promise<SavedCommentMetadata | null>;
  overflow: 'wrap' | 'scroll';
  showBackgrounds: boolean;
  diffIndicators: DiffIndicators;
  lineNumbers: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  themeType: ThemeTypes;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
  initialItems: CodeViewItem<CommentMetadata>[];
  onLineLinkChange(selection: CodeViewLineSelection | null): void;
  onViewerReady(): void;
}

export const CodeViewWrapper = memo(function CodeViewWrapper({
  className,
  diffStyle,
  getHunkViewedState,
  canToggleFileViewed,
  isFileViewed,
  onCommentDeleted,
  onCommentSaved,
  onDeleteReply,
  onEditComment,
  onEditReply,
  onReplyToComment,
  onToggleFileViewed,
  onToggleHunkViewed,
  onToggleResolved,
  persistComment,
  overflow,
  showBackgrounds,
  diffIndicators,
  lineNumbers,
  scrollRef,
  themeType,
  viewerRef,
  initialItems,
  onLineLinkChange,
  onViewerReady,
}: CodeViewWrapperProps) {
  const nextCommentKeyRef = useRef(0);
  const activeDraftRef = useRef<ActiveDraftComment | null>(null);
  const [selectedLines, setSelectedLines] =
    useState<CodeViewLineSelection | null>(null);
  const { style: chromeStyle } = useChromeThemeProps(diffshubChromeMapping);
  // Preserve the previous `undefined`-means-not-resolved contract that
  // buildAnnotationThemeStyle and the className fallbacks depend on.
  const themeChromeStyle =
    Object.keys(chromeStyle).length > 0 ? chromeStyle : undefined;
  const annotationThemeStyle = useMemo(
    () => buildAnnotationThemeStyle(themeChromeStyle),
    [themeChromeStyle]
  );

  const handleSetSelection = useStableCallback(
    (selection: CodeViewLineSelection | null) => {
      setSelectedLines(selection);
    }
  );

  const handleToggleCommentSelection = useStableCallback(
    (selection: CodeViewLineSelection) => {
      setSelectedLines((prev) =>
        prev?.id === selection.id &&
        areSelectionsEqual(prev.range, selection.range)
          ? null
          : selection
      );
    }
  );

  const handleLineSelectionEnd = useStableCallback(
    (range: SelectedLineRange | null, item: CodeViewItem<CommentMetadata>) => {
      if (range == null || item.type !== 'diff') {
        onLineLinkChange(null);
      } else {
        onLineLinkChange({ id: item.id, range });
      }
    }
  );

  const handleViewerRef = useStableCallback(
    (viewer: CodeViewHandle<CommentMetadata> | null) => {
      viewerRef.current = viewer;
      if (viewer != null) {
        onViewerReady();
      }
    }
  );

  const handleCreateDraftComment = useStableCallback(
    (range: SelectedLineRange, itemId: string) => {
      const lineNumber = range.end;
      const commentKey = `draft-${nextCommentKeyRef.current++}`;
      const { current: viewer } = viewerRef;
      if (viewer == null) {
        return;
      }
      const item = viewer.getItem(itemId);
      if (item == null) {
        return;
      }

      const draftMetadata: DraftCommentMetadata = {
        kind: 'draft',
        key: commentKey,
        message: '',
        range,
      };

      const { current: activeDraft } = activeDraftRef;
      if (activeDraft != null && activeDraft.itemId !== itemId) {
        updateViewerItemAnnotations(
          viewer,
          activeDraft.itemId,
          (annotations) => {
            const nextAnnotations = annotations.filter(
              (annotation) => annotation.metadata.key !== activeDraft.key
            );
            return nextAnnotations.length === annotations.length
              ? null
              : nextAnnotations;
          }
        );
      }

      // Diff annotations need the selection's side; plain file items have a
      // single pane, so their annotations carry only the line number.
      if (item.type === 'diff') {
        const side = range.endSide ?? range.side;
        if (side == null) {
          return;
        }
        const nonDraftAnnotations = (item.annotations ?? []).filter(
          (annotation) => !isDraftMetadata(annotation.metadata)
        );
        item.annotations = [
          ...nonDraftAnnotations,
          { side, lineNumber, metadata: draftMetadata },
        ];
      } else {
        const nonDraftAnnotations = (item.annotations ?? []).filter(
          (annotation) => !isDraftMetadata(annotation.metadata)
        );
        item.annotations = [
          ...nonDraftAnnotations,
          { lineNumber, metadata: draftMetadata },
        ];
      }
      item.version = getNextItemVersion(item);
      if (viewer.updateItem(item)) {
        activeDraftRef.current = { itemId, key: commentKey };
      }
    }
  );

  const handleRemoveComment = useStableCallback(
    (itemId: string, key: string) => {
      const { current: viewer } = viewerRef;
      if (viewer == null) {
        return;
      }
      const item = viewer.getItem(itemId);
      const removedAnnotation: CommentAnnotation | undefined =
        item?.annotations?.find(
          (annotation) => annotation.metadata.key === key
        );

      updateViewerItemAnnotations(viewer, itemId, (annotations) => {
        const nextAnnotations = annotations.filter(
          (annotation) => annotation.metadata.key !== key
        );
        return nextAnnotations.length === annotations.length
          ? null
          : nextAnnotations;
      });

      const { current: activeDraft } = activeDraftRef;
      if (activeDraft?.itemId === itemId && activeDraft.key === key) {
        activeDraftRef.current = null;
      }

      setSelectedLines(null);
      onLineLinkChange(null);
      if (removedAnnotation != null && isSavedAnnotation(removedAnnotation)) {
        onCommentDeleted({ itemId, key });
      }
    }
  );

  const handleSaveDraftComment = useStableCallback(
    async (itemId: string, key: string, message: string): Promise<boolean> => {
      const trimmedMessage = message.trim();
      const { current: viewer } = viewerRef;
      if (trimmedMessage.length === 0 || viewer == null) {
        return false;
      }

      const item = viewer.getItem(itemId);
      if (item == null) {
        return false;
      }

      const draftAnnotation: CommentAnnotation | undefined =
        item.annotations?.find((annotation) => annotation.metadata.key === key);
      if (draftAnnotation == null || !isDraftAnnotation(draftAnnotation)) {
        return false;
      }

      // Plain file items have no diff sides; their comments anchor to
      // working-tree line numbers, which the store models as 'additions'.
      const side =
        'side' in draftAnnotation ? draftAnnotation.side : 'additions';

      // Persist first; only swap the draft card for a saved card once the
      // store accepted the comment, so a failed save never loses the text.
      const savedMetadata = await persistComment({
        fileDiff: item.type === 'diff' ? item.fileDiff : undefined,
        itemId,
        lineSnippet:
          item.type === 'file'
            ? getFileContentsLine(
                item.file.contents,
                draftAnnotation.lineNumber
              )
            : getFullFileDiffLine(
                item.fileDiff,
                side,
                draftAnnotation.lineNumber
              ),
        message: trimmedMessage,
        range: draftAnnotation.metadata.range,
        side,
      });
      if (savedMetadata == null) {
        return false;
      }

      const updatedItem = updateViewerItemAnnotations(
        viewer,
        itemId,
        (annotations) =>
          annotations.map((annotation) =>
            annotation.metadata.key === key && isDraftAnnotation(annotation)
              ? { ...annotation, metadata: savedMetadata }
              : annotation
          )
      );

      if (updatedItem == null) {
        return false;
      }

      const { current: activeDraft } = activeDraftRef;
      if (activeDraft?.itemId === itemId && activeDraft.key === key) {
        activeDraftRef.current = null;
      }

      setSelectedLines(null);
      onLineLinkChange(null);
      onCommentSaved({
        author: savedMetadata.author,
        itemId,
        key: savedMetadata.key,
        lineNumber: draftAnnotation.lineNumber,
        lineType:
          item.type === 'diff'
            ? classifyCommentLineType(
                item.fileDiff,
                side,
                draftAnnotation.lineNumber
              )
            : 'context',
        message: trimmedMessage,
        outdated: savedMetadata.outdated,
        range: draftAnnotation.metadata.range,
        replyCount: 0,
        resolved: savedMetadata.resolved,
        side,
      });
      return true;
    }
  );

  const handleToggleItemCollapsed = useStableCallback((itemId: string) => {
    const { current: viewerHandle } = viewerRef;
    const viewer = viewerHandle?.getInstance();
    const item = viewerHandle?.getItem(itemId);
    if (viewerHandle == null || viewer == null || item == null) {
      return;
    }

    // NOTE(amadeus): If the top of the item is before the scrollTop, then
    // we'll want to apply a scroll fix on the next render to ensure we
    // keep the collapsed file in view and anchored.
    const itemTop = viewer.getTopForItem(itemId);
    item.collapsed = item.collapsed !== true;
    item.version = getNextItemVersion(item);
    if (!viewerHandle.updateItem(item)) {
      return;
    }

    if (itemTop != null && itemTop < viewer.getScrollTop()) {
      viewer.scrollTo({
        type: 'item',
        id: item.id,
        align: 'start',
      });
    }
  });

  const renderCommentAnnotation = useStableCallback(
    (
      annotation:
        | DiffLineAnnotation<CommentMetadata>
        | LineAnnotation<CommentMetadata>,
      item: CodeViewItem<CommentMetadata>
    ) => {
      if (isDraftAnnotation(annotation)) {
        return (
          <DraftAnnotation
            annotation={annotation}
            itemId={item.id}
            onCancel={handleRemoveComment}
            onSave={handleSaveDraftComment}
          />
        );
      }

      if (!isSavedAnnotation(annotation)) {
        return null;
      }

      return (
        <SavedAnnotation
          annotation={annotation}
          itemId={item.id}
          onDelete={handleRemoveComment}
          onDeleteReply={onDeleteReply}
          onEditComment={onEditComment}
          onEditReply={onEditReply}
          onReply={onReplyToComment}
          onToggleResolved={onToggleResolved}
          onToggleSelection={handleToggleCommentSelection}
        />
      );
    }
  );

  const renderHunkSeparator = useStableCallback(
    (hunk: HunkData, item: CodeViewItem<CommentMetadata>) => {
      if (item.type !== 'diff' || !shouldRenderHunkViewedPill(hunk, item)) {
        return null;
      }
      const viewedState = getHunkViewedState(item.id, hunk.hunkIndex);
      if (viewedState == null) {
        return null;
      }
      return (
        <HunkViewedPill
          viewed={viewedState.viewed}
          onToggle={() =>
            onToggleHunkViewed(
              item.id,
              viewedState.hunkHash,
              !viewedState.viewed
            )
          }
        />
      );
    }
  );

  const renderHeaderPrefix = useStableCallback(
    (item: CodeViewItem<CommentMetadata>) => {
      return (
        <CollapseDiffButton
          disabled={
            item.type === 'diff'
              ? item.fileDiff.splitLineCount === 0 &&
                item.fileDiff.unifiedLineCount === 0
              : item.file.contents.length === 0
          }
          collapsed={item.collapsed}
          onToggle={() => handleToggleItemCollapsed(item.id)}
        />
      );
    }
  );

  const renderHeaderMetadata = useStableCallback(
    (item: CodeViewItem<CommentMetadata>) => {
      if (item.type !== 'diff' || !canToggleFileViewed(item.id)) {
        return null;
      }

      return (
        <FileViewedCheckbox
          viewed={isFileViewed(item.id)}
          onToggle={(viewed) => onToggleFileViewed(item.id, viewed)}
        />
      );
    }
  );

  // NOTE(amadeus): For some insane reason, the react compiler did not know how
  // to properly memoize this, so we pulled it into a `useMemo` for safety...
  const options: CodeViewOptions<CommentMetadata> = useMemo(
    () =>
      ({
        // Use this to validate itemMetrics when changing layout with unsafeCSS.
        // __devOnlyValidateItemHeights: true,
        layout: CODE_VIEW_LAYOUT,
        themeType,
        diffStyle,
        diffIndicators,
        overflow,
        disableBackground: !showBackgrounds,
        disableLineNumbers: !lineNumbers,
        lineHoverHighlight: 'number',
        // hunkSeparators: 'line-info-basic',
        // Devin-style hunk separators: small expansion steps plus labeled
        // "<n> lines" / "All <n> lines" buttons, so each click's reach is
        // visible before committing to it.
        expansionLineCount: 5,
        expansionLineLabels: true,
        enableLineSelection: true,
        enableGutterUtility: true,
        stickyHeaders: true,
        unsafeCSS: CODE_VIEW_CUSTOM_CSS,
        // FIXME(amadeus): Move all `onX` methods onto the react component maybe?
        onGutterUtilityClick(range, context) {
          handleCreateDraftComment(range, context.item.id);
        },
        onLineSelectionEnd(range, context) {
          handleLineSelectionEnd(range, context.item);
        },
      }) satisfies CodeViewOptions<CommentMetadata>,
    [
      diffIndicators,
      diffStyle,
      handleCreateDraftComment,
      handleLineSelectionEnd,
      lineNumbers,
      overflow,
      showBackgrounds,
      themeType,
    ]
  );
  return (
    <ThemedCodeView<CommentMetadata>
      ref={handleViewerRef}
      containerRef={scrollRef}
      initialItems={initialItems}
      className={cn(
        className,
        'cv-scrollbar relative h-full min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain border-b border-border w-full [contain:strict] [overflow-anchor:none] [will-change:scroll-position] md:border-b-0 [&_diffs-container]:overflow-clip [&_diffs-container]:[contain:layout_paint_style] [&_diffs-container]:shadow-[0_-1px_0_var(--diffshub-diff-separator,var(--color-border-opaque)),0_1px_0_var(--diffshub-diff-separator,var(--color-border-opaque))]'
      )}
      options={options}
      style={annotationThemeStyle}
      selectedLines={selectedLines}
      onSelectedLinesChange={handleSetSelection}
      renderAnnotation={renderCommentAnnotation}
      renderHunkSeparator={renderHunkSeparator}
      renderHeaderMetadata={renderHeaderMetadata}
      renderHeaderPrefix={renderHeaderPrefix}
    />
  );
});

function shouldRenderHunkViewedPill(
  hunk: HunkData,
  item: CodeViewItem<CommentMetadata>
): boolean {
  if (item.type !== 'diff') {
    return false;
  }
  if (hunk.type === 'unified') {
    return true;
  }
  if (item.fileDiff.type === 'deleted') {
    return hunk.type === 'deletions';
  }
  return hunk.type === 'additions';
}

const ANNOTATION_THEME_STYLE_KEYS = [
  '--diffshub-annotation-bg',
  '--diffshub-annotation-border',
  '--diffshub-annotation-fg',
  '--diffshub-annotation-hover-border',
  '--diffshub-annotation-shadow',
  '--diffshub-popover-muted-fg',
  // Inter-file separator hairline. Carries the themed border-opaque value
  // (same weight as the header/sidebar chrome borders) so it stays visible
  // on any theme without reading darker than the surrounding chrome.
  '--diffshub-diff-separator',
  // Main scrollbar thumb + gutter tint; this element is the cv-scrollbar host.
  '--diffshub-scrollbar-thumb-bg',
  '--diffshub-scrollbar-track-bg',
] as const;

export function buildAnnotationThemeStyle(
  themeChromeStyle: CSSProperties | undefined
): CSSProperties | undefined {
  if (themeChromeStyle == null) {
    return undefined;
  }

  const source = themeChromeStyle as CSSProperties &
    Partial<Record<(typeof ANNOTATION_THEME_STYLE_KEYS)[number], string>>;
  const style: Record<string, string> = {};
  for (const key of ANNOTATION_THEME_STYLE_KEYS) {
    const value = source[key];
    if (typeof value === 'string') {
      style[key] = value;
    }
  }

  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined;
}

interface CollapseDiffButtonProps {
  disabled?: boolean;
  collapsed?: boolean;
  onToggle(): void;
}

function CollapseDiffButton({
  disabled = false,
  collapsed = false,
  onToggle,
}: CollapseDiffButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={!disabled && !collapsed}
      aria-hidden={disabled}
      aria-label={
        disabled ? undefined : collapsed ? 'Expand diff' : 'Collapse diff'
      }
      className="text-muted-foreground hover:bg-muted hover:text-foreground ml-[-8px] inline-flex size-6 cursor-pointer items-center justify-center rounded-md transition disabled:pointer-events-none disabled:opacity-50"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <IconChevronSm
        aria-hidden="true"
        className={cn(
          'size-4 transition-transform',
          (disabled || collapsed) && '-rotate-90'
        )}
      />
    </button>
  );
}
