/**
 * Per-profile manifest generation, kept pure so it can be unit-tested without running a build.
 *
 * Production, development and e2e keep the source manifest's hosts unchanged. Staging REPLACES the production hosts
 * (it does not add to them): the staging build holds host access to the staging website and staging API only.
 * Everything else, including every permission, the optional per-site grant and the web-accessible resources, is
 * carried over untouched.
 */
import { bridgeMatchPatternsForProfile } from "./bridge-origin-profiles.mjs";
import { DEVELOPMENT_BRIDGE_ORIGINS } from "./development-bridge-origins.mjs";
import { STAGING_API_ORIGIN, STAGING_WEB_ORIGIN } from "./staging-origins.mjs";
import { STAGING_EXTENSION_PUBLIC_KEY } from "./staging-extension-key.mjs";

export function manifestForProfile(sourceManifest, profile, versionName) {
  const loopbackProfile = profile === "development" || profile === "e2e";
  const generated = {
    ...sourceManifest,
    version_name: versionName,
    content_scripts: sourceManifest.content_scripts.map((entry, index) => index === 0
      ? { ...entry, matches: bridgeMatchPatternsForProfile(profile) }
      : { ...entry }),
    optional_host_permissions: loopbackProfile
      ? [...new Set([
          ...(sourceManifest.optional_host_permissions ?? []),
          ...DEVELOPMENT_BRIDGE_ORIGINS.map((origin) => `${new URL(origin).protocol}//${new URL(origin).hostname}/*`)
        ])]
      : [...(sourceManifest.optional_host_permissions ?? [])]
  };
  if (profile === "staging") {
    generated.name = "XpertApply (STAGING)";
    generated.short_name = "XpertApply STG";
    generated.description = `STAGING BUILD for testing against ${STAGING_WEB_ORIGIN}. Not the production extension. ${sourceManifest.description}`;
    generated.action = { ...sourceManifest.action, default_title: "XpertApply (STAGING)" };
    generated.key = STAGING_EXTENSION_PUBLIC_KEY;
    generated.host_permissions = [`${STAGING_API_ORIGIN}/*`, `${STAGING_WEB_ORIGIN}/*`];
    generated.externally_connectable = { ...sourceManifest.externally_connectable, matches: [`${STAGING_WEB_ORIGIN}/*`] };
  }
  return generated;
}
