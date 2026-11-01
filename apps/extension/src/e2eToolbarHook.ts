import { showToolbarOverlay } from "./toolbarOverlay";

/**
 * e2e profile only (build.mjs injects this file into the worker bundle for
 * --profile e2e and nothing else). Playwright cannot press Chrome's toolbar
 * button, so this exposes the exact function chrome.action.onClicked calls.
 * Production builds never contain it.
 */
(globalThis as Record<string, unknown>).__xaToolbarClick = showToolbarOverlay;
