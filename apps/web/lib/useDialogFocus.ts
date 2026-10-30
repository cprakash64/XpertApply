"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const INTERACTIVE =
  'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

/**
 * The control the user last interacted with: the last real (non-<body>) element that received focus, or the control last
 * clicked or activated, whichever came later.
 *
 * Why two signals: a control that opens a dialog can be disabled while it works (a "Generating…" button), which drops focus to
 * <body> before the dialog mounts; and Safari/WebKit does not focus a <button> on a mouse click at all (its focus ring and
 * `document.activeElement` stay wherever they were, usually <body>), so `focusin` never fires for the control that opened the
 * dialog. The click is the one event every browser delivers to the real invoker.
 */
let lastInteracted: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target && target !== document.body) lastInteracted = target;
    },
    true
  );
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(INTERACTIVE) : null;
      if (target) lastInteracted = target;
    },
    true
  );
}

/** Focus `el` if it can take focus now; reports whether it did. */
function tryFocus(el: HTMLElement | null | undefined): boolean {
  if (!el?.isConnected) return false;
  el.focus?.();
  return document.activeElement === el;
}

/** Where focus goes when the invoker is gone or cannot take focus: the page's main landmark (a logical place), never <body>. */
function focusMainLandmark() {
  const main = document.querySelector<HTMLElement>("main");
  if (!main) return;
  if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
  main.focus({ preventScroll: true });
}

/**
 * Keyboard behaviour for a modal dialog.
 *
 * - Escape calls `onClose`.
 * - Focus moves into the dialog on open (the first control, or the element marked `data-autofocus`)
 *   and returns to the control that opened it when the dialog closes (the main landmark if that control is gone or disabled).
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
    // The invoker is whatever the user interacted with last (focus or click), not document.activeElement alone: in Safari a
    // mouse-opened dialog leaves activeElement on <body> or on an unrelated earlier control.
    const active = document.activeElement as HTMLElement | null;
    const opener = lastInteracted?.isConnected ? lastInteracted : active && active !== document.body ? active : null;
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
      // Restore focus to the invoker; if it was removed, re-rendered away or disabled, fall back to the main landmark.
      if (!tryFocus(opener)) focusMainLandmark();
    };
    // Runs once per open; the close handler is read through `closeRef`.
  }, [ref]);
}
