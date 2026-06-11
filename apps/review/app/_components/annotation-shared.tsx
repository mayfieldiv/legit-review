// Shared pieces used by the draft and saved comment cards.

import { cn } from '@/lib/utils';

// Compact GitHub-style relative timestamp ("just now", "5m ago", "2d ago")
// for thread headers. Renders once per state refresh and doesn't tick.
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  const months = Math.round(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  return `${Math.round(months / 12)}y ago`;
}

export const annotationCardBase =
  'm-2 flex max-w-[600px] gap-2.5 rounded-xl border border-[var(--diffshub-annotation-border,var(--color-border))] bg-[var(--diffshub-annotation-bg,var(--color-card))] bg-clip-padding p-3 font-sans text-[var(--diffshub-annotation-fg,var(--color-card-foreground))] shadow-[var(--diffshub-annotation-shadow,0_2px_4px_rgb(0_0_0_/_0.025),0_4px_8px_rgb(0_0_0_/_0.025))]';

// Deterministic accent per author name so "user" and each agent get stable,
// distinguishable monogram colors.
const AUTHOR_COLORS = [
  'bg-blue-500',
  'bg-emerald-600',
  'bg-violet-500',
  'bg-amber-600',
  'bg-rose-500',
  'bg-cyan-600',
] as const;

function authorColor(author: string): string {
  let hash = 5381;
  for (let i = 0; i < author.length; i++) {
    hash = ((hash << 5) + hash + author.charCodeAt(i)) >>> 0;
  }
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length] as string;
}

interface CommentAuthorBadgeProps {
  author: string;
  className?: string;
}

// Monogram circle for a comment author ('user', 'claude', …).
// Defaults to 32px (size-8); pass className to override for other sizes.
export function CommentAuthorBadge({
  author,
  className,
}: CommentAuthorBadgeProps) {
  const firstChar = author.slice(0, 1).toUpperCase();
  const initial = firstChar === '' ? '?' : firstChar;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white',
        authorColor(author),
        className
      )}
    >
      {initial}
    </span>
  );
}
