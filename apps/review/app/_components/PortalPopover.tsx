'use client';

import { type ReactNode, type RefObject, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface PortalPopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose(): void;
  align?: 'start' | 'end';
  // Panel width in px; also used to keep the panel on-screen when right-aligned.
  width: number;
  className?: string;
  children: ReactNode;
}

// Renders popover content into document.body so it escapes ancestor clipping
// and stacking. The diff header sets `contain: paint` and its own stacking
// context, which would otherwise clip/occlude a normally-positioned dropdown —
// the same reason Radix menus portal. Positioned fixed under the anchor and
// re-measured on scroll/resize. Outside-click and Escape close it; clicks
// inside any [data-review-popover] count as inside, so a nested picker doesn't
// dismiss the popover that contains it.
export function PortalPopover({
  anchorRef,
  open,
  onClose,
  align = 'start',
  width,
  className,
  children,
}: PortalPopoverProps) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null
  );

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const anchor = anchorRef.current;
    if (anchor == null) {
      return;
    }
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const left =
        align === 'end'
          ? Math.max(8, rect.right - width)
          : Math.min(rect.left, window.innerWidth - width - 8);
      setCoords({ top: rect.bottom + 4, left: Math.max(8, left) });
    };
    update();
    // `true` captures scrolls in any nested container (the diff scroll area),
    // not just the window, so the panel tracks the anchor.
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, anchorRef, align, width]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (anchorRef.current?.contains(target) === true) {
        return;
      }
      if (
        target instanceof Element &&
        target.closest('[data-review-popover]') != null
      ) {
        return;
      }
      onClose();
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeydown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeydown);
    };
  }, [open, anchorRef, onClose]);

  if (!open || coords == null || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      data-review-popover=""
      style={{ position: 'fixed', top: coords.top, left: coords.left, width }}
      className={className}
    >
      {children}
    </div>,
    document.body
  );
}
