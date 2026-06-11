import { IconCheck } from '@pierre/icons';
import { memo } from 'react';

import { cn } from '@/lib/utils';

interface HunkViewedPillProps {
  viewed: boolean;
  onToggle(): void;
}

// Per-hunk "Viewed" toggle rendered in the separator above the hunk. Marks are
// stored under the hunk's content hash, so an edited hunk comes back unviewed.
export const HunkViewedPill = memo(function HunkViewedPill({
  viewed,
  onToggle,
}: HunkViewedPillProps) {
  return (
    <div className="flex px-1 font-sans">
      <button
        type="button"
        aria-pressed={viewed}
        aria-label={viewed ? 'Mark hunk not viewed' : 'Mark hunk viewed'}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
          viewed
            ? 'border-emerald-600/40 bg-emerald-600/15 text-emerald-600 dark:text-emerald-400'
            : 'border-[var(--diffshub-annotation-border,var(--color-border))] bg-[var(--diffshub-annotation-bg,var(--color-card))] text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] hover:text-[var(--diffshub-annotation-fg,var(--color-card-foreground))]'
        )}
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <span
          className={cn(
            'inline-flex size-3.5 items-center justify-center rounded-full border',
            viewed
              ? 'border-emerald-600 bg-emerald-600 text-white'
              : 'border-current'
          )}
        >
          {viewed && <IconCheck size={9} />}
        </span>
        Viewed
      </button>
    </div>
  );
});

interface FileViewedCheckboxProps {
  viewed: boolean;
  onToggle(viewed: boolean): void;
}

// Whole-file "Viewed" checkbox in the file header, GitHub-style. Checking it
// marks every hunk viewed and collapses the file.
export const FileViewedCheckbox = memo(function FileViewedCheckbox({
  viewed,
  onToggle,
}: FileViewedCheckboxProps) {
  return (
    <label
      className="flex cursor-pointer items-center gap-1.5 pl-2 font-sans text-xs select-none"
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={viewed}
        className="size-3.5 cursor-pointer accent-emerald-600"
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
      Viewed
    </label>
  );
});
