# S1/S2: edge security headers and Content Security Policy

Status: local corrections committed, **not deployed**. Production remains NO-GO until separately approved.
Baseline: web `baf0817`, API `aa5bc2f`, DB `0034_password_reset` (staging). Findings source: `docs/release/PUI-LIVE-ACCEPTANCE_REPORT.md` section 7.

## 1. Findings recovered
| ID | Reported | Verdict after investigation |
|---|---|---|
| S1 (P2) | Staging edge sends no HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy; CSP is report-only so `frame-ancestors` is not enforced | **Confirmed for staging only.** Production's nginx already sends HSTS (`max-age=86400`), nosniff, `X-Frame-Options: DENY`, Referrer-Policy and Permissions-Policy on web, and HSTS + nosniff on the API. Clickjacking on staging is possible today (no XFO, CSP not enforced); on production XFO covers it. |
| S2 (P2) | Report-only CSP names the production API origin, not staging's | **Confirmed, and wider than reported.** (a) `connect-src`/`img-src` hard-coded `https://api.xpertapply.com`, so staging's own API calls (`api-staging`) are reported as violations. (b) Every page also reports one inline-script violation (Next.js RSC flight data), which is a blocker for enforcement independent of the origin. |

## 2. Header ownership (layer map)
| Header | Owner today | Notes |
|---|---|---|
| Content-Security-Policy-Report-Only | Next (`next.config.mjs` via `lib/securityPolicy.mjs`) | Page routes only; not `/_next`, `/api`, `/brand`, files with an extension. |
| Referrer-Policy `no-referrer`, Cache-Control `no-store`, X-Robots-Tag | Next, `/forgot-password` and `/reset-password` only | Protects the one-time reset token. |
| HSTS, nosniff, XFO, Referrer-Policy, Permissions-Policy | **nginx** (production live; staging absent) | Next sets none of these, so there is no duplication on production today. |
| X-Robots-Tag (staging) | nginx, applied via the earlier noindex patch | Next also sets it on the recovery pages: identical value, duplicated (see section 5). |
| CORS | FastAPI `CORSMiddleware` (explicit origins + `chrome-extension://[a-p]{32}` regex) | Not changed. API sets no CSP/XFO (JSON); acceptable. |

Live evidence (2026-10-30, anonymous GETs, no cookies/tokens): see section 7. The live nginx file itself was not read (no host access in this session).

## 3. S2 violation classification (real Chromium against a production build)
| Violation | Class | Action |
|---|---|---|
| `connect-src https://api-staging.xpertapply.com/...` (`/auth/providers`, `/auth/password-reset/availability`) | **Real configuration defect** (policy hard-coded to production API) | Fixed: origin derived from `NEXT_PUBLIC_API_URL`. |
| `script-src-elem inline` x2 per page (`self.__next_f` bootstrap/flight payload) | **Legitimate application dependency**; blocks enforcement | Not fixed; see section 4. |
| Console: `upgrade-insecure-requests is ignored in report-only` | **Unsupported directive in report-only**; not a vulnerability | Kept; becomes effective only if enforced. Omitted when the API origin is plain-http localhost. |
| `CORS ... blocked` when probing a localhost origin against the staging API | **Test artifact** (origin `localhost:3055` is not in staging's allowlist) | None. |
| No violations for fonts, images, styles, frames, forms, workers | none observed | n/a |

Measured: enforcing the current policy unchanged stops hydration (client-side fetch never fires on `/login`); adding `'unsafe-inline'` to `script-src` restores it. So the blocker is real.

## 4. CSP strategy decision
Rendering: Every route except `/jobs/[id]` and `/matches/[id]` is a static prerender served with `Cache-Control: s-maxage=31536000`.
- **Per-request nonce** (Next's documented approach) needs dynamic rendering of every page, giving up static prerender and the long shared-cache lifetime, and adding per-request render cost. Rejected for now: not justified by a P2 finding.
- **Hashes**: the inline flight payload differs per page and is build-specific; dynamic routes' payloads cannot be hashed ahead of time. Needs a post-build step plus a per-route header layer (the header list in `next.config` is fixed before the build). Rejected as brittle.
- **`'unsafe-inline'` for scripts**: removes most XSS value (S4: bearer token in localStorage). Rejected.
- **Decision**: keep the whole policy Report-Only. Fix the origin defect now. Choose nonce-vs-hash in a separate change before any enforcement. A reasonable interim to propose (not done, needs approval): enforce a *second* header with only `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`, which does not touch scripts and so cannot break hydration. Staging nginx `X-Frame-Options` already closes the clickjacking gap without this.

## 5. Corrections made
1. `apps/web/lib/securityPolicy.mjs`: `apiOrigin()` resolves `NEXT_PUBLIC_API_URL` exactly as `lib/api.ts` does (same variable, same `http://localhost:8000` fallback), strips any path, accepts `https` or loopback `http`, and throws at build time otherwise (a malformed value can no longer inject a directive). `reportOnlyPolicy(env)` uses it for `img-src` and `connect-src`. Production output is **byte-identical** to the live production header (verified), so production behaviour is unchanged.
2. `apps/web/__tests__/securityPolicy.test.ts`: per-environment, normalisation, fail-closed and local-dev cases.
3. `docs/release/pui-s1s2/`: the S1 staging nginx patch, a checksum-guarded `staging-nginx-s1.sh` (preflight/apply/verify/rollback) with a Docker end-to-end test, and a read-only validator. Not applied anywhere. Superseded by the guarded release: the earlier snippet-based draft was removed (it was built on a sanitized copy and added Permissions-Policy, which is out of scope for this release).

nginx design points proven in the test:
- Headers are written inline at server level **and** repeated inside the two `location =` blocks (single-file change, single rollback), because a location that has its own `add_header` drops inherited ones.
- `always` so 404/500/502/301 carry them.
- **Referrer-Policy conflict avoided.** Adding the production value in nginx would put a second, weaker `Referrer-Policy` next to the recovery pages' `no-referrer`; with duplicate headers the browser combines them and the last valid one wins, which could re-enable Referer on the reset-token page. The patch hides the upstream value and re-emits it once through a `map`, so the app's value wins and everything else (including nginx-generated errors) gets `strict-origin-when-cross-origin`. **The same hazard applies when the web release with recovery pages reaches production** (production web currently 404s `/forgot-password`, so it is not live yet): production nginx needs the same `map` before that release. Not changed here.
- `proxy_hide_header X-Robots-Tag` on staging removes the existing identical duplicate on the recovery pages.
- HSTS is `max-age=300`, no `includeSubDomains`, no `preload` (the parent domain also serves production, www and api; audit before widening). COOP/COEP not added.

## 6. Operator runbook (staging nginx; nothing here has been run)
See `docs/release/PUI-S1-STAGING-NGINX_RUNBOOK.md` (modes `preflight`, `apply`, `verify`, `rollback` of `docs/release/pui-s1s2/staging-nginx-s1.sh`). It pins the verified live SHA-256 `c7f40f8b…`, refuses anything else, shows the exact diff, requires a typed approval, backs up, tests with `nginx -t` (restoring automatically on failure), reloads gracefully, verifies live headers and reverts automatically if verification fails.

## 7. Live header comparison (anonymous, 2026-10-30)
| Response | staging web | production web | staging API | production API |
|---|---|---|---|---|
| HSTS | absent | `max-age=86400` | absent | `max-age=86400` |
| X-Content-Type-Options | absent | `nosniff` | absent | `nosniff` |
| X-Frame-Options | absent | `DENY` | absent | absent |
| Referrer-Policy | absent (recovery page: `no-referrer`) | `strict-origin-when-cross-origin` | absent | absent |
| Permissions-Policy | absent | restrictive list | absent | absent |
| CSP | Report-Only, names **production** API | Report-Only, production API (correct) | none | none |
| Cache-Control | HTML `s-maxage=31536000`; 404 `no-store`; recovery `no-store` | same | none | none |
| X-Robots-Tag | `noindex, nofollow` (recovery page: **sent twice**) | absent | present | absent |
Same results for `/`, `/login`, `/dashboard` (static shell, no user data), 404, and the HTTP to HTTPS 301. Authenticated responses were not fetched (no authorised test credentials were used); the API sends no `Cache-Control` on JSON, which relies on the `Authorization` header to keep shared caches from storing it (F1 is tracked separately).

## 8. Validation
- `npm run lint`, `npm run typecheck`: clean. `npm test`: 62 files, 1214 tests pass. `npm run build`: succeeds for staging, default-local and production-origin configurations.
- Real Chromium: staging-origin build reports only the inline-script violation; the `connect-src` violation is gone.
- Playwright (9 specs, local production build, no live API): 59 passed, 19 skipped, 12 failed. The same 12 (Apply dialog x9, jobs workspace x3) fail identically on the unmodified baseline build, so they are environmental (specs expect a live stack at the configured API address), not caused by this change. They need a run against a live stack before staging acceptance.
- `bash docs/release/pui-s1s2/test-s1-nginx-local.sh`: 33/33 PASS against real nginx 1.24 with TLS (preflight refusals, approval gate, nginx -t failure restore, post-reload duplicate-header auto-revert, success path, verify fail-closed, rollback).
- Not run: `make test-api`/`test-extension` (no API or extension change), Alembic (no migration), `docker compose config` (no compose change), authenticated browser flows.

## 9. Rollout and rollback
1. Staging nginx patch (section 6), then the web build that contains `securityPolicy.mjs` with `NEXT_PUBLIC_API_URL=https://api-staging.xpertapply.com` (build arg already set by `compose.staging.yml`). Roll back the web by redeploying `baf0817`.
2. Staging watch period: browser console and any collected reports show no violation other than the inline script.
3. Production: no change to web CSP output. Before the recovery-page web release, add the `Referrer-Policy` map to production nginx. HSTS widening and any enforcement are separate approvals.

## 10. Extension implications
CSP and these headers apply to pages, not to the MV3 service worker or content-script messaging; the extension's API calls (`host_permissions` `https://*/*`) and web to extension messaging (`chrome.runtime`, by ID) are not subject to the page's `connect-src`. `frame-ancestors`/XFO do not affect it (it does not frame the web app). CORS and extension IDs untouched. Static analysis only; the 0.3.0 connect test remains open (separate gate).

## 11. Remaining risks
- Inline-script strategy undecided; CSP cannot be enforced until it is.
- Production HSTS is only 24 h and has no `includeSubDomains`/preload; production API sends no XFO/Referrer-Policy (low for JSON).
- Production nginx needs the Referrer-Policy `map` before the recovery pages ship there.
- The live staging file is pinned by SHA-256 (`c7f40f8b…`, verified by the operator); the reviewed copy in the repo masks only the SSL lines, and preflight proves the live file matches it everywhere else.
- Authenticated-route headers and caching were not probed live.

## 12. Recommendation
S1 staging: **GO to apply** the nginx patch on staging after operator verification. S2: **GO for the origin fix on staging**; **NO-GO for enforcement** (any environment). Production: **NO-GO** pending explicit approval.

## 13. Enforced CSP baseline (IMPLEMENTED LOCALLY, staging-only candidate; decision on f86b6c6)
Decision: do not enforce the four-directive policy. Enforce only `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`. `form-action 'self'` is deferred until cross-browser auth and integration flows are verified. The Report-Only policy is unchanged; `X-Frame-Options: DENY` stays at nginx (production) and is added on staging by section 5 (same value, different mechanism, no conflict). No `script-src` enforcement, no rendering change.

Implementation: `enforcedPolicy()` / `enforcedHeaders()` in `lib/securityPolicy.mjs`, emitted from `next.config.mjs` on the same page source as the Report-Only header (so never on `/_next`, `/api`, `/brand` or files with an extension). It contains no origin, so it is identical in every environment.

Legitimate-use review (code search): no `<iframe>`, `<object>`, `<embed>` or `<base>` anywhere in `apps/web`; the extension never frames the web app (its UI is the side panel and content scripts on third-party pages, whose CSPs are theirs); `window.open` uses `noopener,noreferrer`; Google sign-in is a top-level `window.location.href` navigation to the API, not a form post, so it does not involve `form-action` or `frame-ancestors`.

Evidence (`docs/release/pui-s1s2/crossbrowser-baseline.mjs`, API mocked, local production build):
| Check | Chromium | WebKit | Firefox |
|---|---|---|---|
| One enforced + one Report-Only header on `/`, `/login`, `/signup`, `/forgot-password`, `/extension/connect`, a 404; none on a static file | pass | pass | **not run** |
| Cross-origin iframe of `/login` blocked; control frame of a CSP-less file loads | pass | pass | **not run** |
| Cross-origin `<base>` refused, same-origin `<base>` allowed | pass | pass | **not run** |
| `<object>`/`<embed>` raise enforced `object-src` violations | pass | pass | **not run** |
| Login hydrates and calls the API; Continue with Google navigates to `/auth/google/start`; signup POSTs; extension connect page has 0 enforced violations; same-origin `postMessage` works | pass | pass | **not run** |
Firefox could not start in the session sandbox (the browser's helper-process sandbox is denied by the host); run the script for Firefox on a normal machine before staging acceptance:
```bash
cd apps/web && npm run build && npx next start -p 3055 &   # then, in another shell:
node ../../docs/release/pui-s1s2/crossbrowser-baseline.mjs firefox
```
Also: Chromium 44/44 and WebKit 14/15 on the mocked specs (tracker downloads incl. filename/bytes and 404/409/500 errors, auth-session expiry, password recovery, public pages, applied-to-tracker, applications). The one WebKit failure (Tab order on `/forgot-password`) was triaged afterwards: identical with and without the enforced CSP (A/B on the same build, WebKit 26.5), caused by macOS Safari/WebKit moving Tab between text fields only (buttons and links need Option+Tab), reproduced on a bare control page with no app code; the app's order is correct and nothing is unreachable. The spec now uses Option+Tab on macOS WebKit with identical assertions. Firefox for the specs was not run. A live Google round trip, a real extension install and a real tracker download against a live API were not performed.

Validation: lint and typecheck clean; Vitest 1216 passed (62 files); build succeeds.

Rollout: staging only, with the section 6 nginx patch and web release. Rollback: redeploy the previous web image (the header is emitted only from `next.config.mjs`). Production: separate approval after staging evidence and the Firefox run.

### Independent S1 items (can ship without the CSP)
1. Staging nginx header patch (section 5/6): fixes the confirmed staging gap and is independent of any web build.
2. Production nginx `Referrer-Policy` map (section 5): required before the web release that includes the recovery pages reaches production, otherwise `/reset-password` gets a conflicting second `Referrer-Policy`. Production nginx file not read or changed.
3. Optional hardening, not needed now: production API `X-Frame-Options`/`Referrer-Policy` (JSON only), longer production HSTS after a hostname audit.

## 14. S2 staging web release (PREPARED, NOT EXECUTED)
Runbook `docs/release/PUI-S2_RUNBOOK.md`; script and tests in `docs/release/pui-s2/`. Image `xpertapply-staging-web:s2-95de977-amd64` (revision `95de9778…`, fingerprint `ff8c29c3…`). Web-only, after S1; rollback target is the verified F4 web (`baf0817`), not F2. Safari/WebKit Apply-dialog findings and the F4 deployment anomaly analysis are recorded in the runbook (sections 7 and 9).
