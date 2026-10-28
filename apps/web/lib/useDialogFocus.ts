"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour for a modal dialog.
 *
 * - Escape calls `onClose`.
 * - Focus moves into the dialog on open (the first control, or the element marked `data-autofocus`)
 *   and returns to whatever had it when the dialog closes.
 * - Tab and Shift+Tab wrap inside the dialog instead of leaving it.
 *
 * The listener is on `document` so a keystroke still lands while focus is momentarily on <body>.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const first = root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || !ref.current.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || !ref.current.contains(active))) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus?.();
    };
    // Runs once per open: `onClose` is read through the latest render only for the Escape path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
