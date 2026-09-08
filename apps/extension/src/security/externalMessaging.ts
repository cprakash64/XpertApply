const PRODUCTION_ORIGINS = new Set([
  "https://xpertapply.com",
  "https://www.xpertapply.com"
]);

const DEVELOPMENT_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000"
]);

/** Validate browser-attributed metadata for a top-level externally-connectable
 * Web sender. Payload-supplied identity is deliberately irrelevant. */
export function isApprovedExternalWebSender(
  sender: chrome.runtime.MessageSender,
  isUnpacked: boolean
): boolean {
  if (sender.id || !sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0) return false;
  if (!sender.origin || !sender.url) return false;
  try {
    const urlOrigin = new URL(sender.url).origin;
    if (urlOrigin !== sender.origin) return false;
    if (PRODUCTION_ORIGINS.has(urlOrigin)) return true;
    return isUnpacked && DEVELOPMENT_ORIGINS.has(urlOrigin);
  } catch {
    return false;
  }
}
