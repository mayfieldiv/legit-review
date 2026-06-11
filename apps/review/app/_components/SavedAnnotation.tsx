import type { CodeViewLineSelection } from '@pierre/diffs';
import {
  IconArrowRight,
  IconCheck,
  IconChevronSm,
  IconPencil,
  IconTrash,
} from '@pierre/icons';
import {
  type FormEvent,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  annotationCardBase,
  CommentAuthorBadge,
  formatRelativeTime,
} from './annotation-shared';
import type { CommentAnnotation, SavedCommentMetadata } from './types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const threadBorder =
  'border-[var(--diffshub-annotation-border,var(--color-border))]';
const mutedText =
  'text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))]';

interface SavedAnnotationProps {
  annotation: CommentAnnotation<SavedCommentMetadata>;
  itemId: string;
  onDelete(itemId: string, key: string): void;
  // Thread mutations resolve false on failure so editors keep their text;
  // on success the container refreshes review state and new metadata flows
  // back in through the annotation.
  onDeleteReply(key: string, replyId: string): Promise<boolean>;
  onEditComment(key: string, message: string): Promise<boolean>;
  onEditReply(key: string, replyId: string, message: string): Promise<boolean>;
  onReply(key: string, message: string): Promise<boolean>;
  onToggleResolved(itemId: string, key: string, resolved: boolean): void;
  onToggleSelection(selection: CodeViewLineSelection): void;
}

// Persisted review thread, GitHub-style: the root comment plus replies,
// inline resolution events, a reply composer, and a Resolve/Unresolve footer.
// Resolved threads default collapsed; unresolved threads default expanded.
export const SavedAnnotation = memo(function SavedAnnotation({
  annotation,
  itemId,
  onDelete,
  onDeleteReply,
  onEditComment,
  onEditReply,
  onReply,
  onToggleResolved,
  onToggleSelection,
}: SavedAnnotationProps) {
  const { metadata } = annotation;
  const selection = { id: itemId, range: metadata.range };
  const visibleReplies = metadata.replies.filter(isVisibleThreadEntry);
  const [collapsed, setCollapsed] = useState(metadata.resolved);
  const previousResolved = useRef(metadata.resolved);

  useEffect(() => {
    if (previousResolved.current === metadata.resolved) {
      return;
    }
    previousResolved.current = metadata.resolved;
    setCollapsed(metadata.resolved);
  }, [metadata.resolved]);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      className={cn(
        annotationCardBase,
        'group flex-col gap-0 p-0 cursor-pointer hover:border-[var(--diffshub-annotation-hover-border,var(--diffshub-annotation-border,var(--color-border)))]',
        metadata.resolved && 'opacity-60 hover:opacity-100'
      )}
      onClick={() => onToggleSelection(selection)}
      onKeyDown={(event) => {
        // Only react to keys on the card itself: textareas and buttons in
        // the thread bubble their keydowns up here.
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        event.preventDefault();
        onToggleSelection(selection);
      }}
    >
      <ThreadHeader
        collapsed={collapsed}
        range={metadata.range}
        replyCount={visibleReplies.length}
        resolved={metadata.resolved}
        outdated={metadata.outdated}
        onToggle={() => setCollapsed((value) => !value)}
      />
      {!collapsed && (
        <>
          <ThreadMessage
            author={metadata.author}
            createdAt={metadata.createdAt}
            message={metadata.message}
            kind="comment"
            badges={
              metadata.outdated ? (
                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  Outdated
                </span>
              ) : null
            }
            onSaveEdit={(message) => onEditComment(metadata.key, message)}
            onDelete={() => {
              if (
                metadata.replies.length > 0 &&
                !window.confirm(
                  `Delete this thread? Its ${metadata.replies.length === 1 ? 'reply' : `${metadata.replies.length} replies`} will be deleted too.`
                )
              ) {
                return;
              }
              onDelete(itemId, metadata.key);
            }}
          />
          {visibleReplies.map((reply) =>
            reply.kind === 'resolution' ? (
              <ThreadMessage
                key={reply.id}
                author={reply.author}
                createdAt={reply.createdAt}
                message={reply.message}
                kind="resolution"
                leading={
                  <span
                    aria-label="Resolution note"
                    title="Resolution note"
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-600/15 text-emerald-600 dark:text-emerald-400"
                  >
                    <IconCheck size={13} />
                  </span>
                }
                onSaveEdit={(message) =>
                  onEditReply(metadata.key, reply.id, message)
                }
                onDelete={() => void onDeleteReply(metadata.key, reply.id)}
              />
            ) : (
              <ThreadMessage
                key={reply.id}
                author={reply.author}
                createdAt={reply.createdAt}
                message={reply.message}
                kind="reply"
                onSaveEdit={(message) =>
                  onEditReply(metadata.key, reply.id, message)
                }
                onDelete={() => void onDeleteReply(metadata.key, reply.id)}
              />
            )
          )}
          <ReplyComposer
            onReply={(message) => onReply(metadata.key, message)}
          />
          <ThreadFooter
            resolved={metadata.resolved}
            onToggleResolved={() =>
              onToggleResolved(itemId, metadata.key, !metadata.resolved)
            }
          />
        </>
      )}
    </div>
  );
});

function isVisibleThreadEntry(
  reply: SavedCommentMetadata['replies'][number]
): boolean {
  return reply.kind === 'reply' || reply.message.trim() !== '';
}

interface ThreadHeaderProps {
  collapsed: boolean;
  range: SavedCommentMetadata['range'];
  replyCount: number;
  resolved: boolean;
  outdated: boolean;
  onToggle(): void;
}

function ThreadHeader({
  collapsed,
  range,
  replyCount,
  resolved,
  outdated,
  onToggle,
}: ThreadHeaderProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 px-2.5 py-2 text-[12px]',
        !collapsed && cn('border-b', threadBorder)
      )}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand thread' : 'Collapse thread'}
        title={collapsed ? 'Expand thread' : 'Collapse thread'}
        className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm transition"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
      >
        <IconChevronSm
          aria-hidden="true"
          className={cn(
            'size-4 transition-transform',
            collapsed && '-rotate-90'
          )}
        />
      </button>
      <span className="min-w-0 flex-1 truncate font-medium">
        Comment on {formatThreadRange(range)}
      </span>
      {replyCount > 0 && (
        <span className={cn('shrink-0', mutedText)}>
          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        </span>
      )}
      {outdated && (
        <span className="inline-flex shrink-0 items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          Outdated
        </span>
      )}
      {!resolved && (
        <span className="inline-flex shrink-0 items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
          Unresolved
        </span>
      )}
    </div>
  );
}

function formatThreadRange(range: SavedCommentMetadata['range']): string {
  const start = formatRangeEndpoint(range.start, range.side);
  const end = formatRangeEndpoint(range.end, range.endSide ?? range.side);
  if (range.start === range.end && start === end) {
    return `line ${end}`;
  }
  return `lines ${start} to ${end}`;
}

function formatRangeEndpoint(
  lineNumber: number,
  side: SavedCommentMetadata['range']['side']
): string {
  if (side === 'additions') {
    return `R${lineNumber}`;
  }
  if (side === 'deletions') {
    return `L${lineNumber}`;
  }
  return `${lineNumber}`;
}

interface ThreadFooterProps {
  resolved: boolean;
  onToggleResolved(): void;
}

function ThreadFooter({ resolved, onToggleResolved }: ThreadFooterProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t px-3 py-2',
        threadBorder
      )}
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="font-medium"
        onClick={onToggleResolved}
      >
        {resolved ? 'Unresolve conversation' : 'Resolve conversation'}
      </Button>
    </div>
  );
}

interface ThreadMessageProps {
  author: string;
  createdAt: string;
  message: string;
  kind: 'comment' | 'reply' | 'resolution';
  badges?: ReactNode;
  leading?: ReactNode;
  onDelete(): void;
  onSaveEdit(message: string): Promise<boolean>;
}

// One message in a thread (the root comment or a reply): author header with
// hover-revealed edit/delete actions, and an in-place editor that keeps its
// text when saving fails.
function ThreadMessage({
  author,
  createdAt,
  message,
  kind,
  badges,
  leading,
  onDelete,
  onSaveEdit,
}: ThreadMessageProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const trimmedDraft = draft.trim();
  const actionLabel = kind === 'resolution' ? 'resolution note' : kind;

  async function handleSave() {
    if (trimmedDraft.length === 0 || saving) {
      return;
    }
    if (trimmedDraft === message) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      if (await onSaveEdit(trimmedDraft)) {
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className={cn(
        'group/row flex flex-col px-3 py-2.5',
        kind !== 'comment' && cn('border-t', threadBorder)
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {leading ?? (
          <CommentAuthorBadge author={author} className="size-6 text-xs" />
        )}
        <strong className="truncate text-[13px]">{author}</strong>
        <span className={cn('shrink-0 text-[12px]', mutedText)}>
          {formatRelativeTime(createdAt)}
        </span>
        {badges}
        {!editing && (
          <span className="ml-auto flex shrink-0 gap-1 opacity-0 transition-opacity duration-100 group-hover/row:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Edit ${actionLabel}`}
              title="Edit"
              className="pointer-events-none group-hover/row:pointer-events-auto"
              onClick={(event) => {
                event.stopPropagation();
                setDraft(message);
                setEditing(true);
              }}
            >
              <IconPencil size={12} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${actionLabel}`}
              title="Delete"
              className="pointer-events-none group-hover/row:pointer-events-auto"
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
            >
              <IconTrash size={12} />
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <form
          className="flex flex-col gap-2 pt-2 pl-8"
          onClick={(event) => event.stopPropagation()}
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <ThreadTextarea
            value={draft}
            onChange={setDraft}
            onCancel={() => setEditing(false)}
            onSubmit={() => void handleSave()}
            className={cn('rounded-md border px-2', threadBorder)}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="muted"
              size="xs"
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="xs"
              disabled={trimmedDraft.length === 0 || saving}
              className="bg-blue-500 text-white hover:bg-blue-600"
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      ) : (
        <p className="m-0 pl-8 text-[14px] whitespace-pre-wrap">{message}</p>
      )}
    </div>
  );
}

interface ReplyComposerProps {
  onReply(message: string): Promise<boolean>;
}

function ReplyComposer({ onReply }: ReplyComposerProps) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const trimmedMessage = message.trim();

  async function handleSend() {
    if (trimmedMessage.length === 0 || sending) {
      return;
    }
    setSending(true);
    try {
      if (await onReply(trimmedMessage)) {
        setMessage('');
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className={cn('flex items-start gap-2 border-t px-3 py-2', threadBorder)}
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSend();
      }}
    >
      <CommentAuthorBadge author="user" className="size-6 text-xs" />
      <ThreadTextarea
        autoFocusInput={false}
        value={message}
        placeholder="Reply…"
        onChange={setMessage}
        onCancel={() => setMessage('')}
        onSubmit={() => void handleSend()}
        className="py-0.5"
      />
      {trimmedMessage.length > 0 && (
        <Button
          type="submit"
          size="icon-sm"
          disabled={sending}
          aria-label="Submit reply"
          className="mt-0.5 shrink-0 rounded-full bg-blue-500 hover:bg-blue-600"
        >
          <IconArrowRight className="size-3 rotate-[-90deg]" />
        </Button>
      )}
    </form>
  );
}

interface ThreadTextareaProps {
  value: string;
  placeholder?: string;
  autoFocusInput?: boolean;
  className?: string;
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(): void;
}

// Auto-sizing textarea with the draft card's keyboard conventions: Escape
// cancels, Shift/Cmd+Enter submits. Focus uses preventScroll because the
// card lives inside the viewer's virtualized scroll container.
function ThreadTextarea({
  value,
  placeholder,
  autoFocusInput = true,
  className,
  onCancel,
  onChange,
  onSubmit,
}: ThreadTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocusInput) {
      return;
    }
    const textarea = textareaRef.current;
    if (textarea == null) {
      return;
    }
    textarea.focus({ preventScroll: true });
    const cursorIndex = textarea.value.length;
    textarea.setSelectionRange(cursorIndex, cursorIndex);
  }, [autoFocusInput]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
      return;
    }
    if ((!event.shiftKey && !event.metaKey) || event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    onSubmit();
  }

  function handleChange(event: FormEvent<HTMLTextAreaElement>) {
    onChange(event.currentTarget.value);
  }

  return (
    <textarea
      ref={textareaRef}
      value={value}
      rows={1}
      placeholder={placeholder}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      className={cn(
        'field-sizing-content w-full resize-none rounded-sm bg-transparent py-1 text-[14px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:outline-none',
        className
      )}
    />
  );
}
