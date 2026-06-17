'use client';

import {
  areSelectionsEqual,
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type LineAnnotation,
  processFile,
} from '@pierre/diffs';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  appendFileDiffToCodeViewData,
  buildCodeViewData,
  type CodeViewItemIdRename,
  createCodeViewDataAccumulator,
  snapshotCodeViewTreeSource,
  takePendingCodeViewItems,
} from './codeViewDataAccumulator';
import { CODE_VIEW_BATCH_COUNT, getInitialBatchSize } from './constants';
import {
  buildCommentContextFileDiff,
  buildFullContextFileDiff,
  type FullContextResponse,
  isFullContextCandidate,
} from './fullContext';
import { getPatchTreePathPrefix } from './gitPatchMetadata';
import {
  type CodeViewLineHashTarget,
  formatCodeViewLineHash,
  parseCodeViewLineHash,
} from './lineHash';
import {
  getStreamedPatchMetadata,
  streamGitPatchFiles,
} from './streamGitPatchFiles';
import type {
  CodeViewCommentFileByItemId,
  CodeViewCommentSidebarFile,
  CodeViewDiffStats,
  CodeViewFileTreeSource,
  CodeViewSavedCommentEntry,
  CodeViewSavedCommentItem,
  CommentMetadata,
  HunkViewedState,
  ReviewSourceInfo,
  ReviewStateComment,
  ReviewStateResponse,
  SavedCommentMetadata,
  ViewerLoadState,
} from './types';
import {
  classifyCommentLineType,
  computeFileViewed,
  computeHunkViewedState,
  getFileContentsLine,
  isDraftAnnotation,
  selectCommentContextPathsToFetch,
} from './utils';
import {
  type FileHunkHashes,
  hashFileBlock,
  hashPatchFiles,
  sha1Hex,
} from '@/lib/hunkHash';

const STREAM_PUBLISH_INTERVAL_MS = 100;
const STREAM_INITIAL_PUBLISH_INTERVAL_MS = 500;
const STREAM_WORK_BUDGET_MS = 8;
const STREAM_TREE_PUBLISH_FILE_BATCH_SIZE = 1_000;
const STREAM_TREE_PUBLISH_INTERVAL_MS = 1_000;
const GENERIC_PATCH_LOAD_ERROR_MESSAGE = 'We couldn’t load that diff.';
const EXTRA_FILE_ITEM_ID_PREFIX = 'file:';

interface UsePatchLoaderOptions {
  base?: string;
  commit?: string;
  from?: string;
  to?: string;
  collapseMode: 'expanded' | 'collapsed';
  onLoadStart(): void;
  repo: string;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
}

interface UsePatchLoaderResult {
  applyCollapseModeToLoaded(mode: 'expanded' | 'collapsed'): void;
  applyViewedMarks(
    marks: Pick<ReviewStateResponse, 'viewedFiles' | 'viewedHunks'>
  ): boolean;
  commentFileByItemId: CodeViewCommentFileByItemId | null;
  commentSections: CodeViewSavedCommentItem[];
  diffStats: CodeViewDiffStats | null;
  errorMessage: string | null;
  getFileHunkHashes(filePath: string): FileHunkHashes | undefined;
  getHunkViewedState(
    itemId: string,
    hunkIndex: number
  ): HunkViewedState | undefined;
  getOrderedItems(): readonly CodeViewItem<CommentMetadata>[];
  initialItems: CodeViewItem<CommentMetadata>[];
  isFileViewed(itemId: string): boolean;
  loadState: ViewerLoadState;
  onLineLinkChange(selection: CodeViewLineSelection | null): void;
  onViewerReady(): void;
  refreshReviewState(): Promise<void>;
  retryLoad(): void;
  reviewState: ReviewStateResponse | null;
  setCommentSections: Dispatch<SetStateAction<CodeViewSavedCommentItem[]>>;
  sourceInfo: ReviewSourceInfo | null;
  treeSource: CodeViewFileTreeSource | null;
  viewerKey: number;
}

export function usePatchLoader({
  base,
  commit,
  from,
  to,
  collapseMode,
  onLoadStart,
  repo,
  viewerRef,
}: UsePatchLoaderOptions): UsePatchLoaderResult {
  const [initialItems, setInitialItems] = useState<
    CodeViewItem<CommentMetadata>[]
  >([]);
  // Tree data is intentionally stored separately from items so annotation
  // updates do not cascade into the file tree and trigger needless rebuilds.
  // It is updated by fetch/stream batches in this viewer route.
  const [treeSource, setTreeSource] = useState<CodeViewFileTreeSource | null>(
    null
  );
  const [diffStats, setDiffStats] = useState<CodeViewDiffStats | null>(null);
  const [commentFileByItemId, setCommentFileByItemId] =
    useState<CodeViewCommentFileByItemId | null>(null);
  const [commentSections, setCommentSections] = useState<
    CodeViewSavedCommentItem[]
  >([]);
  const [loadState, setLoadState] = useState<ViewerLoadState>('fetching');
  const [sourceInfo, setSourceInfo] = useState<ReviewSourceInfo | null>(null);
  const [reviewState, setReviewState] = useState<ReviewStateResponse | null>(
    null
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [viewerKey, setViewerKey] = useState(0);
  const requestIdRef = useRef(0);
  const appliedLineHashKeyRef = useRef<string | null>(null);
  const viewerKeyRef = useRef(0);
  // Tracks every item handed to the viewer (the same mutable objects the
  // viewer renders) so collapse-mode toggles and review-state hydration can
  // walk the full set whether or not the viewer has mounted yet. The viewer
  // handle does not expose an enumeration API, so we maintain our own index.
  const loadedItemsByIdRef = useRef<Map<string, CodeViewItem<CommentMetadata>>>(
    new Map()
  );
  // Per-file hunk/file content hashes for the currently loaded diff, keyed by
  // file path. Computed from the raw patch text with the same code the server
  // uses, so viewed marks and comment hunk anchors agree across both sides.
  const fileHashesByPathRef = useRef<Map<string, FileHunkHashes>>(new Map());
  // Raw per-file patch text from the current stream, keyed by file path. The
  // full-context upgrade re-parses this text with both full file contents
  // attached so unmodified lines around hunks become expandable.
  const patchTextByPathRef = useRef<Map<string, string>>(new Map());
  // Mirror of the latest server review state for synchronous reads from
  // render-time callbacks (e.g. the header Viewed checkbox).
  const reviewStateRef = useRef<ReviewStateResponse | null>(null);
  // Working-tree contents for commented files that have no real diff item,
  // keyed by path. Such files render as synthetic context-only diff snippets
  // so out-of-diff comments show nearby code without mounting the whole file.
  // null marks a path whose contents are unavailable (missing/binary/oversized)
  // so it isn't refetched; its comments stay sidebar-only.
  const extraFileContentsByPathRef = useRef<Map<string, string | null>>(
    new Map()
  );
  // Signature of the comment ranges currently represented by each synthetic
  // diff item for an unchanged file. When review state changes, this lets us
  // rebuild only the snippets whose visible windows need to move.
  const extraFileContextSignatureByPathRef = useRef<Map<string, string>>(
    new Map()
  );
  // Paths with an /api/contents request in flight, so a state refresh that
  // lands mid-fetch doesn't kick off a duplicate.
  const extraFetchInFlightRef = useRef<Set<string>>(new Set());
  // Last viewed-state applied to each item's `collapsed` flag. Refreshes only
  // touch collapse when the viewed state actually changed, so a manual
  // expand of a viewed file survives unrelated state updates.
  const lastAppliedViewedByItemIdRef = useRef<Map<string, boolean>>(new Map());
  // Serialized form of the server-derived annotations (viewed pills + saved
  // comments) last applied to each item. applyServerState walks every loaded
  // item, but bumping an item's version invalidates its layout and render
  // caches in the viewer — on large diffs, re-rendering all files per viewed
  // toggle is what made toggles feel slow. Items whose derived annotations
  // and collapse state are unchanged are skipped entirely.
  const lastAppliedAnnotationsByItemIdRef = useRef<Map<string, string>>(
    new Map()
  );
  // Mirrors the latest collapse mode so the streaming code path (which lives
  // inside a long-lived effect/closure) can read the live value without us
  // having to re-bind it on every change.
  const collapseModeRef = useRef(collapseMode);
  collapseModeRef.current = collapseMode;

  // Pre-mutates fresh items so they arrive in the viewer matching the current
  // collapse mode, then records their ids for later bulk updates. Diff items
  // are normalized in both directions because the accumulator initializes
  // deleted-file diffs as collapsed by default — without an unconditional
  // overwrite, those would stay collapsed even when the user is in expanded
  // mode.
  const prepareItemsForViewer = (
    items: readonly CodeViewItem<CommentMetadata>[]
  ): void => {
    const targetCollapsed = collapseModeRef.current === 'collapsed';
    for (const item of items) {
      loadedItemsByIdRef.current.set(item.id, item);
      if (item.type === 'diff') {
        item.collapsed = targetCollapsed;
      }
    }
  };

  const applyCollapseModeToLoaded = useStableCallback(
    (mode: 'expanded' | 'collapsed') => {
      const targetCollapsed = mode === 'collapsed';
      const viewer = viewerRef.current;
      if (viewer == null) {
        // The viewer hasn't mounted yet (e.g. the worker pool is still warming
        // up while the header is already interactive). Rewrite any items
        // already buffered in initialItems so they arrive in the right state
        // once the viewer mounts. New items still streaming in pick up the
        // live collapse mode through prepareItemsForViewer.
        setInitialItems((prev) => {
          let changed = false;
          const next = prev.map((item) => {
            if ((item.collapsed === true) === targetCollapsed) {
              return item;
            }
            changed = true;
            return { ...item, collapsed: targetCollapsed };
          });
          return changed ? next : prev;
        });
        return;
      }

      for (const itemId of loadedItemsByIdRef.current.keys()) {
        const item = viewer.getItem(itemId);
        if (item == null) {
          continue;
        }
        const current = item.collapsed === true;
        if (current === targetCollapsed) {
          continue;
        }
        item.collapsed = targetCollapsed;
        item.version = getNextItemVersion(item);
        viewer.updateItem(item);
      }
    }
  );

  // Projects stored review state onto the loaded items: saved comment
  // annotations, per-hunk Viewed pills, sidebar sections, and viewed-driven
  // collapse. Server state replaces all synthetic annotations while open
  // drafts are preserved, so this is idempotent and doubles as the refresh
  // path when an agent mutates comments or the diff is reloaded. Open comments
  // on files outside the diff mount compact context-only diff items (contents
  // fetched on demand); files whose comments are all resolved, or that are
  // unreadable as text, stay sidebar-only with no annotation so resolving a
  // comment never leaves an otherwise-unchanged file in the diff view.
  const applyServerState = useStableCallback(
    (state: ReviewStateResponse): void => {
      const comments: readonly ReviewStateComment[] = state.comments;
      const itemsByPath = new Map<string, CodeViewItem<CommentMetadata>>();
      const orderByItemId = new Map<string, number>();
      let order = 0;
      for (const item of loadedItemsByIdRef.current.values()) {
        orderByItemId.set(item.id, order++);
        itemsByPath.set(
          item.type === 'diff' ? item.fileDiff.name : item.file.name,
          item
        );
      }

      const annotationsByItemId = new Map<
        string,
        DiffLineAnnotation<CommentMetadata>[]
      >();
      const fileAnnotationsByItemId = new Map<
        string,
        LineAnnotation<CommentMetadata>[]
      >();
      // Out-of-diff files with an open comment have their contents fetched
      // async and mounted as context-only items; this whole projection re-runs
      // once those items exist. Resolved-only files are excluded so they never
      // appear in the diff view just to host resolved threads.
      const pathsNeedingContents = selectCommentContextPathsToFetch(
        comments,
        (path) => itemsByPath.has(path),
        (path) => extraFileContentsByPathRef.current.has(path)
      );
      const sectionsByPath = new Map<string, CodeViewSavedCommentItem>();
      const sortedComments = [...comments].sort(
        (a, b) => a.range.end - b.range.end
      );
      const extraCommentRangesByPath = new Map<
        string,
        ReviewStateComment['range'][]
      >();
      for (const comment of sortedComments) {
        const item = itemsByPath.get(comment.filePath);
        const fileHashes = fileHashesByPathRef.current.get(comment.filePath);
        const extraContents = extraFileContentsByPathRef.current.get(
          comment.filePath
        );
        if (fileHashes == null && extraContents != null) {
          const ranges = extraCommentRangesByPath.get(comment.filePath) ?? [];
          ranges.push(comment.range);
          extraCommentRangesByPath.set(comment.filePath, ranges);
        }
        // A hunk-anchored comment is outdated when its hunk's content hash no
        // longer exists in the current diff. Out-of-diff comments (no hunk
        // hash) are checked against the file's actual line text instead; with
        // no text to check against (file in the diff: trust the anchor; file
        // unreadable: assume stale) the snippet check is skipped.
        let outdated: boolean;
        if (comment.hunkHash !== '') {
          outdated =
            fileHashes == null ||
            !fileHashes.hunkHashes.includes(comment.hunkHash);
        } else if (fileHashes != null) {
          outdated = false;
        } else if (extraContents != null) {
          outdated =
            comment.lineSnippet !== '' &&
            getFileContentsLine(extraContents, comment.range.end) !==
              comment.lineSnippet;
        } else {
          outdated = extraContents === null;
        }
        const metadata: SavedCommentMetadata = {
          kind: 'saved',
          key: comment.id,
          author: comment.author,
          message: comment.message,
          createdAt: comment.createdAt,
          range: comment.range,
          replies: comment.replies,
          resolved: comment.resolved,
          resolvedBy: comment.resolvedBy,
          outdated,
        };
        const itemId = item?.id ?? `missing:${comment.filePath}`;
        if (item != null && item.type === 'diff') {
          const annotations = annotationsByItemId.get(item.id) ?? [];
          annotations.push({
            side: comment.side,
            lineNumber: comment.range.end,
            metadata,
          });
          annotationsByItemId.set(item.id, annotations);
        } else if (item != null) {
          const annotations = fileAnnotationsByItemId.get(item.id) ?? [];
          annotations.push({ lineNumber: comment.range.end, metadata });
          fileAnnotationsByItemId.set(item.id, annotations);
        }
        const entry: CodeViewSavedCommentEntry = {
          author: comment.author,
          itemId,
          key: comment.id,
          lineNumber: comment.range.end,
          lineType:
            item != null && item.type === 'diff'
              ? classifyCommentLineType(
                  item.fileDiff,
                  comment.side,
                  comment.range.end
                )
              : 'context',
          message: comment.message,
          outdated,
          range: comment.range,
          replyCount: comment.replies.length,
          resolved: comment.resolved,
          side: comment.side,
        };
        const section = sectionsByPath.get(comment.filePath);
        if (section == null) {
          sectionsByPath.set(comment.filePath, {
            comments: [entry],
            fileOrder: orderByItemId.get(itemId) ?? Number.MAX_SAFE_INTEGER,
            itemId,
            path: comment.filePath,
          });
        } else {
          section.comments.push(entry);
        }
      }

      const viewer = viewerRef.current;
      for (const item of loadedItemsByIdRef.current.values()) {
        const extraContextChanged = isExtraFileContextItem(item)
          ? updateExtraFileContextItem(item, extraCommentRangesByPath)
          : false;
        if (item.type === 'file') {
          // Plain file items carry only saved-comment annotations: no viewed
          // pills (nothing was changed) and no viewed-driven collapse.
          const serverAnnotations = fileAnnotationsByItemId.get(item.id) ?? [];
          const annotationSignature = JSON.stringify(serverAnnotations);
          if (
            lastAppliedAnnotationsByItemIdRef.current.get(item.id) ===
            annotationSignature
          ) {
            continue;
          }
          lastAppliedAnnotationsByItemIdRef.current.set(
            item.id,
            annotationSignature
          );
          const drafts = (item.annotations ?? []).filter(isDraftAnnotation);
          item.annotations = [...drafts, ...serverAnnotations];
          item.version = getNextItemVersion(item);
          viewer?.updateItem(item);
          continue;
        }
        const filePath = item.fileDiff.name;
        const fileHashes = fileHashesByPathRef.current.get(filePath);

        const fileViewedByHash =
          fileHashes != null &&
          state.viewedFiles[filePath] === fileHashes.fileHash;
        const viewedHunkSet = new Set(state.viewedHunks[filePath] ?? []);
        const hunkViewedSignature =
          fileHashes?.hunkHashes.map((hunkHash) => [
            hunkHash,
            fileViewedByHash || viewedHunkSet.has(hunkHash),
          ]) ?? [];

        const serverAnnotations = annotationsByItemId.get(item.id) ?? [];

        // Viewed files stay collapsed. Only touch `collapsed` when the
        // viewed state changed so manual expand/collapse survives unrelated
        // refreshes.
        let collapseChanged = false;
        if (fileHashes != null) {
          const fileViewed = computeFileViewed(
            state.viewedFiles,
            state.viewedHunks,
            filePath,
            fileHashes.fileHash,
            fileHashes.hunkHashes
          );
          const lastApplied = lastAppliedViewedByItemIdRef.current.get(item.id);
          if (lastApplied !== fileViewed) {
            lastAppliedViewedByItemIdRef.current.set(item.id, fileViewed);
            item.collapsed = fileViewed;
            collapseChanged = true;
          }
        }

        // Skip the viewer update when nothing this pass derives for the item
        // changed; updateItem invalidates the item's layout/render caches and
        // doing that for every file made state refreshes scale with diff size.
        const annotationSignature = JSON.stringify([
          hunkViewedSignature,
          serverAnnotations,
        ]);
        if (
          !extraContextChanged &&
          !collapseChanged &&
          lastAppliedAnnotationsByItemIdRef.current.get(item.id) ===
            annotationSignature
        ) {
          continue;
        }
        lastAppliedAnnotationsByItemIdRef.current.set(
          item.id,
          annotationSignature
        );

        const drafts = (item.annotations ?? []).filter(isDraftAnnotation);
        item.annotations = [...drafts, ...serverAnnotations];
        item.version = getNextItemVersion(item);
        viewer?.updateItem(item);
      }

      setCommentSections(
        [...sectionsByPath.values()].sort((a, b) => a.fileOrder - b.fileOrder)
      );

      if (pathsNeedingContents.size > 0) {
        void loadExtraFileItems([...pathsNeedingContents]);
      }
    }
  );

  // Fetches working-tree contents for commented files outside the diff and
  // mounts compact context-only diff items so their comments render with code
  // context, then re-projects review state to attach the annotations.
  // Unreadable paths are cached as null so their comments stay sidebar-only
  // without refetching; transport failures stay uncached and retry on the
  // next state refresh.
  const loadExtraFileItems = useStableCallback(
    async (paths: string[]): Promise<void> => {
      const requestId = requestIdRef.current;
      const newPaths = paths.filter(
        (path) =>
          !extraFileContentsByPathRef.current.has(path) &&
          !extraFetchInFlightRef.current.has(path)
      );
      if (newPaths.length === 0) {
        return;
      }
      for (const path of newPaths) {
        extraFetchInFlightRef.current.add(path);
      }
      let payload: FullContextResponse;
      try {
        const params = buildReviewRequestParams(repo, {
          base,
          commit,
          from,
          to,
        });
        const response = await fetch(`/api/contents?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: newPaths.map((path) => ({ path })) }),
        });
        if (!response.ok) {
          throw new Error((await response.text()).trim());
        }
        payload = (await response.json()) as FullContextResponse;
      } catch (error) {
        console.warn('Failed to load contents for commented files', error);
        return;
      } finally {
        for (const path of newPaths) {
          extraFetchInFlightRef.current.delete(path);
        }
      }
      if (requestIdRef.current !== requestId) {
        return;
      }

      const newItems: CodeViewItem<CommentMetadata>[] = [];
      const newFileEntries: [string, CodeViewCommentSidebarFile][] = [];
      for (const file of payload.files) {
        extraFileContentsByPathRef.current.set(file.path, file.newContents);
        if (file.newContents == null) {
          continue;
        }
        const id = getExtraFileItemId(file.path);
        const contentHash = await sha1Hex(file.newContents);
        const ranges = reviewStateRef.current?.comments
          .filter((comment) => comment.filePath === file.path)
          .map((comment) => comment.range);
        const fileDiff = buildCommentContextFileDiff({
          path: file.path,
          contents: file.newContents,
          cacheKey: `${id}#${contentHash}`,
          ranges: ranges ?? [],
        });
        if (fileDiff == null) {
          continue;
        }
        extraFileContextSignatureByPathRef.current.set(
          file.path,
          getCommentRangeSignature(ranges ?? [])
        );
        const item: CodeViewItem<CommentMetadata> = {
          id,
          type: 'diff',
          fileDiff,
          version: 0,
        };
        loadedItemsByIdRef.current.set(id, item);
        newFileEntries.push([
          id,
          { fileOrder: loadedItemsByIdRef.current.size, path: file.path },
        ]);
        newItems.push(item);
      }
      if (newItems.length > 0) {
        const viewer = viewerRef.current;
        if (viewer != null) {
          viewer.addItems(newItems);
        } else {
          setInitialItems((prev) => [...prev, ...newItems]);
        }
        setCommentFileByItemId(
          (prev) => new Map([...(prev ?? []), ...newFileEntries])
        );
      }
      const state = reviewStateRef.current;
      if (state != null) {
        applyServerState(state);
      }
    }
  );

  function isExtraFileContextItem(
    item: CodeViewItem<CommentMetadata>
  ): item is CodeViewItem<CommentMetadata> & { type: 'diff' } {
    return (
      item.type === 'diff' &&
      item.id === getExtraFileItemId(item.fileDiff.name) &&
      extraFileContentsByPathRef.current.has(item.fileDiff.name) &&
      !fileHashesByPathRef.current.has(item.fileDiff.name)
    );
  }

  function updateExtraFileContextItem(
    item: CodeViewItem<CommentMetadata> & { type: 'diff' },
    rangesByPath: ReadonlyMap<string, readonly ReviewStateComment['range'][]>
  ): boolean {
    const path = item.fileDiff.name;
    const contents = extraFileContentsByPathRef.current.get(path);
    if (contents == null) {
      return false;
    }
    const ranges = rangesByPath.get(path) ?? [];
    const signature = getCommentRangeSignature(ranges);
    if (extraFileContextSignatureByPathRef.current.get(path) === signature) {
      return false;
    }
    const nextFileDiff = buildCommentContextFileDiff({
      path,
      contents,
      cacheKey: item.fileDiff.cacheKey ?? getExtraFileItemId(path),
      ranges,
    });
    if (nextFileDiff == null) {
      return false;
    }
    extraFileContextSignatureByPathRef.current.set(path, signature);
    item.fileDiff = nextFileDiff;
    return true;
  }

  // Whether an item's file currently counts as viewed (file-level mark or
  // all hunks marked). Read at render time by the header Viewed checkbox.
  const isFileViewed = useStableCallback((itemId: string): boolean => {
    const state = reviewStateRef.current;
    const item = loadedItemsByIdRef.current.get(itemId);
    if (state == null || item == null || item.type !== 'diff') {
      return false;
    }
    const fileHashes = fileHashesByPathRef.current.get(item.fileDiff.name);
    if (fileHashes == null) {
      return false;
    }
    return computeFileViewed(
      state.viewedFiles,
      state.viewedHunks,
      item.fileDiff.name,
      fileHashes.fileHash,
      fileHashes.hunkHashes
    );
  });

  // Fetches persisted review state for the loaded repo and applies it.
  const hydrateReviewState = useStableCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current;
    let state: ReviewStateResponse;
    try {
      const response = await fetch(
        `/api/state?${new URLSearchParams({ repo })}`,
        { cache: 'no-store' }
      );
      if (!response.ok) {
        throw new Error((await response.text()).trim());
      }
      state = (await response.json()) as ReviewStateResponse;
    } catch (error) {
      console.warn('Failed to load review state', error);
      return;
    }
    if (requestIdRef.current !== requestId) {
      return;
    }
    reviewStateRef.current = state;
    setReviewState(state);
    applyServerState(state);
  });

  // Applies the viewed marks a PUT /api/viewed response returns, without a
  // second /api/state round trip. Viewed toggles never change comments, so
  // merging the marks into the cached state is exact, not approximate.
  // Returns false when review state hasn't hydrated yet (caller falls back
  // to a full refresh).
  const applyViewedMarks = useStableCallback(
    (
      marks: Pick<ReviewStateResponse, 'viewedFiles' | 'viewedHunks'>
    ): boolean => {
      const current = reviewStateRef.current;
      if (current == null) {
        return false;
      }
      const next: ReviewStateResponse = {
        ...current,
        viewedFiles: marks.viewedFiles,
        viewedHunks: marks.viewedHunks,
      };
      reviewStateRef.current = next;
      setReviewState(next);
      applyServerState(next);
      return true;
    }
  );

  const getFileHunkHashes = useStableCallback(
    (filePath: string): FileHunkHashes | undefined =>
      fileHashesByPathRef.current.get(filePath)
  );

  const getHunkViewedState = useStableCallback(
    (itemId: string, hunkIndex: number): HunkViewedState | undefined => {
      const state = reviewStateRef.current;
      const item = loadedItemsByIdRef.current.get(itemId);
      if (state == null || item == null || item.type !== 'diff') {
        return undefined;
      }
      const filePath = item.fileDiff.name;
      const fileHashes = fileHashesByPathRef.current.get(filePath);
      if (fileHashes == null) {
        return undefined;
      }
      return computeHunkViewedState(
        state.viewedFiles,
        state.viewedHunks,
        filePath,
        fileHashes.fileHash,
        fileHashes.hunkHashes[hunkIndex]
      );
    }
  );

  const tryApplyLineHashTarget = useStableCallback(() => {
    const { hash } = window.location;
    const target = parseCodeViewLineHash(hash);
    if (target == null) {
      return;
    }

    const applyKey = getLineHashApplyKey(viewerKeyRef.current, hash);
    if (appliedLineHashKeyRef.current === applyKey) {
      return;
    }

    const viewer = viewerRef.current;
    if (viewer == null) {
      return;
    }

    if (applyCodeViewLineHashTarget(viewer, target)) {
      appliedLineHashKeyRef.current = applyKey;
    }
  });

  const handleLineLinkChange = useStableCallback(
    (selection: CodeViewLineSelection | null) => {
      const nextHash =
        selection == null ? null : formatCodeViewLineHash(selection);
      appliedLineHashKeyRef.current =
        nextHash == null
          ? null
          : getLineHashApplyKey(viewerKeyRef.current, nextHash);
      replaceLocationHash(nextHash);
    }
  );

  useEffect(() => {
    const scope = { base, commit, from, to };
    const patchRequestKey = getReviewRequestKey(repo, scope);
    const patchSearchParams = buildReviewRequestParams(repo, scope);

    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    const isCurrentRequest = () =>
      requestIdRef.current === requestId && !controller.signal.aborted;

    viewerKeyRef.current = requestId;
    appliedLineHashKeyRef.current = null;
    loadedItemsByIdRef.current = new Map();
    fileHashesByPathRef.current = new Map();
    patchTextByPathRef.current = new Map();
    extraFileContentsByPathRef.current = new Map();
    extraFileContextSignatureByPathRef.current = new Map();
    extraFetchInFlightRef.current = new Set();
    reviewStateRef.current = null;
    lastAppliedViewedByItemIdRef.current = new Map();
    lastAppliedAnnotationsByItemIdRef.current = new Map();
    setReviewState(null);
    setViewerKey(requestId);
    setInitialItems([]);
    setTreeSource(null);
    setDiffStats(null);
    setCommentFileByItemId(null);
    setCommentSections([]);
    setSourceInfo(null);
    onLoadStart();
    setErrorMessage(null);
    setLoadState('fetching');

    async function loadPatch() {
      try {
        const cacheKeyPrefix = encodeURIComponent(patchRequestKey);
        async function commitFullPatch(patchContent: string) {
          if (!isCurrentRequest()) {
            return;
          }
          setLoadState('parsing');
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

          if (!isCurrentRequest()) {
            return;
          }
          // Salt the tokenization cache key with the request id: this
          // non-streamed path keys files by index, which would otherwise
          // collide across reloads of changed local content.
          const loadedData = buildCodeViewData(
            patchContent,
            `${patchRequestKey}#${requestId}`
          );
          const fileHashes = await hashPatchFiles(patchContent);
          if (!isCurrentRequest()) {
            return;
          }
          for (const entry of fileHashes) {
            fileHashesByPathRef.current.set(entry.filePath, entry);
          }

          setTreeSource(loadedData.treeSource);
          setCommentFileByItemId(loadedData.itemIdToFile);
          setCommentSections([]);
          setDiffStats(loadedData.diffStats);
          prepareItemsForViewer(loadedData.items);
          setInitialItems(loadedData.items);
          setLoadState('ready');
          await hydrateReviewState();
          await yieldToBrowser();
          if (isCurrentRequest()) {
            tryApplyLineHashTarget();
          }
        }

        // Upgrades partial (patch-only) file diffs to full-context diffs so
        // the viewer can expand the unmodified lines around hunks, like
        // GitHub's expanders. Runs after the diff is interactive: this is
        // pure enhancement, so any failure (binary/oversized files, contents
        // drifting from the patch mid-edit) leaves the partial diff in place.
        async function hydrateFullContext() {
          const candidates: {
            item: CodeViewItem<CommentMetadata> & { type: 'diff' };
            path: string;
            prevPath: string | undefined;
          }[] = [];
          for (const item of loadedItemsByIdRef.current.values()) {
            if (
              item.type !== 'diff' ||
              !isFullContextCandidate(item.fileDiff) ||
              !patchTextByPathRef.current.has(item.fileDiff.name)
            ) {
              continue;
            }
            candidates.push({
              item,
              path: item.fileDiff.name,
              prevPath: item.fileDiff.prevName,
            });
          }
          if (candidates.length === 0) {
            return;
          }

          let payload: FullContextResponse;
          try {
            const response = await fetch(`/api/contents?${patchSearchParams}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                files: candidates.map(({ path, prevPath }) => ({
                  path,
                  prevPath,
                })),
              }),
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new Error((await response.text()).trim());
            }
            payload = (await response.json()) as FullContextResponse;
          } catch (error) {
            if (isCurrentRequest()) {
              console.warn('Failed to load full file contents', error);
            }
            return;
          }
          if (!isCurrentRequest()) {
            return;
          }

          const contentsByPath = new Map(
            payload.files.map((file) => [file.path, file])
          );
          let upgradedSinceYield = 0;
          for (const { item, path: filePath } of candidates) {
            const entry = contentsByPath.get(filePath);
            const fileText = patchTextByPathRef.current.get(filePath);
            const fileHashes = fileHashesByPathRef.current.get(filePath);
            if (
              entry?.oldContents == null ||
              entry.newContents == null ||
              fileText == null ||
              fileHashes == null
            ) {
              continue;
            }
            const upgraded = buildFullContextFileDiff({
              partial: item.fileDiff,
              fileText,
              cacheKey: `${cacheKeyPrefix}-${fileHashes.fileHash}-full`,
              oldContents: entry.oldContents,
              newContents: entry.newContents,
            });
            if (upgraded == null) {
              continue;
            }
            item.fileDiff = upgraded;
            item.version = getNextItemVersion(item);
            viewerRef.current?.updateItem(item);
            // Each updateItem re-renders synchronously; yield periodically so
            // a large diff's upgrade pass can't lock up the main thread.
            if (++upgradedSinceYield >= 8) {
              upgradedSinceYield = 0;
              await yieldToBrowser();
              if (!isCurrentRequest()) {
                return;
              }
            }
          }
        }

        console.time('--     request time');
        const response = await fetch(`/api/diff?${patchSearchParams}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        console.timeEnd('--     request time');

        // This only catches route setup errors. Diff source failures are
        // delivered while consuming the stream so the UI can enter the
        // streaming state as soon as the local transport opens.
        if (!response.ok) {
          const detail = (await response.text()).trim();
          throw new Error(
            detail.length > 0 ? detail : `Request failed (${response.status}).`
          );
        }

        if (isCurrentRequest()) {
          setSourceInfo(parseReviewSourceInfo(response.headers));
        }

        if (response.body == null) {
          console.time('--     reading patch');
          const patchContent = await response.text();
          console.timeEnd('--     reading patch');
          await commitFullPatch(patchContent);
          return;
        }

        setLoadState('streaming');
        await yieldToBrowser();
        if (!isCurrentRequest()) {
          return;
        }

        const accumulator = createCodeViewDataAccumulator();
        let streamPatchIndex = 0;
        let streamTreePathPrefix: string | undefined;
        let pendingPublishFileCount = 0;
        let pendingTreePublishFileCount = 0;
        let hasPublishedTree = false;
        let hasPublishedInitialItems = false;
        let hasReceivedFirstStreamedFile = false;
        let lastPublishTime = performance.now();
        let lastWorkYieldTime = lastPublishTime;
        let lastTreePublishTime = lastPublishTime;
        const initialPublishFileBatchSize = getInitialBatchSize();

        const publishTreeSource = () => {
          if (pendingTreePublishFileCount === 0 || !isCurrentRequest()) {
            return;
          }

          pendingTreePublishFileCount = 0;
          hasPublishedTree = true;
          lastTreePublishTime = performance.now();
          setCommentFileByItemId(accumulator.itemIdToFile);
          setDiffStats({ ...accumulator.diffStats });
          setTreeSource(snapshotCodeViewTreeSource(accumulator));
        };

        const publishPendingData = async () => {
          if (pendingPublishFileCount === 0 || !isCurrentRequest()) {
            return;
          }

          pendingPublishFileCount = 0;
          lastPublishTime = performance.now();
          const pendingItems = takePendingCodeViewItems(accumulator);
          prepareItemsForViewer(pendingItems);
          if (!hasPublishedInitialItems) {
            hasPublishedInitialItems = true;
            publishTreeSource();
            setInitialItems(pendingItems);
          } else {
            const viewer = viewerRef.current;
            if (viewer != null) {
              viewer.addItems(pendingItems);
            } else {
              setInitialItems((prev) => [...prev, ...pendingItems]);
            }
          }
          await yieldToBrowser();
          if (isCurrentRequest()) {
            tryApplyLineHashTarget();
          }
          lastWorkYieldTime = performance.now();
        };

        const publishPendingDataIfNeeded = async () => {
          if (pendingPublishFileCount === 0) {
            return;
          }

          const elapsed = performance.now() - lastPublishTime;
          const publishFileBatchSize = hasPublishedInitialItems
            ? CODE_VIEW_BATCH_COUNT
            : initialPublishFileBatchSize;
          const publishInterval = hasPublishedInitialItems
            ? STREAM_PUBLISH_INTERVAL_MS
            : STREAM_INITIAL_PUBLISH_INTERVAL_MS;
          if (
            pendingPublishFileCount < publishFileBatchSize &&
            elapsed < publishInterval
          ) {
            return;
          }

          await publishPendingData();
        };
        const shouldDeferInitialPublishForBatchTarget = () => {
          if (hasPublishedInitialItems) {
            return false;
          }

          const elapsed = performance.now() - lastPublishTime;
          return (
            pendingPublishFileCount < initialPublishFileBatchSize &&
            elapsed < STREAM_INITIAL_PUBLISH_INTERVAL_MS
          );
        };
        const publishTreeSourceIfNeeded = () => {
          if (pendingTreePublishFileCount === 0) {
            return;
          }

          const elapsed = performance.now() - lastTreePublishTime;
          if (
            hasPublishedTree &&
            pendingTreePublishFileCount < STREAM_TREE_PUBLISH_FILE_BATCH_SIZE &&
            elapsed < STREAM_TREE_PUBLISH_INTERVAL_MS
          ) {
            return;
          }

          publishTreeSource();
        };
        const appendStreamedFile = async (fileText: string) => {
          if (!hasReceivedFirstStreamedFile) {
            hasReceivedFirstStreamedFile = true;
            console.timeEnd('--     first streamed file');
          }

          const patchMetadata = getStreamedPatchMetadata(fileText);
          if (patchMetadata != null) {
            streamTreePathPrefix = getPatchTreePathPrefix(
              patchMetadata,
              streamPatchIndex++
            );
          }

          // The cache key must change when the file's content changes:
          // downstream tokenization caches by key alone, and local diffs
          // reload with new content under the same repo/path identity. The
          // content hash keys the cache perfectly — unchanged files reuse
          // their tokenization across reloads, changed files re-render.
          const fileHashes = await hashFileBlock(fileText);
          const fileDiff = processFile(fileText, {
            cacheKey: `${cacheKeyPrefix}-${fileHashes.fileHash}`,
            isGitDiff: true,
          });
          if (fileDiff == null) {
            return;
          }

          fileHashesByPathRef.current.set(fileHashes.filePath, fileHashes);
          if (fileDiff.name !== fileHashes.filePath) {
            fileHashesByPathRef.current.set(fileDiff.name, fileHashes);
          }
          patchTextByPathRef.current.set(fileDiff.name, fileText);

          const itemIdRename = appendFileDiffToCodeViewData(
            accumulator,
            fileDiff,
            streamTreePathPrefix
          );
          if (itemIdRename != null) {
            applyCodeViewItemIdRename(viewerRef.current, itemIdRename);
            const renamedItem = loadedItemsByIdRef.current.get(
              itemIdRename.oldId
            );
            if (renamedItem != null) {
              loadedItemsByIdRef.current.delete(itemIdRename.oldId);
              loadedItemsByIdRef.current.set(itemIdRename.newId, renamedItem);
            }
          }
          pendingPublishFileCount++;
          pendingTreePublishFileCount++;
          const elapsedWork = performance.now() - lastWorkYieldTime;
          if (elapsedWork >= STREAM_WORK_BUDGET_MS) {
            if (shouldDeferInitialPublishForBatchTarget()) {
              await yieldToBrowser();
              lastWorkYieldTime = performance.now();
            } else {
              await publishPendingData();
            }
          } else {
            await publishPendingDataIfNeeded();
          }
          publishTreeSourceIfNeeded();
        };

        console.time('--     first streamed file');
        console.time('--     reading patch stream');
        const fallbackPatchContent = await streamGitPatchFiles(
          response.body,
          appendStreamedFile
        );
        console.timeEnd('--     reading patch stream');
        if (!isCurrentRequest()) {
          return;
        }

        await publishPendingData();
        publishTreeSource();
        if (fallbackPatchContent != null) {
          await commitFullPatch(fallbackPatchContent);
          return;
        }

        setCommentFileByItemId(new Map(accumulator.itemIdToFile));
        setDiffStats({ ...accumulator.diffStats });
        setLoadState('ready');
        await hydrateReviewState();
        await hydrateFullContext();
      } catch (error) {
        if (!isCurrentRequest()) {
          return;
        }
        console.warn('Failed to load diff', error);
        // Local diff failures carry actionable detail (bad path, missing
        // base ref, not a repo), so surface them instead of a generic line.
        setErrorMessage(
          error instanceof Error && error.message !== ''
            ? error.message
            : GENERIC_PATCH_LOAD_ERROR_MESSAGE
        );
        setLoadState('error');
      }
    }

    void loadPatch();

    return () => {
      controller.abort();
    };
  }, [
    base,
    commit,
    from,
    to,
    hydrateReviewState,
    loadAttempt,
    onLoadStart,
    repo,
    tryApplyLineHashTarget,
    viewerRef,
  ]);

  useEffect(() => {
    window.addEventListener('hashchange', tryApplyLineHashTarget);
    tryApplyLineHashTarget();
    return () => {
      window.removeEventListener('hashchange', tryApplyLineHashTarget);
    };
  }, [tryApplyLineHashTarget]);

  const retryLoad = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  // Every loaded item in display order, including collapsed and not-yet-rendered
  // ones. In-app find searches this rather than the DOM so it can reach content
  // the browser's native Cmd-F can't. This returns `initialItems` (the same
  // ordered array the viewer renders) rather than the lookup map's values: the
  // map's iteration order can diverge from display order, e.g. a streamed rename
  // deletes and re-adds an entry, moving it to the end.
  const getOrderedItems = useStableCallback(
    (): readonly CodeViewItem<CommentMetadata>[] => initialItems
  );

  return {
    applyCollapseModeToLoaded,
    applyViewedMarks,
    commentFileByItemId,
    commentSections,
    diffStats,
    errorMessage,
    getFileHunkHashes,
    getHunkViewedState,
    getOrderedItems,
    initialItems,
    isFileViewed,
    loadState,
    onLineLinkChange: handleLineLinkChange,
    onViewerReady: tryApplyLineHashTarget,
    refreshReviewState: hydrateReviewState,
    retryLoad,
    reviewState,
    setCommentSections,
    sourceInfo,
    treeSource,
    viewerKey,
  };
}

function parseReviewSourceInfo(headers: Headers): ReviewSourceInfo | null {
  const repoPath = headers.get('X-Review-Repo');
  const branch = headers.get('X-Review-Branch');
  if (repoPath == null || branch == null) {
    return null;
  }
  const mode = headers.get('X-Review-Mode');
  const base: Pick<ReviewSourceInfo, 'repoPath' | 'branch'> = {
    repoPath: decodeURIComponent(repoPath),
    branch: decodeURIComponent(branch),
  };

  if (mode === 'range' || mode === 'single') {
    const prev = headers.get('X-Review-Prev');
    const next = headers.get('X-Review-Next');
    return {
      ...base,
      mode,
      fromSha: decodeHeader(headers.get('X-Review-From')),
      toSha: decodeHeader(headers.get('X-Review-To')),
      fromSubject: decodeHeader(headers.get('X-Review-From-Subject')),
      toSubject: decodeHeader(headers.get('X-Review-To-Subject')),
      prevSha: prev == null || prev === '' ? null : prev,
      nextSha: next == null || next === '' ? null : next,
    };
  }

  return {
    ...base,
    mode: 'working-tree',
    baseRef: decodeHeader(headers.get('X-Review-Base')),
  };
}

function decodeHeader(value: string | null): string | undefined {
  return value == null ? undefined : decodeURIComponent(value);
}

interface ReviewRequestScope {
  base?: string;
  commit?: string;
  from?: string;
  to?: string;
}

// Builds the /api/diff and /api/contents query for a review request. Exactly
// one scope wins, mirroring the server: `commit` (single), `from`+`to` (range),
// then `base` (working tree), then none (auto base).
function buildReviewRequestParams(
  repo: string,
  scope: ReviewRequestScope
): URLSearchParams {
  const params = new URLSearchParams({ repo });
  if (isSet(scope.commit)) {
    params.set('commit', scope.commit);
  } else if (isSet(scope.from) || isSet(scope.to)) {
    if (isSet(scope.from)) {
      params.set('from', scope.from);
    }
    if (isSet(scope.to)) {
      params.set('to', scope.to);
    }
  } else if (isSet(scope.base)) {
    params.set('base', scope.base);
  }
  return params;
}

// Stable identity for the request, used to salt tokenization cache keys so
// reloads of changed content don't collide across scopes.
function getReviewRequestKey(repo: string, scope: ReviewRequestScope): string {
  if (isSet(scope.commit)) {
    return `${repo}@commit:${scope.commit}`;
  }
  if (isSet(scope.from) || isSet(scope.to)) {
    return `${repo}@range:${scope.from ?? ''}..${scope.to ?? ''}`;
  }
  if (isSet(scope.base)) {
    return `${repo}@${scope.base}`;
  }
  return repo;
}

function isSet(value: string | undefined): value is string {
  return value != null && value !== '';
}

function getLineHashApplyKey(viewerKey: number, hash: string): string {
  return `${viewerKey}:${hash}`;
}

function applyCodeViewLineHashTarget(
  viewer: CodeViewHandle<CommentMetadata>,
  target: CodeViewLineHashTarget
): boolean {
  const item = viewer.getItem(target.itemId);
  if (item == null) {
    return false;
  }

  const selectedLines = viewer.getSelectedLines();
  if (
    selectedLines?.id === target.itemId &&
    areSelectionsEqual(selectedLines.range, target.range)
  ) {
    return true;
  }

  if (item.collapsed === true) {
    item.collapsed = false;
    item.version = getNextItemVersion(item);
    if (!viewer.updateItem(item)) {
      return false;
    }
    viewer.getInstance()?.render(true);
  }

  viewer.setSelectedLines({ id: target.itemId, range: target.range });
  viewer.scrollTo({
    type: 'range',
    id: target.itemId,
    range: target.range,
    align: 'center',
    behavior: 'instant',
  });
  return true;
}

function applyCodeViewItemIdRename(
  viewer: CodeViewHandle<CommentMetadata> | null,
  rename: CodeViewItemIdRename
): void {
  viewer?.updateItemId(rename.oldId, rename.newId);
}

function getNextItemVersion(item: { version?: string | number }): number {
  return typeof item.version === 'number' ? item.version + 1 : 1;
}

function replaceLocationHash(hash: string | null): void {
  const { pathname, search } = window.location;
  const nextHash = hash ?? '';
  if (window.location.hash === nextHash) {
    return;
  }

  window.history.replaceState(
    window.history.state,
    '',
    `${pathname}${search}${nextHash}`
  );
}

function getExtraFileItemId(path: string): string {
  return `${EXTRA_FILE_ITEM_ID_PREFIX}${path}`;
}

function getCommentRangeSignature(
  ranges: readonly ReviewStateComment['range'][]
): string {
  const entries = ranges
    .map((range) => [
      range.start,
      range.side ?? '',
      range.end,
      range.endSide ?? '',
    ])
    .sort((left, right) => {
      for (let index = 0; index < left.length; index++) {
        const comparison = String(left[index]).localeCompare(
          String(right[index])
        );
        if (comparison !== 0) {
          return comparison;
        }
      }
      return 0;
    });
  return JSON.stringify(entries);
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    let didResolve = false;
    const resolveOnce = () => {
      if (didResolve) {
        return;
      }

      didResolve = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(resolveOnce, 50);
    window.requestAnimationFrame(resolveOnce);
  });
}
