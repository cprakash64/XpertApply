import { afterEach } from "vitest";
import { resetFieldStatusPresentation } from "../fields/statusPresentation";

/**
 * A Vitest worker can execute many jsdom files while production modules remain
 * cached. Dispose the extension-owned presentation singleton before Vitest
 * tears down or replaces the owning Window; otherwise an observer-scheduled
 * callback can reach cleanup after that Window wrapper is no longer usable.
 */
afterEach(() => {
  resetFieldStatusPresentation();
});
