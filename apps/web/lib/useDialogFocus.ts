"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The last real (non-<body>) element that had focus. A control that opens a dialog can be disabled
 * while it works (a "Generating…" button), which drops focus to <body> before the dialog mounts;
 * this lets the dialog still return focus to that control when it closes.
 */
let lastFocused: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target && target !== document.body) lastFocused = target;
    },
    true
  );
}

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
  // Escape must run the CURRENT close handler, not the one from the render that opened the dialog: a handler that reads
  // state (the filters the list is showing, for instance) would otherwise act on stale values.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const opener = active && active !== document.body ? active : lastFocused;
    const root = ref.current;
    const first = root?.querySelector<HTMLElement>("[data-autofocus]") ?? root?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
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
      if (opener?.isConnected) opener.focus?.();
    };
    // Runs once per open; the close handler is read through `closeRef`.
  }, [ref]);
}
