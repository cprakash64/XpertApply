# S1: staging nginx security headers, guarded operator release

Status: **prepared, not applied.** Staging only. This does not release the S2 web CSP (staging web stays `baf0817`, API stays `aa5bc2fa`).
Artifacts: `docs/release/pui-s1s2/` (`staging-nginx-s1.sh`, `xpertapply-staging-s1.patch`, `xpertapply-staging.reviewed-baseline.conf`, `xpertapply-staging.candidate.conf`, `test-s1-nginx-local.sh`, `validate-staging-security-headers.sh`).

## 1. Baseline and root cause
Host `srv738314`, nginx 1.24.0. Source `/etc/nginx/sites-available/xpertapply-staging`, SHA-256 `c7f40f8b2f873d0166e1822064c317aa4a40e0b53bed0bf76a09ec5117d1d57a`, enabled through a symlink in `sites-enabled`. This is exactly the earlier live file (`1d635e30…`) plus the already-applied noindex patch, so the reviewed copy in the repo equals it except the SSL lines (masked; the key path is not stored in git).
Root cause: the vhost never sent HSTS, `X-Frame-Options`, `X-Content-Type-Options` or `Referrer-Policy`; only `X-Robots-Tag` was ever added. Production already sends them. An earlier draft of this patch was rejected because it relied on separate snippet files, added `Permissions-Policy` (out of scope) and its diff context included an SSL line that the secret-free reviewed copy cannot reproduce byte-for-byte.

## 2. What the candidate changes (the only changes)
| Where | Change |
|---|---|
| http level (top of the file) | `map $upstream_http_referrer_policy $xa_staging_referrer_policy`: pass the app's value through, else `strict-origin-when-cross-origin` |
| web HTTPS server block | `add_header` HSTS `max-age=300`, `X-Content-Type-Options nosniff`, `X-Frame-Options DENY`, `Referrer-Policy $xa_staging_referrer_policy` (all `always`) |
| `location = /robots.txt`, `location = /sitemap.xml` | the two one-liners become multi-line blocks that keep `X-Robots-Tag` and repeat the four headers, then `return 404` |
| web `location /` | `proxy_hide_header Referrer-Policy;` and `proxy_hide_header X-Robots-Tag;` |
| API HTTPS server block | HSTS `max-age=300` and `nosniff` only |
Unchanged: port-80 block (ACME, 301), `server_name`s, certificates, proxy targets, headers passed upstream, timeouts, upstream `Content-Security-Policy-Report-Only` (no CSP is added or enforced here), `nginx.conf`, every other vhost.

Values and why:
- **HSTS `max-age=300`**: shorter than production's 86400 (never increases scope or duration), host-only: no `includeSubDomains`, no `preload` (the parent domain serves production, www and api). Raise only after a hostname audit.
- **`X-Frame-Options: DENY`**, **`nosniff`**, **`Referrer-Policy: strict-origin-when-cross-origin`**: production's values. The API gets only HSTS and nosniff, as production's API does (JSON; no framing or referrer relevance).
- `Permissions-Policy`, COOP/COEP, CSP: not part of this release.

## 3. nginx 1.24 `add_header` inheritance
A location that defines any `add_header` discards every `add_header` inherited from the server block. The two exact-match 404 locations already define `X-Robots-Tag`, so each repeats `X-Robots-Tag` plus the four S1 headers; otherwise their 404 responses would lose them. `location /` defines none, so it inherits the server-level set. The script's preflight also refuses to run if any `add_header` exists at http level (`nginx.conf`, `conf.d`), which would change this analysis, and requires that the live vhost contains exactly the five known `X-Robots-Tag` directives.

## 4. Referrer-Policy on `/forgot-password` and `/reset-password`
The web build sets `Referrer-Policy: no-referrer` on these pages so a one-time reset token cannot leak in a `Referer`. A plain nginx `add_header Referrer-Policy strict-origin-when-cross-origin` would add a second, weaker header; browsers combine duplicates and the last valid value wins, which could undo the protection. The patch hides the upstream header and re-emits it once through the `map`: the app's value wins, everything else (including nginx-generated 404s and 502s) gets `strict-origin-when-cross-origin`. `X-Robots-Tag` is handled the same way (hidden upstream, single server-level source) because the web also sets it on those pages and the earlier noindex patch made it appear twice. The tests assert exactly-once for every header on all eight web routes.

## 5. Commands (run on `srv738314`, from a directory holding the six files above)
Read-only first; nothing changes:
```bash
bash staging-nginx-s1.sh preflight
```
It checks the host name, nginx 1.24, pinned patch/reference hashes, the live SHA-256, the symlink, that only the staging vhost declares the staging names, builds the candidate in a private copy, proves it is exactly the reviewed result, prints the exact diff, records `nginx -t` warnings, and takes a read-only snapshot of live responses. (The staging S1 rows are expected to be missing before apply.)

Apply (shows the diff again, then waits for you to type the approval phrase; it is bound to the reviewed candidate):
```bash
sudo bash staging-nginx-s1.sh apply
# type exactly:  APPLY 6506cb579307
```
Sequence: backup (`xpertapply-staging.bak-s1-<UTC>` plus `.meta` with owner/mode and hash) and pre-change snapshot (`/var/backups/xpertapply-nginx-s1/`), in-place rewrite (same inode, owner, mode; the symlink is never touched), `nginx -t` (restores and stops if it fails or if its warnings differ from before, so the existing VeoTrex TLS warning is neither fixed nor worsened), graceful `systemctl reload nginx`, then checks that no other nginx file changed, the master PID is unchanged, the symlink/owner/mode are unchanged, and the live headers and statuses are right. **Any failure after the write restores the backup automatically** and exits non-zero (exit 2); an inconclusive probe counts as failure.

Optional extra health URLs (for example the VeoTrex site) are compared before and after by status code:
```bash
sudo XA_S1_EXTRA_URLS="https://<veotrex-health-url>" bash staging-nginx-s1.sh apply
```

Verify at any time (read-only, no root):
```bash
bash staging-nginx-s1.sh verify
bash validate-staging-security-headers.sh      # the "staging CSP origin" row will keep failing until the S2 web release; ignore only that row
```
Checked: `/login /signup /forgot-password /reset-password /jobs /robots.txt /sitemap.xml` and a nonexistent page on the web host; `/healthz` and unauthorized `/jobs` (401) on the API host; CORS for the staging origin; both port-80 redirects; each header exactly once with the expected value; no `includeSubDomains`/`preload`; no CSP added to nginx-generated 404s; production URLs, the upstream CSP Report-Only value, CORS, `Location` and `Cache-Control` unchanged versus the pre-change snapshot.

Rollback (independent verification included):
```bash
sudo bash staging-nginx-s1.sh rollback            # newest backup; or pass an explicit .bak-s1-* path
```
It refuses a backup whose hash is not `c7f40f8b…`, restores in place, runs `nginx -t` (puts the pre-rollback file back if it fails), reloads gracefully, then verifies separately: baseline hash, symlink, no other file changed, S1 headers gone, noindex still present, statuses and production responses as before.

## 6. Local validation (no host touched)
`bash docs/release/pui-s1s2/test-s1-nginx-local.sh`: 33/33 pass against a real nginx 1.24.0 container with TLS, a symlinked staging vhost, a production-style vhost, an unrelated vhost that already prints a `nginx -t` warning, and stub upstreams. Covered: preflight read-only and refusals (wrong host, drifted hash, source not a symlink), no mutation without or with a wrong approval, automatic restore when `nginx -t` fails, automatic revert when an upstream also sends `X-Frame-Options` (duplicate detected), successful apply (symlink, owner/mode, other files unchanged, backup with metadata), independent exactly-once header assertions on eight web routes and the API, recovery pages keeping `no-referrer`, robots/sitemap 404s keeping noindex plus S1, port-80 redirect intact, production-style vhost unchanged, `verify` failing closed when the web upstream is down (502), and rollback with independent verification.
Not covered: the real host's certificates, the real VeoTrex vhost, systemd (the test reloads with `nginx -s reload`), and Ubuntu's exact package versions of `patch`/`curl`.

## 7. Remaining risks
- The live file is matched by SHA-256 and by the masked reviewed copy; if either differs, the script stops (by design) and the patch must be rebased.
- A shared nginx reload re-reads every vhost. The script proves the other files are byte-identical and the warning set is unchanged, but cannot prove unrelated sites' behaviour beyond the optional health URLs.
- HSTS on staging pins `staging.xpertapply.com` and `api-staging.xpertapply.com` for 5 minutes after any browser visit; a broken certificate in that window cannot be click-through bypassed.
- Production still needs the same `Referrer-Policy` map before the web release that includes the recovery pages reaches it (separate change, not prepared here).

## 8. Recommendation
Staging-only application: **GO** for the operator to run `preflight`, review the printed diff, and `apply`, after confirming the preflight output on the host. S2 web CSP release and any production change remain separate approvals.
