# Staging Chrome extension (XA-EXT-STAGING-01)

A separate build, `XpertApply (STAGING)`, for testing sign-in and direct applications against
`https://staging.xpertapply.com` and `https://api-staging.xpertapply.com`. It is not the store extension and must never
be uploaded to the Chrome Web Store. Nothing on this page has been run on the VPS.

| | Staging build | Production build |
|---|---|---|
| Output folder | `apps/extension/dist-staging` | `apps/extension/dist` |
| Name | `XpertApply (STAGING)` | `XpertApply — Assisted Apply` |
| Trusted website | `https://staging.xpertapply.com` only | `https://xpertapply.com`, `https://www.xpertapply.com` |
| Default and only API | `https://api-staging.xpertapply.com` | `https://api.xpertapply.com` |
| Host permissions | the two staging hosts above (replacing, not adding to, production's) | the three production hosts |
| Loopback trusted | no | no |
| Stored `apiBase` override | ignored unless it is exactly the staging API | legacy behaviour, unchanged |
| Extension id | pinned: `cglmdonbfbadfbggkpajpkjgpekhkall` | assigned by the Web Store (none pinned) |

All other permissions are identical to production (`activeTab`, `identity`, `sidePanel`, `storage`, `scripting`, `tabs`,
and the optional per-site `https://*/*`). No `<all_urls>` or broad host permission is added.

## 1. Build (on the Mac)
```bash
cd /Users/cprakash/Developer/XpertApply-core1/apps/extension      # branch feature/xa-core1-direct-autofill
npm run build:staging > /tmp/xa-staging-build.log 2>&1; echo exit=$?   # do not pipe into `head`: it truncates the build
grep -E '"name"|"version_name"' dist-staging/manifest.json
```
Output: `apps/extension/dist-staging/`. `version_name` ends with `; staging)` and names the commit.

## 2. The extension id
The id is pinned by the public `key` in the staging manifest (`src/staging-extension-key.mjs`). Chrome derives the id from
that key: the first 128 bits of the SHA-256 of the DER public key, each hex digit mapped `0-f` to `a-p`. The private half of
that key pair was discarded when it was created; nothing needs it, and none is in the repository.

**Verified:** the derivation is unit-tested, and Chromium loading `dist-staging` reported
`chrome.runtime.id = cglmdonbfbadfbggkpajpkjgpekhkall`. **Still to confirm by hand in desktop Chrome** (below).

## 3. Install in Chrome (use a dedicated test profile)
1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → choose
   `/Users/cprakash/Developer/XpertApply-core1/apps/extension/dist-staging`.
2. The card must read **XpertApply (STAGING)** and show ID `cglmdonbfbadfbggkpajpkjgpekhkall`. Any other id means the folder
   or the `key` is wrong: do not continue.
3. Click **service worker** on the card and run, in its console:
   ```js
   chrome.runtime.id                              // cglmdonbfbadfbggkpajpkjgpekhkall
   chrome.identity.getRedirectURL("xpertapply")   // https://cglmdonbfbadfbggkpajpkjgpekhkall.chromiumapp.org/xpertapply
   chrome.runtime.getManifest().host_permissions  // exactly the two staging hosts
   ```
   The backend accepts a redirect only when it has this shape *and* the id is in its allowlist.

## 4. Allow the id on the staging API
The staging API reads `EXTENSION_ALLOWED_IDS` (a JSON list, 1 to 5 exact ids) from its environment at start-up. Do not add
wildcards and do not add the production id. Required value:
```
EXTENSION_ALLOWED_IDS=["cglmdonbfbadfbggkpajpkjgpekhkall"]
```
Where it lives now: the staging checkout is `/home/xpertapply/apps/staging` and the protected deployment is
`/opt/xpertapply-staging-control`. **I have not inspected either**, so the exact environment file name and the supported way
to apply a change are for you to confirm from the protected deployment's own procedure. Do not hand-edit files under
`/opt/xpertapply-staging-control` unless that procedure says to. After the change the API container must be recreated (an
environment change is not picked up by a plain restart of a running process), then:
```bash
curl -fsS http://127.0.0.1:8021/healthz
```
The staging **web** build also needs the id so the site can address the extension: set
`NEXT_PUBLIC_CHROME_EXTENSION_ID=cglmdonbfbadfbggkpajpkjgpekhkall` in its build environment (read by `apps/web/lib/siteConfig.ts`).

Negative check (safe, with a staging test user's website token): a code request carrying a different extension id's
redirect must return 400.

## 5. Revert staging without touching production
* Chrome: remove the **XpertApply (STAGING)** card at `chrome://extensions`. The production extension (a different id and
  folder) and the production site are unaffected.
* Staging API: restore the previous `EXTENSION_ALLOWED_IDS` through the same procedure and recreate the API container.
* Staging credentials: Disconnect in the assistant (revokes server-side), or revoke rows in the staging database only.
* Nothing in this build writes to or reads from production: it has no host permission for it.

## 6. Not yet tested
Chrome's native sign-in window and the real `staging.xpertapply.com` round trip have not been run. The automated browser
tests replace only that native window, against a local website and API; they cannot exercise the staging hostnames.
