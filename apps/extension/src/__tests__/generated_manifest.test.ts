/**
 * Section C — the PRODUCTION manifest must reach the live Greenhouse frame.
 *
 * This reads dist/manifest.json, not manifest.json: the generated artifact is
 * what Chrome actually loads, and a build step could in principle rewrite it.
 * A stale or mis-scoped generated manifest would mean the content script never
 * runs inside iframe#grnhse_iframe, and no amount of coordinator logic could
 * help.
 *
 * Skips (rather than fails) when dist/ has not been built, so `npm test` on a
 * clean checkout is not blocked; CI runs `npm run build` first.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST_MANIFEST = path.join(here, "..", "..", "dist", "manifest.json");

/** The confirmed live application frame URL. */
const GREENHOUSE_IFRAME_URL =
  "https://job-boards.greenhouse.io/embed/job_app?for=airbnb&token=REDACTED";
const AIRBNB_CAREERS_URL = "https://careers.airbnb.com/positions/8070597/";

/** Minimal Chrome match-pattern matcher (scheme/host/path). */
function matchPatternMatches(pattern: string, url: string): boolean {
  if (pattern === "<all_urls>") return true;
  const parsed = /^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!parsed) return false;
  const [, scheme, host, pathGlob] = parsed;

  const target = new URL(url);
  const targetScheme = target.protocol.replace(":", "");
  if (scheme !== "*" && scheme !== targetScheme) return false;
  if (scheme === "*" && !["http", "https"].includes(targetScheme)) return false;

  if (host !== "*") {
    if (host.startsWith("*.")) {
      const bare = host.slice(2);
      if (target.hostname !== bare && !target.hostname.endsWith(`.${bare}`)) return false;
    } else if (host !== target.hostname) {
      return false;
    }
  }

  const pathRe = new RegExp(
    "^" + pathGlob.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
  );
  return pathRe.test(target.pathname + target.search);
}

const distExists = existsSync(DIST_MANIFEST);
const manifest = distExists ? JSON.parse(readFileSync(DIST_MANIFEST, "utf-8")) : null;

describe.skipIf(!distExists)("generated dist/manifest.json", () => {
  it("is Manifest V3", () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it("carries a build identity so a stale load is detectable", () => {
    expect(manifest.version).toBeTruthy();
    expect(manifest.version_name, "build.mjs must stamp version_name").toMatch(/\(.+\)/);
  });

  // XA-06 (Stage 3C). These four assertions used to require that the SHIPPED
  // manifest already reached the live Greenhouse frame — a static content
  // script matching every https page in every frame, plus a wildcard host
  // permission. That is the finding, not the feature: it gave XpertApply
  // authority over every site the user visits from the moment of install.
  //
  // The product requirement behind them is unchanged and still asserted: the
  // live Greenhouse application frame, and the carrier page that embeds it,
  // must remain reachable. They are now reachable by ASKING — an optional host
  // pattern the user can grant for that one origin, and programmatic injection
  // once they have.

  it("does not reach the live Greenhouse frame until the user grants it", () => {
    const matching = (manifest.content_scripts ?? []).filter((cs: { matches: string[]; exclude_matches?: string[] }) => {
      const included = cs.matches.some((m) => matchPatternMatches(m, GREENHOUSE_IFRAME_URL));
      const excluded = (cs.exclude_matches ?? []).some((m) => matchPatternMatches(m, GREENHOUSE_IFRAME_URL));
      return included && !excluded;
    });
    expect(matching.length, "no employer frame may be scripted at install time").toBe(0);
    expect(
      (manifest.host_permissions ?? []).some((p: string) => matchPatternMatches(p, GREENHOUSE_IFRAME_URL)),
      "no install-time host authority over an employer/ATS origin"
    ).toBe(false);
  });

  it("can still be granted the live Greenhouse frame, and inject into it", () => {
    // The capability is retained: the origin is coverable by an optional
    // pattern the side panel can request…
    expect(
      (manifest.optional_host_permissions ?? []).some((p: string) => matchPatternMatches(p, GREENHOUSE_IFRAME_URL)),
      "the Greenhouse frame origin must be grantable"
    ).toBe(true);
    // …and `scripting` is what turns that grant into a content script in the
    // frame, so it is load-bearing rather than vestigial.
    expect(manifest.permissions ?? []).toContain("scripting");
  });

  it("treats the Airbnb carrier page the same way", () => {
    const staticMatch = (manifest.content_scripts ?? []).some((cs: { matches: string[] }) =>
      cs.matches.some((m) => matchPatternMatches(m, AIRBNB_CAREERS_URL))
    );
    expect(staticMatch, "the carrier page is not scripted at install time").toBe(false);
    expect(
      (manifest.optional_host_permissions ?? []).some((p: string) => matchPatternMatches(p, AIRBNB_CAREERS_URL)),
      "the carrier page must be grantable"
    ).toBe(true);
  });

  it("does not request browsing-history permissions", () => {
    const permissions: string[] = manifest.permissions ?? [];
    expect(permissions).not.toContain("webNavigation");
    expect(permissions).not.toContain("history");
  });

  it("references only files that exist in dist/", () => {
    for (const cs of manifest.content_scripts ?? []) {
      for (const file of cs.js ?? []) {
        expect(existsSync(path.join(here, "..", "..", "dist", file)), `${file} missing`).toBe(true);
      }
    }
  });
});

describe.skipIf(!distExists)("built content bundle", () => {
  const bundle = distExists
    ? readFileSync(path.join(here, "..", "..", "dist", "content.js"), "utf-8")
    : "";

  it("contains the activation coordinator, not just the source tree", () => {
    // Proves the shipped artifact — not merely the repo — carries the fix.
    expect(bundle).toContain("switch to (the )?application");
    expect(bundle).toContain("accessible_name_switches_to_application_form");
  });

  it("contains the document-level root fallback", () => {
    expect(bundle).toContain("document_fallback");
  });
});
