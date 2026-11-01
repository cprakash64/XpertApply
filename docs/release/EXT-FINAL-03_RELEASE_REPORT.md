# EXT-FINAL-03: production connection release preparation

Prepared only. Nothing was deployed, pushed, published or submitted. Production containers were not modified (API and web were still on the same images and uptime afterwards). No Hunter, Networking, database, extension ZIP or Store-ID change. Answer drafting stays off.

Verdict: **PREPARED. Release verdict READY-FOR-OPERATOR for the web release; the API release is READY-FOR-OPERATOR; extension connection stays BLOCKED until the operator applies the API release and the native acceptance (C1 to C14) is run.**

## 1. Production facts (read-only, secrets not read or printed)
| Fact | Evidence |
|---|---|
| Running images | API `12eb76af8610`, web `0e6c28d056eb`, both NET-PROD-08; DB head `0034_password_reset`; API healthy, 0 restarts |
| `EXTENSION_ALLOWED_IDS` | **Not set** in the running API (0 occurrences in the container environment), so the allowlist is empty |
| `APP_ENV` | `production`. With an empty list the code accepts no extension at all (`_redirect_allowed`), so Connect fails closed |
| Parsing | `list[str]` via pydantic-settings: the value **must be a JSON list**. Proven with the real API code: `["gnibjom…"]` is accepted, store id allowed, staging id and any other id refused; a bare id raises `SettingsError` at startup (API would not boot) |
| Answer drafting | `APPLICATION_ANSWER_DRAFTING_ENABLED` unset = off; unchanged by this release and enforced by the checks |
| Hunter / Networking | discovery on (internal tester), limits 5/3/2, internal rollout; compared before and after each apply |
| Compose list | `docker-compose.yml`, `compose.production.yml`, `compose.redis-preserve.yml`, netprod03 baseline + activation, `netprod08/compose.netprod08-images.yml` |
| Public URLs now | `/privacy` 200, `/support` **404** (until the web release), `/terms` 404 (nothing links to it; no approved text exists) |
| Mail | `xpertapply.com` has MX records (Hostinger). That does **not** prove the mailbox `privacy@xpertapply.com` exists or is read |

## 2. Web tree comparison (critical check)
`273f975` is a **direct child** of the NET-PROD-08 commit `32a7d54` (merge base = `32a7d54`). The `apps/api` tree is byte-identical (`2c9f4f6a…`). The web differs in exactly 8 files; every other deployed fix is untouched. The only code removed is the old page `postMessage` PING handshake, replaced on purpose by the Chrome-routed channel. The built image still carries the NET-PROD-08 neutral rate-limit wording (checked in the image).

Changed web files: `lib/extensionRuntime.ts` (new), `lib/authSession.ts`, `lib/autoApply.ts`, `app/support/page.tsx` (new), `app/sitemap.ts`, `components/PublicPage.tsx`, `__tests__/auth-session.test.ts`, `__tests__/support-page.test.tsx` (new). The `apps/extension` source also differs from NET-PROD-08 (0.2.0 to 0.3.0) but the extension is not part of any server image.

## 3. Artifacts and checksums
| Item | Value |
|---|---|
| Source commit | `273f975a3123babc50d55fdc39faa8c81160e0c5` (local; the report/bundle commit follows it) |
| Web image | `xpertapply-web:extfinal03-273f975-prod-amd64`, `sha256:ef03408595cc433ba783be4a93acbfc0fe208f2b04ec8ddc859892a2ce422b1d`, amd64, built on the VPS (resource-limited, no container touched) |
| Web build args | API `https://api.xpertapply.com`, site `https://xpertapply.com`, extension id `gnibjomjfdobadlockphjiibbpmiehcj`, extension URL **empty** |
| Web archive | `/home/luna/xpertapply-release-candidates/extfinal03-273f975-20261101T091352Z/xpertapply-web-extfinal03-273f975-prod-amd64.tar`, sha256 `bce9bbf1efd8ef3e0fed2864c5a0991ccb205cfc3743e2eefeec2027383c32e2` |
| Web rollback | NET-PROD-08 web image `0e6c28d056eb…`, archive sha256 `4e8bc9be82ddd01820840755712024f1981c9d65fe9de547ae0a97afcbf9d84c` (re-verified on the host) |
| API image | unchanged, `12eb76af8610` (no rebuild) |
| API config change | `EXTENSION_ALLOWED_IDS=["gnibjomjfdobadlockphjiibbpmiehcj"]` via a root-owned Compose override; `.env` is not edited |
| Override SHA-256 | web-image file `243912e1d4ac1605…2da7`, extension-id file `2905e3d625c47c4e…49a0` (full values in `release-manifest.txt`) |
| Bundle | `docs/release/extfinal03-bundle/` (copies: `~/Developer/XpertApply-builds/extfinal03-bundle/`, host `/home/luna/xpertapply-extfinal03-review/`). `SHA256SUMS` itself hashes to `b2325dc37f3ede37a2b31c06896869e1eeb6d1438a0edabc4e2c9f821802acce` |
| Extension ZIP (unchanged) | SHA-256 `18b98e1c690d8c3c41258694039008b106254887893b2836fea420c7012f279d` |

Image content checks (offline container, no network): production extension id present; no staging host or staging extension id; **no Chrome Web Store link** (no premature install link); sign-out teardown present; `/support` route built; no env files.

## 4. Exact changes from NET-PROD-08
1. **Web release**: recreate `xpertapply-web-1` only, on the image above (Compose list gains `compose.extfinal03-web-image.yml`, which pins the web image and nothing else).
2. **API release (configuration only)**: recreate `xpertapply-api-1` only, same image, one added environment variable (Compose list gains `compose.extfinal03-extension-id.yml`).
3. Not changed: Hunter, Networking, drafting, any secret, `.env`, database, worker, scheduler, Redis, nginx, staging, VeoTrex.

No backup gate: no migration, no data change, no API image change. Every other container's id and start time is fingerprinted before and after instead; the NET-PROD-08 `production-backup.sh` is still there if you want a backup anyway.

## 5. Tests and rehearsal evidence
- Bundle tests `test_extfinal03.py`: **32 pass** (state-directory path safety, pinned content, script audits: root + exact phrase + installed copy, `up -d --no-deps --no-build` of one service only, no `.env` writes, no secret printing; delta gate; and a merge simulation that renders the repository's real Compose files with the override files).
- Delta gate proves: web release changes only the web image; API release adds exactly one variable, exactly `["gnibjom…"]`; touching Hunter, discovery, drafting, other IDs, another service, or the image is refused.
- **Read-only rehearsal on the production host** (non-root `check` of the exact scripts, checksums verified there): web check **22 pass, 0 fail** (4 root-only skips); api check **13 pass, 0 fail** (4 root-only skips); both rollback checks correctly report "nothing to roll back" before any release. Root-only steps (state verification, Compose render, dry-run) are not exercised until the operator runs them.
- Not run here: any apply, or the root-only checks.

## 6. Operator procedure
Install and state (once, root): `sudo ./install-extfinal03.sh`, then `sudo /opt/xpertapply-release/extfinal03-extension-connect/init-extfinal03-state.sh --apply`.

Preflight (run both, as luna and as root): `production-release.sh web check`, `production-release.sh api check` (each ends `READY for apply` only when everything passes, including the root-only Compose render and dry-run).

Apply, in this order, only after you authorize each:
1. `sudo …/production-release.sh web apply --confirm extfinal03-release-web`
2. `sudo …/production-release.sh api apply --confirm extfinal03-release-api`

Post-checks the scripts run: health, image ids, settings identical except `ext_ids`, redirect policy (store id yes; staging id, other id, wildcard, foreign host no), readyz, public 200s including `/support`, no other container changed, monitor.

Rollback (independent, same guards): `production-rollback.sh web apply --confirm extfinal03-rollback-web`; `production-rollback.sh api apply --confirm extfinal03-rollback-api` (allowlist empty again).
Caution: the nightly `docker image prune -af --filter until=24h` can delete the unused candidate or previous images; apply loads from the pinned archive when needed.

## 7. Support, privacy, Terms
- `/privacy` 200 and accurate for the extension (checked in EXT-FINAL-01/02). `/support` will return 200 after the web release (verified in the built image; the apply step asserts it).
- `/support` names `privacy@xpertapply.com` as its only contact (you confirmed it). **Operator acceptance item: send a test message to that address and confirm someone receives and reads it.** Do not rely on the DNS MX records as proof. If it does not receive mail, give me the correct address and I will update the page before the web release.
- `/terms`: no approved text exists and nothing links to it, so none was created. The Store listing does not require it.

## 8. Native Chrome acceptance (C1 to C14): prepared, PENDING
Prerequisites: both releases applied; the Store item's public key (Dashboard, Package, View public key); a disposable production test account (not a real person's data).
```bash
cd /Users/cprakash/Developer/XpertApply-extfinal/apps/extension
XA_STORE_PUBLIC_KEY="<paste public key>" npm run store-id:unpacked
```
The script refuses unless the key derives exactly `gnibjomjfdobadlockphjiibbpmiehcj`. Load `dist-store-id/` in a **fresh Chrome profile** (Developer mode, Load unpacked) and confirm the card ID. Then follow the table in `EXT-FINAL-02_RELEASE_PLAN.md` section 3 (C1 to C14), plus:
- fresh install and first/repeat visit on Greenhouse, Lever, Ashby (the bundled test pages are fixtures; use real public job pages and never press Submit);
- connected vs disconnected; sign out on the site then confirm the extension is disconnected (the web fix); switch to account B and confirm A's data is gone;
- token expiry and reconnect; stop the service worker, restart Chrome;
- sponsorship filled only from a saved answer; demographics left blank; your typing never overwritten; no new window appears;
- DevTools Network: only `xpertapply.com` / `api.xpertapply.com` and the employer's own hosts.

Evidence to record per step: Chrome version, extension version and ID, PASS/FAIL, a screenshot, and any console errors. I will not mark any step PASS without this evidence.

## 9. Chrome Web Store checklist, screenshots and submission steps
1. Dashboard, existing item `gnibjomjfdobadlockphjiibbpmiehcj` (never a new item): **Package**, upload `xpertapply-extension.zip` (SHA-256 above). Confirm the manifest reads version 0.3.0 and the upload is accepted.
2. **Store listing**: name "XpertApply — Assisted Apply", category Workflow & Planning, language English, description (plain, accurate: fills your own applications from your profile; you review and submit), 128×128 icon (present).
3. **Screenshots** (required; none uploaded yet): 1280×800 or 640×400, at least 1 and up to 5. Capture only from the disposable account with fake data, after a successful connection: (a) connected state in the assistant on a public job page, (b) reviewing suggested answers, (c) a filled form before the manual submit, (d) the connect consent page, (e) the disconnect option. Optional small promo tile 440×280.
4. **Privacy**: privacy policy `https://xpertapply.com/privacy`. Data collected: personally identifiable information, authentication information and website content, used only to provide the feature; not sold, not used for unrelated purposes or credit decisions; no remote code. Certify Limited Use.
5. **Permission justifications**: the table in `EXT-FINAL-01_REPORT.md` (`activeTab`, `tabs`, `scripting`, `storage`, `sidePanel`, `identity`, optional per-origin `https://*/*`, three XpertApply hosts).
6. **Support**: homepage `https://xpertapply.com/`, support URL `https://xpertapply.com/support` (live only after the web release), official URL none.
7. **Distribution**: choose visibility (Public or Private/trusted testers) and regions yourself; the draft previously showed Public, all regions, free. For a first run consider **Private** (trusted testers) so you can complete C1 to C14 from the Store-installed build before going public.
8. Resolve the Dashboard's "Why can't I submit?" list (screenshots and any missing fields), then **Submit for review yourself**. After approval and publication, send me the canonical Store URL; only then set `NEXT_PUBLIC_CHROME_EXTENSION_URL` in a separate web rebuild.

## 10. Remaining operator actions
1. Confirm the `privacy@xpertapply.com` mailbox receives mail (or supply another address).
2. Install the bundle, run both `check`s as luna and root, then authorize and run the web apply, then the API apply.
3. Upload the ZIP as a draft; copy the public key; build `dist-store-id`; run C1 to C14 and the site checks on a disposable account; capture screenshots.
4. Complete the Store fields, choose visibility, submit.
5. After publication: add the canonical URL in a later web rebuild.

## 11. Verdicts
| Item | Verdict |
|---|---|
| Web release artifact | PREPARED, verified in rehearsal (22/22 non-root checks) |
| API configuration release | PREPARED, verified in rehearsal (13/13 non-root checks) |
| Rollback, both | PREPARED; rollback checks rehearsed |
| Root-only checks, apply, post-checks | NOT RUN (operator) |
| Support URL | READY after web release; mailbox acceptance PENDING |
| Native Chrome C1 to C14 | PENDING (needs the public key, both releases, and you) |
| Store submission | NOT READY: screenshots and the Dashboard submission checklist |
