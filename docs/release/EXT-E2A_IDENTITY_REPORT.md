# EXT-E2 Phase A: staging extension identity preflight

Status: **identity verified in Chrome for Testing 149 (Playwright), NOT in the founder's desktop Chrome.** No account created, nothing connected, no job page opened, nothing pushed or deployed. Production NO-GO.

## 1. Source and artifact
- Source `6458b2d616a2c46e4e5058885c77096167ebb8c4` (`feature/xa-core1-direct-autofill`), exported with `git archive` into the session scratchpad (335 files). The canonical repository, branches and worktrees were not touched.
- `npm ci` then `npm run build:staging` succeeded: `v0.3.0 build nogit-3a9aaee`, the same content fingerprint as the E1 build, so the sources are unchanged.
- Artifact: `.../scratchpad/e2a/src/apps/extension/dist-staging` (scratch, not in Git, not packaged). `version_name`: `0.3.0 (nogit-3a9aaee 2026-10-30T19:49:14.946Z; staging)` (the timestamp changes per build; the content id does not).

## 2. Manifest (generated)
Version 0.3.0; name `XpertApply (STAGING)`; permissions `activeTab, identity, sidePanel, storage, scripting, tabs`; host permissions exactly `https://api-staging.xpertapply.com/*` and `https://staging.xpertapply.com/*`; optional `https://*/*` (per-site grant only); `externally_connectable` and the content script match `https://staging.xpertapply.com/*` only; no CSP override; `key` present. No production host appears anywhere in the manifest. In the bundles the default API is `true ? staging : production`, so the production literal is a dead branch. Re-derived ID from the manifest key: `cglmdonbfbadfbggkpajpkjgpekhkall`.

## 3. Actual extension ID (loaded unpacked, fresh profile)
Loaded with `--load-extension` into a new empty user-data directory in Chrome for Testing 149.0.7827.55, then read two ways: `chrome.runtime.id` in the service worker, and the card on `chrome://extensions` (extensions-manager DOM). Both: **`cglmdonbfbadfbggkpajpkjgpekhkall`, exact match.** Card: `XpertApply (STAGING)`, ENABLED, location UNPACKED, 0 runtime errors, 0 manifest errors. `chrome.identity.getRedirectURL` returns `https://cglmdonbfbadfbggkpajpkjgpekhkall.chromiumapp.org/xpertapply`.

## 4. Service worker and network
Worker started and stayed alive through the observation window; the only log line was `service worker active`; no page or worker errors; extension storage empty (nothing configured, no credential). I started the browser with every hostname forced to fail DNS, so nothing could leave this machine, and recorded request attempts: **0 non-extension requests, 0 failed requests, 0 requests of any kind to any host, production or staging.** Initialization makes no network call.

## 5. Backend `EXTENSION_ALLOWED_IDS`
Implementation: `extension_allowed_ids: list[str] = []` in pydantic-settings; a list field is read from the environment as JSON. `_redirect_allowed` lower-cases the allowlist entries and compares the id exactly. Existing tests monkeypatch the Python list and never parse an environment value, so I tested the real path (environment string, `Settings`, `_redirect_allowed`, API code at the staging lineage):

| Environment value | Parsed | Chosen ID | Other ID | Stranger |
|---|---|---|---|---|
| `["cglmdon…"]` (staging format), also with surrounding spaces | exactly one ID | allowed | rejected | rejected |
| two IDs | two IDs | allowed | the second allowed | rejected |
| bare ID or comma list | startup error (fails closed) | | | |
| `[]` or unset, production | empty | rejected | rejected | rejected |
| `[]` or unset, non-production | empty | **all accepted** | | |
| uppercase ID | stored as given | allowed (entries are lower-cased when compared) | rejected | rejected |

Conclusion: the JSON value `["cglmdonbfbadfbggkpajpkjgpekhkall"]` represents exactly one allowed ID at runtime. Compose passes it through unchanged (`docker compose config` with a temp env file renders `EXTENSION_ALLOWED_IDS: '["cglm…"]'`, `APP_ENV: staging`). The only unsafe case, an empty list outside production, is excluded for staging by `compose.staging.yml` (`${EXTENSION_ALLOWED_IDS:?}`) and by `staging_guard.py`, which requires a JSON list of 1 to 5 distinct valid IDs. **I cannot see the staging host's actual value;** the operator read-only check from E1 section 2 is still required and must show exactly the one ID.

## 6. Findings
- None blocking. Note for the record: the allowlist, not CORS, is the boundary (CORS accepts any extension origin).
- Limitation: this is Chrome for Testing, not the desktop Chrome that Phase B will use. Chrome's own grant prompt, native sign-in window and `!` badge have not been seen.

## 7. Stop conditions
Unexpected ID: no. Production request: no. Unexpected host permissions: no. Backend mismatch: no.

## 8. GO / NO-GO
**GO** for the real staging connection (Phase B), conditional on: (1) the operator read-only `EXTENSION_ALLOWED_IDS` check showing exactly the one ID; (2) the founder repeating the identity check in desktop Chrome below; (3) the approved throwaway account.

## 9. Manual check in desktop Chrome (2 minutes, dedicated profile, no sign-in)
1. In a clean checkout or `git archive` of `6458b2d`: `cd apps/extension && npm ci && npm run build:staging > /tmp/xa-staging-build.log 2>&1; echo exit=$?` (do not pipe the build into `head`).
2. `chrome://extensions`, Developer mode on, Load unpacked, choose `dist-staging`.
3. The card must read `XpertApply (STAGING)`, version `0.3.0`, ID `cglmdonbfbadfbggkpajpkjgpekhkall`, with no Errors button. Any other ID: stop.
4. Click `service worker` on the card; in its console run `chrome.runtime.id`, `chrome.runtime.getManifest().host_permissions` (exactly the two staging hosts) and `chrome.identity.getRedirectURL("x")` (starts with the ID above). Console shows `service worker active` and no red errors.
5. Network tab of that worker console: nothing requested while idle. Do not sign in, connect or open any job page.
6. Send back: a screenshot of the card and the three console results.
