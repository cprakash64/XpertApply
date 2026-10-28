# PUI-EDITORIAL-01: homepage art direction reset

Web-only, local, not deployed or pushed. Base `43b7046` (the rejected split hero stays in history). The staging host's `pui-b357260` image is NOT this design.

## Why the earlier attempts failed
1. `b357260` (centred, flat): grey haze background, muted blue-grey second line, nothing to look at; the type was big but lifeless.
2. `43b7046` (split): shrank the headline to make room for an invented job-list illustration, i.e. a generic SaaS picture that said nothing real about XpertApply.
The original won on one thing: a huge, tight, confident centred headline with a saturated accent on a bright page.

## Art direction
Bright white page; one oversized typographic statement (up to 90px, weight 790, tracking -0.058em) in Midnight Ink with a Sapphire second line; a flat hairline navigation instead of a floating shell; pill CTAs; and below the hero, real product screenshots matted like prints, with typography (not drawn UI) where no authentic asset exists.

## Changes
- Hero restored to centred; split hero and illustration removed (`HeroPreview` deleted); CTA copy "Get started" (no "free" claim).
- Nav: flat white bar, 1px Silver hairline, no shadow; new cropped transparent logo mark (`public/brand/xpertapply-mark.png`, cut from the 1448px source: the old 256px asset had the mark in about 20% of a padded 4:3 white canvas rendered into a 34px square). Footer/dark-section wordmarks benefit too.
- Story visual (`ProductDemo`) no longer draws a fake UI: real screenshots (sample data, no scores or counts) for Prepare and Track; a typographic workflow index for the other four stages; captions say "Product screenshot with sample data."
- Mobile: the sticky copy of the visual (and its controller) is hidden below 1024px; it had been widening the story column to 474px at 390px.
- Rail colours follow the new tokens.

## Tokens
Midnight Ink `#17283f` (14.9:1 on white), Refined Sapphire `#3078ac` (4.76:1 white, 4.52:1 Pearl: AA), Pearl `#f7f9fc`, Silver `#dfe5ed` (borders only), Soft Sky `#8db6d8`. Type: Inter/system stack (unchanged), weights 790 headline, 600 UI. Sapphire on the tinted step badge measured 4.08:1, so those numerals use Midnight Ink.

## Files
`Hero` (restored), `BrandWordmark`, `ProductDemo`, `ProductStory` (rail colours), `workflowStages.ts` (optional `shot`), `app/marketing.css` (tokens + one appended block), `public/brand/xpertapply-mark.png`, `public/story/{application-materials,tracker}.webp`.

## Evidence
`docs/release/evidence/pui-editorial01/`: `original-*` (939171f), `rejected1-centered-*`, `rejected2-split-*`, `editorial-home-{320..1920}.png`, `editorial-fullpage-{1440,390}.png`. Several correction passes were made from rendered screenshots (logo, lede widow, frame/controller overlap, upscaled blur from the image optimizer, mobile column overflow, badge contrast).

## Verification
eslint 0, tsc 0, vitest 54 files / 1057 tests pass, isolated production build (`.next` untouched), axe wcag2a/2aa/21aa: 0 violations at 390 and 1440 (original: 12 and 51 contrast violations), no horizontal overflow at 320-1920, CLS 0, no external requests, hero CTA/#story/Pricing dialog/Sign in work. Payload (gzip): CSS 20.6 KB original, 19.1 KB now; JS 183.6 KB original, 183.0 KB now. Playwright app specs were not re-run (they skip without an API).

## Limitations
Screenshots are native 1x crops from fixture captures (soft on retina; recapture at 2x would fix it); only two stages have real screenshots; the Chrome-extension section still shows its labelled "illustrative" drawn panel because no authentic extension capture exists; the hero is typographic only, by design; Firefox/WebKit not re-run; the logo mark keeps its turquoise (brand asset) while UI accents are Sapphire. Founder approval is required before more design work or any new image/deploy.
