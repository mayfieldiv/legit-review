'use client';

import { type DiffIndicators } from '@pierre/diffs';
import { type CodeViewHandle, useWorkerPool } from '@pierre/diffs/react';
import { type ColorMode } from '@pierre/theming';
import { useThemeController } from '@pierre/theming/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';

import { ThemeProvider } from './_theming/react/ThemeProvider';
import { CodeViewHeader } from './CodeViewHeader';
import { CodeViewSidebar } from './CodeViewSidebar';
import { CodeViewStatusPanel } from './CodeViewStatusPanel';
import { CodeViewWrapper } from './CodeViewWrapper';
import type { DarkThemeName, LightThemeName } from './themeNames';
import type {
  CodeViewDeletedCommentEvent,
  CodeViewSavedCommentEntry,
  CodeViewSavedCommentEvent,
  CommentMetadata,
  PersistCommentInput,
  ReviewStateComment,
  ReviewStateResponse,
  SavedCommentMetadata,
} from './types';
import { usePatchLoader } from './usePatchLoader';
import { useThemeCycle } from './useThemeCycle';
import {
  getHunkIndexForLine,
  removeSavedCommentSidebarEntry,
  upsertSavedCommentSidebarEntry,
} from './utils';
import {
  docsThemeCatalog,
  themeController,
} from '@/components/themeController';

interface ReviewUIProps {
  base?: string;
  repo: string;
}

export function ReviewUI({ base, repo }: ReviewUIProps) {
  // Provide the app-scoped theme context, then render the body BELOW it so
  // the diffs hook + selection hook can read the controller context.
  return (
    <ThemeProvider controller={themeController}>
      <ReviewUIInner base={base} repo={repo} />
    </ThemeProvider>
  );
}

function ReviewUIInner({ base, repo }: ReviewUIProps) {
  const isWorkerPoolReadyOrDisable = useIsWorkerPoolReadyOrDisabled();
  const [diffStyle, setDiffStyle] = useState<'split' | 'unified'>('split');
  const [collapseMode, setCollapseMode] = useState<'expanded' | 'collapsed'>(
    'expanded'
  );
  const [fileTreeOverlayOpen, setFileTreeOverlayOpen] = useState(false);
  const [overflow, setOverflow] = useState<'wrap' | 'scroll'>('scroll');
  const [showBackgrounds, setShowBackgrounds] = useState(true);
  const [diffIndicators, setDiffIndicators] = useState<DiffIndicators>('bars');
  const [lineNumbers, setLineNumbers] = useState(true);
  // All theming state — color mode and the light/dark theme-name picks — lives
  // in the single @pierre/theming controller (the same instance the app-wide
  // ThemeProvider is bound to). Reading it here means picking Auto/Light/Dark
  // flips both the CodeView's `themeType` and the app's <html> class, and the
  // theme-name picks persist with no separate local state.
  const themeState = useThemeController(themeController);

  // The controller reads persisted values synchronously when its module loads
  // on the client, so useSyncExternalStore would surface them on the very first
  // client render — but the server rendered the defaults. Gate every
  // theme-derived value (rendered into inline chrome styles + the CodeView
  // themeType) behind a client-mounted flag so the first client render matches
  // the SSR markup, then flips to the user's selection. This also keeps the
  // long-lived WorkerPool and the CodeView from mounting against the default
  // palette before the persisted values apply.
  const [themesHydrated, setThemesHydrated] = useState(false);
  useEffect(() => {
    setThemesHydrated(true);
  }, []);

  const colorMode: ColorMode = themesHydrated ? themeState.mode : 'system';
  const appResolvedTheme = themesHydrated
    ? themeState.resolvedColorScheme
    : undefined;
  const lightThemeName = themesHydrated
    ? themeState.lightThemeName
    : docsThemeCatalog.defaultLightThemeName;
  const darkThemeName = themesHydrated
    ? themeState.darkThemeName
    : docsThemeCatalog.defaultDarkThemeName;
  const setColorMode = useCallback((mode: ColorMode) => {
    themeController.setColorMode(mode);
  }, []);
  const setLightThemeName = useCallback((name: LightThemeName) => {
    themeController.setThemeNameForScheme('light', name);
  }, []);
  const setDarkThemeName = useCallback((name: DarkThemeName) => {
    themeController.setThemeNameForScheme('dark', name);
  }, []);
  // The cycle button in the System Monitor sweeps through every Shiki
  // theme so reviewers can preview the full set without manually picking
  // each one. The hook captures the user's current pick when cycling
  // starts so the visible theme anchors the rotation.
  const themeCycle = useThemeCycle({
    lightThemeName,
    darkThemeName,
    resolvedThemeMode: appResolvedTheme,
    setLightThemeName,
    setDarkThemeName,
    setColorMode,
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<CodeViewHandle<CommentMetadata> | null>(null);
  const handlePatchLoadStart = useCallback(() => {
    setFileTreeOverlayOpen(false);
  }, []);
  const {
    applyCollapseModeToLoaded,
    applyViewedMarks,
    commentFileByItemId,
    commentSections,
    diffStats,
    errorMessage,
    getFileHunkHashes,
    getHunkViewedState,
    initialItems,
    isFileViewed,
    loadState,
    onLineLinkChange,
    onViewerReady,
    refreshReviewState,
    retryLoad,
    setCommentSections,
    sourceInfo,
    treeSource,
    viewerKey,
  } = usePatchLoader({
    base,
    collapseMode,
    onLoadStart: handlePatchLoadStart,
    repo,
    viewerRef,
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)');
    const updateMobileState = (matches: boolean) => {
      setDiffStyle(matches ? 'unified' : 'split');
      if (!matches) setFileTreeOverlayOpen(false);
    };
    const handleChange = (event: MediaQueryListEvent) => {
      updateMobileState(event.matches);
    };

    updateMobileState(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  // Live updates. `diff-changed` (working tree or HEAD moved) reloads the
  // diff and restores the scroll position; review state (comments, viewed
  // marks) is durable on the server, so it survives the reload and is
  // re-applied during hydration. `state-changed` (e.g. an agent resolved a
  // comment) just re-fetches and re-applies review state in place.
  const loadStateRef = useRef(loadState);
  loadStateRef.current = loadState;
  const scrollRestoreRef = useRef<number | null>(null);
  const pendingDiffReloadRef = useRef(false);
  const reloadDiff = useCallback(() => {
    if (loadStateRef.current !== 'ready' && loadStateRef.current !== 'error') {
      // A load is already in flight; run another pass once it settles so the
      // final state reflects the latest working tree.
      pendingDiffReloadRef.current = true;
      return;
    }
    scrollRestoreRef.current = scrollRef.current?.scrollTop ?? null;
    retryLoad();
  }, [retryLoad]);
  useEffect(() => {
    const params = new URLSearchParams({ repo });
    const source = new EventSource(`/api/events?${params}`);
    let debounceTimer: number | undefined;
    const handleDiffChanged = () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(reloadDiff, 250);
    };
    const handleStateChanged = () => {
      void refreshReviewState();
    };
    source.addEventListener('diff-changed', handleDiffChanged);
    source.addEventListener('state-changed', handleStateChanged);
    return () => {
      window.clearTimeout(debounceTimer);
      source.close();
    };
  }, [refreshReviewState, reloadDiff, repo]);
  useEffect(() => {
    if (loadState !== 'ready') {
      return;
    }
    if (scrollRestoreRef.current != null) {
      const top = scrollRestoreRef.current;
      scrollRestoreRef.current = null;
      // The viewer remounts on reload; retry until its scroll container
      // exists and has enough content to take the offset.
      let attempts = 0;
      const tryRestore = () => {
        const container = scrollRef.current;
        if (container != null && container.scrollHeight > top) {
          container.scrollTop = top;
          return;
        }
        if (attempts++ < 20) {
          requestAnimationFrame(tryRestore);
        }
      };
      requestAnimationFrame(tryRestore);
    }
    if (pendingDiffReloadRef.current) {
      pendingDiffReloadRef.current = false;
      reloadDiff();
    }
  }, [loadState, reloadDiff]);
  const handleSelectTreeItem = useCallback((itemId: string) => {
    setFileTreeOverlayOpen(false);
    const viewer = viewerRef.current;
    if (viewer == null) {
      return;
    }
    const item = viewer.getItem(itemId);
    if (item != null && item.collapsed === true) {
      item.collapsed = false;
      item.version = typeof item.version === 'number' ? item.version + 1 : 1;
      viewer.updateItem(item);
    }
    viewer.scrollTo({
      type: 'item',
      id: itemId,
      align: 'start',
      behavior: 'smooth',
    });
  }, []);
  const handleToggleCollapseMode = useCallback(() => {
    const next = collapseMode === 'expanded' ? 'collapsed' : 'expanded';
    setCollapseMode(next);
    applyCollapseModeToLoaded(next);
  }, [applyCollapseModeToLoaded, collapseMode]);
  const handleCommentSaved = useCallback(
    (comment: CodeViewSavedCommentEvent) => {
      setCommentSections((prev) =>
        upsertSavedCommentSidebarEntry(prev, commentFileByItemId, comment)
      );
    },
    [commentFileByItemId, setCommentSections]
  );
  // Persists a submitted draft. The hunk hash anchors the comment to the
  // content it was written against so it can be flagged outdated later;
  // drafts on plain file items (out-of-diff files shown because they host
  // comments) have no hunks, so they anchor by line snippet instead.
  const persistComment = useCallback(
    async (
      input: PersistCommentInput
    ): Promise<SavedCommentMetadata | null> => {
      const file = commentFileByItemId?.get(input.itemId);
      if (file == null) {
        toast.error('Could not resolve the file for this comment.');
        return null;
      }
      const hunkIndex =
        input.fileDiff == null
          ? -1
          : getHunkIndexForLine(input.fileDiff, input.side, input.range.end);
      const hunkHash =
        hunkIndex === -1
          ? ''
          : (getFileHunkHashes(file.path)?.hunkHashes[hunkIndex] ?? '');
      try {
        const params = new URLSearchParams({ repo });
        const response = await fetch(`/api/comments?${params}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filePath: file.path,
            side: input.side,
            range: input.range,
            hunkHash,
            lineSnippet: input.lineSnippet,
            message: input.message,
            author: 'user',
          }),
        });
        if (!response.ok) {
          throw new Error((await response.text()).trim());
        }
        const { comment } = (await response.json()) as {
          comment: ReviewStateComment;
        };
        return {
          kind: 'saved',
          key: comment.id,
          author: comment.author,
          message: comment.message,
          createdAt: comment.createdAt,
          range: input.range,
          replies: [],
          resolved: false,
          outdated: false,
        };
      } catch (error) {
        toast.error(
          error instanceof Error && error.message !== ''
            ? error.message
            : 'Failed to save comment.'
        );
        return null;
      }
    },
    [commentFileByItemId, getFileHunkHashes, repo]
  );
  // One helper for every thread mutation (edit the root message, add a
  // reply, edit/delete a reply): sends the request, surfaces failures, and
  // on success re-syncs review state so annotations and the sidebar
  // re-render from the server's truth. Returns false on failure so comment
  // cards can keep their in-progress editor open instead of losing text.
  const mutateCommentThread = useCallback(
    async (
      path: string,
      method: string,
      body: unknown,
      fallbackError: string
    ): Promise<boolean> => {
      try {
        const params = new URLSearchParams({ repo });
        const response = await fetch(`/api/comments/${path}?${params}`, {
          method,
          ...(body == null
            ? {}
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              }),
        });
        if (!response.ok) {
          throw new Error((await response.text()).trim());
        }
        await refreshReviewState();
        return true;
      } catch (error) {
        toast.error(
          error instanceof Error && error.message !== ''
            ? error.message
            : fallbackError
        );
        return false;
      }
    },
    [refreshReviewState, repo]
  );
  const handleEditComment = useCallback(
    (key: string, message: string) =>
      mutateCommentThread(
        key,
        'PATCH',
        { message },
        'Failed to update comment.'
      ),
    [mutateCommentThread]
  );
  const handleReplyToComment = useCallback(
    (key: string, message: string) =>
      mutateCommentThread(
        `${key}/replies`,
        'POST',
        { message, author: 'user' },
        'Failed to add reply.'
      ),
    [mutateCommentThread]
  );
  const handleEditReply = useCallback(
    (key: string, replyId: string, message: string) =>
      mutateCommentThread(
        `${key}/replies/${replyId}`,
        'PATCH',
        { message },
        'Failed to update reply.'
      ),
    [mutateCommentThread]
  );
  const handleDeleteReply = useCallback(
    (key: string, replyId: string) =>
      mutateCommentThread(
        `${key}/replies/${replyId}`,
        'DELETE',
        null,
        'Failed to delete reply.'
      ),
    [mutateCommentThread]
  );
  const handleToggleResolved = useCallback(
    (itemId: string, key: string, resolved: boolean) => {
      void (async () => {
        try {
          const params = new URLSearchParams({ repo });
          const response = await fetch(`/api/comments/${key}?${params}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(
              resolved ? { resolved, resolvedBy: 'user' } : { resolved }
            ),
          });
          if (!response.ok) {
            throw new Error((await response.text()).trim());
          }
        } catch (error) {
          toast.error(
            error instanceof Error && error.message !== ''
              ? error.message
              : 'Failed to update comment.'
          );
        }
        // Server state is the source of truth either way: success re-renders
        // the resolved badge, failure restores the previous state.
        void refreshReviewState();
      })();
    },
    [refreshReviewState, repo]
  );
  // Sends a viewed-mark mutation. The PUT response carries the updated marks,
  // which are applied to the loaded items directly — no /api/state refetch —
  // so the pill/checkbox/collapse react as soon as the (local) server acks.
  const putViewedMarks = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const params = new URLSearchParams({ repo });
        const response = await fetch(`/api/viewed?${params}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new Error((await response.text()).trim());
        }
        const marks = (await response.json()) as Pick<
          ReviewStateResponse,
          'viewedFiles' | 'viewedHunks'
        >;
        if (!applyViewedMarks(marks)) {
          await refreshReviewState();
        }
      } catch (error) {
        toast.error(
          error instanceof Error && error.message !== ''
            ? error.message
            : 'Failed to update viewed state.'
        );
        // Re-sync so the controls reflect what the server actually stored.
        await refreshReviewState();
      }
    },
    [applyViewedMarks, refreshReviewState, repo]
  );
  const handleToggleHunkViewed = useCallback(
    (itemId: string, hunkHash: string, viewed: boolean) => {
      const file = commentFileByItemId?.get(itemId);
      if (file == null) {
        return;
      }
      void putViewedMarks({
        filePath: file.path,
        viewed,
        hunkHashes: [hunkHash],
      });
    },
    [commentFileByItemId, putViewedMarks]
  );
  const handleToggleFileViewed = useCallback(
    (itemId: string, viewed: boolean) => {
      const file = commentFileByItemId?.get(itemId);
      const hashes = file == null ? undefined : getFileHunkHashes(file.path);
      if (file == null || hashes == null) {
        return;
      }
      // One request covers both levels: the file-level mark plus every hunk
      // mark, so the pills and the header checkbox always agree.
      void putViewedMarks({
        filePath: file.path,
        viewed,
        ...(hashes.hunkHashes.length > 0
          ? { hunkHashes: hashes.hunkHashes }
          : {}),
        ...(viewed ? { fileHash: hashes.fileHash } : {}),
      });
    },
    [commentFileByItemId, getFileHunkHashes, putViewedMarks]
  );
  const canToggleFileViewed = useCallback(
    (itemId: string): boolean => {
      const file = commentFileByItemId?.get(itemId);
      return file == null ? false : getFileHunkHashes(file.path) != null;
    },
    [commentFileByItemId, getFileHunkHashes]
  );
  const handleCommentDeleted = useCallback(
    (comment: CodeViewDeletedCommentEvent) => {
      // The viewer already removed the annotation optimistically.
      setCommentSections((prev) =>
        removeSavedCommentSidebarEntry(prev, comment)
      );
      void (async () => {
        try {
          const params = new URLSearchParams({ repo });
          const response = await fetch(
            `/api/comments/${comment.key}?${params}`,
            { method: 'DELETE' }
          );
          if (!response.ok && response.status !== 404) {
            throw new Error((await response.text()).trim());
          }
        } catch {
          toast.error('Failed to delete comment.');
          void refreshReviewState();
        }
      })();
    },
    [refreshReviewState, repo, setCommentSections]
  );
  const handleToggleFileTreeOverlay = useCallback(() => {
    setFileTreeOverlayOpen((open) => !open);
  }, []);
  const handleCloseFileTreeOverlay = useCallback(() => {
    setFileTreeOverlayOpen(false);
  }, []);
  const handleSelectComment = useCallback(
    (comment: CodeViewSavedCommentEntry) => {
      setFileTreeOverlayOpen(false);
      // Plain file items have a single pane: their selections and scroll
      // targets must not carry a diff side.
      const item = viewerRef.current?.getItem(comment.itemId);
      const isFileItem = item?.type === 'file';
      const diffSide =
        comment.range.endSide ?? comment.range.side ?? comment.side;
      viewerRef.current?.setSelectedLines({
        id: comment.itemId,
        range: isFileItem
          ? { start: comment.range.start, end: comment.range.end }
          : {
              ...comment.range,
              side: comment.range.side ?? diffSide,
              endSide: comment.range.endSide ?? diffSide,
            },
      });
      viewerRef.current?.scrollTo({
        type: 'line',
        id: comment.itemId,
        lineNumber: comment.range.end,
        ...(isFileItem ? {} : { side: diffSide }),
        align: 'center',
        behavior: 'smooth-auto',
      });
    },
    []
  );
  // Withhold the viewer until the persisted themes have been read from
  // localStorage. Otherwise on client-side navigation back into a diff the
  // CodeView would mount during the brief render where lightThemeName/darkThemeName
  // are still at their `DEFAULT_*_THEME` initial values and tokenize the
  // first batch of files against the wrong palette.
  const viewerAvailable =
    isWorkerPoolReadyOrDisable &&
    themesHydrated &&
    (loadState === 'ready' ||
      (loadState === 'streaming' && initialItems.length > 0));

  return (
    <ReviewGrid>
      <CodeViewHeader
        className="[grid-area:header]"
        collapseMode={collapseMode}
        colorMode={colorMode}
        darkThemeName={darkThemeName}
        diffIndicators={diffIndicators}
        diffStyle={diffStyle}
        lightThemeName={lightThemeName}
        lineNumbers={lineNumbers}
        overflow={overflow}
        fileTreeOverlayOpen={fileTreeOverlayOpen}
        fileTreeAvailable={treeSource != null}
        onToggleCollapseMode={handleToggleCollapseMode}
        onToggleFileTreeOverlay={handleToggleFileTreeOverlay}
        sourceInfo={sourceInfo}
        setColorMode={setColorMode}
        setDarkThemeName={setDarkThemeName}
        setDiffIndicators={setDiffIndicators}
        setDiffStyle={setDiffStyle}
        setLightThemeName={setLightThemeName}
        setLineNumbers={setLineNumbers}
        setOverflow={setOverflow}
        setShowBackgrounds={setShowBackgrounds}
        showBackgrounds={showBackgrounds}
      />
      {viewerAvailable && treeSource != null ? (
        <>
          <CodeViewSidebar
            className="[grid-area:viewer] md:[grid-area:tree]"
            commentSections={commentSections}
            diffStats={diffStats}
            mobileOverlayOpen={fileTreeOverlayOpen}
            onMobileClose={handleCloseFileTreeOverlay}
            onSelectComment={handleSelectComment}
            scrollRef={scrollRef}
            source={treeSource}
            streaming={loadState === 'streaming'}
            themeCycle={themeCycle}
            onSelectItem={handleSelectTreeItem}
          />
          <CodeViewWrapper
            key={viewerKey}
            className="[grid-area:viewer]"
            diffStyle={diffStyle}
            overflow={overflow}
            showBackgrounds={showBackgrounds}
            diffIndicators={diffIndicators}
            lineNumbers={lineNumbers}
            scrollRef={scrollRef}
            themeType={colorMode}
            viewerRef={viewerRef}
            initialItems={initialItems}
            getHunkViewedState={getHunkViewedState}
            canToggleFileViewed={canToggleFileViewed}
            isFileViewed={isFileViewed}
            onCommentDeleted={handleCommentDeleted}
            onCommentSaved={handleCommentSaved}
            onDeleteReply={handleDeleteReply}
            onEditComment={handleEditComment}
            onEditReply={handleEditReply}
            onLineLinkChange={onLineLinkChange}
            onReplyToComment={handleReplyToComment}
            onToggleFileViewed={handleToggleFileViewed}
            onToggleHunkViewed={handleToggleHunkViewed}
            onToggleResolved={handleToggleResolved}
            onViewerReady={onViewerReady}
            persistComment={persistComment}
          />
        </>
      ) : (
        <CodeViewStatusPanel
          errorMessage={errorMessage}
          onRetry={retryLoad}
          state={loadState}
        />
      )}
    </ReviewGrid>
  );
}

function useIsWorkerPoolReadyOrDisabled() {
  const workerPool = useWorkerPool();
  const [isReady, setIsReady] = useState(
    () => workerPool?.isInitialized() ?? true
  );
  const isReadyRef = useRef(isReady);
  useEffect(() => {
    // The callback will always be fired immediately with the new state, so we
    // don't need to check for it in the effect
    return workerPool?.subscribeToStatChanges((stats) => {
      const isReady = stats.managerState === 'initialized';
      if (isReady !== isReadyRef.current) {
        setIsReady(isReady);
        isReadyRef.current = isReady;
      }
    });
  }, [workerPool]);
  return isReady;
}

interface ReviewGridProps {
  children: ReactNode;
}

function ReviewGrid({ children }: ReviewGridProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] overflow-hidden overscroll-contain contain-strict [grid-template-areas:'header''viewer'] md:grid-cols-[320px_minmax(0,1fr)] md:[grid-template-areas:'header_header''tree_viewer']">
      {children}
    </div>
  );
}
