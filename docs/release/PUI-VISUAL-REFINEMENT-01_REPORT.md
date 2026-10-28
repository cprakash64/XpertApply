# PUI-VISUAL-REFINEMENT-01: homepage hero refinement

Web-only. Base `04a73ad` (web source identical to the tested `b357260`). **This is a NEW candidate: the staging host's `pui-b357260-amd64` image does not contain it and must not be promoted as the approved design.** Nothing deployed, pushed, or rebuilt as a server image.

## Shortcomings found (from the founder comparison and the rendered baseline)
Flat grey page; 94px centred headline wrapping to three lines at 390px; about 250px of empty space above the headline and nothing but type in the first viewport; muted `#405f80` second line; tiny logo mark; navbar narrower than the content below it.

## Changes
- Editorial split hero (copy left, product picture right from 1100px; stacked below). Heading scale reduced from 58-94px to 38-52px, weight 740, line-height 1.04; "Apply with confidence." fits on one line at 1024-1920.
- `HeroPreview` (new, server component, no JS): job list plus a "Prepare application / You review and submit" panel on an Ice Blue stage. Illustrative, captioned "Illustrative example. Not real jobs or data."; no company names, counts, scores or percentages; hidden from assistive tech behind one descriptive `aria-label`.
- Porcelain page background, Ice Blue eyebrow chip, richer glacier second line, nav width aligned with content, larger logo, calmer nav links.
- No gradients, glows, blobs, glass or new dependencies; no new image assets (LCP is text).

## Tokens (added to `.xa-theme`)
`--xa-glacier-rich #416a93` (text on white 5.66:1, porcelain 5.52:1, ice 5.01:1), `--xa-sky #8db6d8` (borders/fills only; 2.14:1 on white, never text), `--xa-ice #eaf2fa`, `--xa-porcelain #fbfcfe`. Primary navy `#25364b` unchanged (12.3:1). Not adopted: the old turquoise (excluded by the brief), so the "energy" comes from the product picture, the richer blue and tighter composition, not saturation.

## Files
`apps/web/components/marketing/Hero.tsx`, `apps/web/components/marketing/HeroPreview.tsx` (new), `apps/web/app/marketing.css` (tokens + one appended refinement block + a 380px tweak).

## Evidence
`docs/release/evidence/pui-vr01/{before,after}-home-{320,390,768,1024,1280,1440,1920}.png` (before = the `b357260` image on :3100, after = the isolated build on :3200). Two correction passes were made from rendered screenshots: nav/content alignment, headline wrapping, tablet cramping (split moved from 1024 to 1100px), narrow eyebrow.

## Verification (this stage, real runs)
- `eslint` exit 0; `tsc --noEmit` exit 0; `vitest run` 54 files / 1058 tests pass (includes the homepage suite).
- Production-mode build in an isolated copy (`next build --webpack`; `.next` untouched), served at :3200.
- Browser checks on :3100 vs :3200, 390 and 1440: axe (wcag2a/2aa/21aa) 0 violations on both; CLS 0; no horizontal overflow at 320/390/768/1024/1280/1440/1920; no console errors besides the report-only CSP notice; no requests outside localhost. Hero "Get started" goes to /signup, "See XpertApply in action" to #story, Pricing opens the dialog, Sign in goes to /login.
- Payload (gzip, homepage): CSS 18.4 KB to 19.2 KB (+0.85 KB), JS 188.1 KB to 183.0 KB (no new client JS). LCP is text in both (local, uncontrolled): about 0.1 s.
- Playwright Chromium (`responsive-app-shell`, `profile-and-theme`, `premium-ui-rc-regressions`): 15 passed, **17 skipped** (they skip themselves with no API running); not a pass of those 17.

## Remaining
Firefox/WebKit not re-run; authenticated screens not re-screenshotted (only the homepage CSS block and one token addition changed; the new tokens are used only by the hero and nav rules); the "Product / Extension / Security" sections below the hero are unchanged and still use the older centred layout; the hero picture is a drawn illustration, not a real product screenshot (a real one needs founder-approved capture); the logo asset has built-in padding so the mark still reads small. A new image and a fresh staging gate are required before any deploy.
