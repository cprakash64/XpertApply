import { expect, type BrowserContext } from "@playwright/test";

/** Install before navigation/bootstrap; unmatched synthetic endpoints never
 * fall through to an external server. Store only origin/path/method. */
export async function containSyntheticNetwork(context: BrowserContext) {
  const blocked: { origin: string; path: string; method: string }[] = [];
  const externalResponses: string[] = [];
  context.on("response", response => {
    const url = new URL(response.url());
    if (["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname)) externalResponses.push(url.origin + url.pathname);
  });
  await context.route("**/*", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && !["localhost", "127.0.0.1"].includes(url.hostname)) {
      blocked.push({ origin: url.origin, path: url.pathname, method: request.method() });
      await route.abort("blockedbyclient"); return;
    }
    await route.continue();
  });
  return { blocked, externalResponses, assertContained() {
    expect(externalResponses, "external network responses").toEqual([]);
    expect(blocked, "unexpected attempted external egress").toEqual([]);
  } };
}
