import type { CodeViewLineSelection } from '@pierre/diffs';
import { IconCheck, IconClockArrow, IconX } from '@pierre/icons';
import { memo } from 'react';

import { annotationCardBase, CommentAuthorBadge } from './annotation-shared';
import type { CommentAnnotation, SavedCommentMetadata } from './types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface SavedAnnotationProps {
  annotation: CommentAnnotation<SavedCommentMetadata>;
  itemId: string;
  onDelete(itemId: string, key: string): void;
  onToggleResolved(itemId: string, key: string, resolved: boolean): void;
  onToggleSelection(selection: CodeViewLineSelection): void;
}

// Persisted review comment card. Resolved comments render dimmed with the
// resolver's note; outdated comments (their hunk's content changed since the
// comment was written) carry an amber badge.
export const SavedAnnotation = memo(function SavedAnnotation({
  annotation,
  itemId,
  onDelete,
  onToggleResolved,
  onToggleSelection,
}: SavedAnnotationProps) {
  const { metadata } = annotation;
  const selection = { id: itemId, range: metadata.range };
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        annotationCardBase,
        'group relative cursor-pointer hover:border-[var(--diffshub-annotation-hover-border,var(--diffshub-annotation-border,var(--color-border)))]',
        metadata.resolved && 'opacity-60 hover:opacity-100'
      )}
      onClick={() => onToggleSelection(selection)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        event.preventDefault();
        onToggleSelection(selection);
      }}
    >
      <CommentAuthorBadge author={metadata.author} />
      <div className="absolute top-0 right-0 z-1 flex translate-x-[35%] -translate-y-[35%] gap-1 opacity-0 transition-opacity duration-100 group-hover:opacity-100">
        <Button
          variant="default"
          size="icon-sm"
          aria-label={metadata.resolved ? 'Reopen comment' : 'Resolve comment'}
          title={metadata.resolved ? 'Reopen' : 'Resolve'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleResolved(itemId, metadata.key, !metadata.resolved);
          }}
          className="pointer-events-none inline-flex cursor-pointer items-center justify-center rounded-full bg-emerald-600 shadow-[inherit] group-hover:pointer-events-auto hover:bg-emerald-700"
        >
          {metadata.resolved ? (
            <IconClockArrow size={12} />
          ) : (
            <IconCheck size={12} />
          )}
        </Button>
        <Button
          variant="default"
          size="icon-sm"
          aria-label="Delete comment"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(itemId, metadata.key);
          }}
          className="pointer-events-none inline-flex cursor-pointer items-center justify-center rounded-full bg-neutral-500 shadow-[inherit] group-hover:pointer-events-auto"
        >
          <IconX size={12} />
        </Button>
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="mt-1 flex items-center gap-2">
          <strong className="block text-[14px]">{metadata.author}</strong>
          {metadata.resolved && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <IconCheck size={10} />
              Resolved{metadata.resolvedBy ? ` by ${metadata.resolvedBy}` : ''}
            </span>
          )}
          {metadata.outdated && (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              Outdated
            </span>
          )}
        </div>
        <p className="m-0 text-[14px] whitespace-pre-wrap">
          {metadata.message}
        </p>
        {metadata.resolutionNote != null && metadata.resolutionNote !== '' && (
          <p className="text-muted-foreground m-0 mt-1 border-l-2 border-emerald-600/40 pl-2 text-[13px] whitespace-pre-wrap">
            {metadata.resolutionNote}
          </p>
        )}
      </div>
    </div>
  );
});
