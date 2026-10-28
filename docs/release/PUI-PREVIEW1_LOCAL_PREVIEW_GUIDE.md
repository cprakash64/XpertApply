# PUI-PREVIEW1: local interactive preview guide

Source `b357260` (premium UI, Midnight Slate + Glacier Blue). Nothing deployed, nothing pushed, no server touched.

## 1. URL
**http://localhost:3100/** (container `xpertapply-ui-preview`, image `xpertapply-staging-web:pui-b357260-amd64`, id `sha256:c5e12c4e…8419`, `linux/amd64` under emulation, revision label `b35726083516ac8bb23f46fb51932eb4dd36a823`).
Bound to `127.0.0.1` only; not privileged; no mounts; no secrets; 1 GiB memory and 256-pid limits; no restart policy.

## 2. Public pages (fully interactive)
- http://localhost:3100/ (homepage, light-only)
- http://localhost:3100/pricing (placeholder copy by design)
- http://localhost:3100/login and http://localhost:3100/signup (forms render; submitting calls the staging API, see section 4)
- http://localhost:3100/opensource and http://localhost:3100/privacy
- Not present in this web line (404): /product, /security, /extension, /terms, /contact, /documents.

## 3. Authenticated pages
These routes render without a session, but their data calls go to the staging API and are refused, so you see the empty/error state, not real content:
http://localhost:3100/dashboard, /jobs, /tracker, /profile, /settings, /resume, /cover-letter, /application-answers, /demographics.
Dashboard shows "We couldn't load your dashboard" with a retry button. This is real behaviour of the build with no backend; I did not bypass authentication or fabricate responses.
For populated versions use the screenshot gallery (section 5): `docs/release/evidence/pui-preview1/index.html` (open with `open docs/release/evidence/pui-preview1/index.html`).

## 4. Staging API dependency (disclosed)
The image has staging public config baked in: `NEXT_PUBLIC_API_URL=https://api-staging.xpertapply.com`, `NEXT_PUBLIC_SITE_URL=https://staging.xpertapply.com`, empty extension URL, Store extension id (inert on this line).
Observed from `http://localhost:3100`: the dashboard issued one unauthenticated `GET api-staging.xpertapply.com/dashboard/summary`, which the browser blocked at CORS preflight (staging allows only its own origin). No production host was contacted; no request carried credentials.
**Do not sign in or submit forms here**: a login or sign-up from localhost would attempt to hit the staging API (blocked by CORS in a browser, but avoid it).

## 5. Verified screenshots for protected screens
`docs/release/evidence/pui-preview1/index.html` is a static gallery of the 209 RC1 captures (`docs/release/evidence/pui-rc1/`): all app screens at 320/390/768/1024/1440/1920, dark mode, error/empty states and interaction states. A banner marks them as static. They were taken with synthetic fixtures (placeholder company "Acme AI", fake phone 555-0100); I spot-checked profile and tracker captures and found no real personal data, but did not inspect all 209.

## 6. Mobile and tablet inspection
Chrome: open the page, DevTools (Cmd+Opt+I), toggle device toolbar (Cmd+Shift+M), pick iPhone 12/14 (390), iPad Mini (768), or enter 320 to test the narrowest layout.

## 7. Stop cleanly
```bash
docker stop xpertapply-ui-preview && docker rm xpertapply-ui-preview
```
This removes only the preview container; the image stays.

## Verification (this session)
- Image revision label = `b357260…`, platform `linux/amd64`: verified.
- `/` and eight app routes return 200; `/design-system-specimen` is 404 (not shipped).
- Homepage loaded in the in-app browser; static assets all 200; only console errors: a report-only CSP notice (`upgrade-insecure-requests` ignored) and the expected CORS block on the staging API call. No application script errors seen.
- Design tokens served: accent `#25364b` (light) and `#9bb3cf` (dark), per `app/globals.css`.
- The app pages follow the browser/OS colour scheme; the in-app browser pane renders dark, Chrome light unless your OS is dark.
- Not verified: pixel-level colour check against the brief, Firefox, behaviour with a real session.
