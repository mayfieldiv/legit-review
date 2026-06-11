import { IconArrowRight } from '@pierre/icons';
import { useEffect, useRef, useState } from 'react';

import { annotationCardBase, CommentAuthorBadge } from './annotation-shared';
import type { CommentAnnotation, DraftCommentMetadata } from './types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DraftAnnotationProps {
  annotation: CommentAnnotation<DraftCommentMetadata>;
  itemId: string;
  onCancel(itemId: string, key: string): void;
  // Persists the comment; resolves false when saving failed (the draft stays
  // open so the text isn't lost).
  onSave(itemId: string, key: string, message: string): Promise<boolean>;
}

export function DraftAnnotation({
  annotation,
  itemId,
  onCancel,
  onSave,
}: DraftAnnotationProps) {
  const [message, setMessage] = useState(annotation.metadata.message);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmedMessage = message.trim();

  async function handleSave() {
    if (trimmedMessage.length === 0 || saving) {
      return;
    }
    setSaving(true);
    try {
      await onSave(itemId, annotation.metadata.key, trimmedMessage);
    } finally {
      setSaving(false);
    }
  }

  function tryCancel() {
    if (trimmedMessage.length > 0 && !window.confirm('Discard this comment?')) {
      return;
    }
    onCancel(itemId, annotation.metadata.key);
  }

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea == null) {
      return;
    }

    textarea.focus({ preventScroll: true });
    const cursorIndex = textarea.value.length;
    textarea.setSelectionRange(cursorIndex, cursorIndex);
  }, []);

  return (
    <form
      className={cn(annotationCardBase, 'flex-col md:flex-row')}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSave();
      }}
    >
      <div className="flex w-full gap-2.5">
        <CommentAuthorBadge author="user" />
        <textarea
          ref={textareaRef}
          value={message}
          onChange={({ currentTarget }) => setMessage(currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              tryCancel();
              return;
            }

            if ((!event.shiftKey && !event.metaKey) || event.key !== 'Enter') {
              return;
            }

            event.preventDefault();
            void handleSave();
          }}
          placeholder="Add a comment…"
          rows={2}
          className="field-sizing-content w-full resize-none rounded-sm bg-transparent py-1.5 text-[14px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:outline-none"
        />
      </div>
      <div className="flex w-full justify-between gap-3 pl-10.5 md:w-auto md:justify-end md:pl-0">
        <Button
          type="button"
          variant="muted"
          onClick={tryCancel}
          className="text-muted-foreground hover:text-foreground gap-1 font-normal hover:no-underline md:hidden"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="default"
          size="icon-md"
          disabled={trimmedMessage.length === 0 || saving}
          className="hidden rounded-full bg-blue-500 hover:bg-blue-600 md:flex"
        >
          <IconArrowRight className="size-4 rotate-[-90deg]" />
        </Button>
        <Button
          type="submit"
          variant="default"
          disabled={trimmedMessage.length === 0 || saving}
          className="gap-1.5 bg-blue-500 hover:bg-blue-600 md:hidden"
        >
          {saving ? 'Saving…' : 'Submit'}
          <IconArrowRight className="-mr-0.5 size-3" />
        </Button>
      </div>
    </form>
  );
}
