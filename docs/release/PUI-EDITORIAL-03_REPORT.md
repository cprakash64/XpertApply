# PUI-EDITORIAL-03: borderless nav, more transparent scroll state, no eyebrows, clearer favicon

Web-only, local, not deployed or pushed. Base `9c26c66`. Headline, hero, colours, glow, CTAs and story are unchanged; Pricing stays out of the nav.

## Navbar
- Initial: white 98%, **no border**, radius 16px (unchanged), height 64px (unchanged), shadow `0 1px 3px rgb(23 40 63/5%), 0 10px 30px rgb(23 40 63/7%)`. Position unchanged (14px from the top, content width).
- Scrolled: white **80%**, `backdrop-filter: blur(18px) saturate(1.3)`, shadow `0 1px 2px /3%, 0 8px 24px /6%`, 210ms transition. 76-84% was considered; 80% chosen.
- Over a dark section the bar rises to **93%** (second IntersectionObserver on sections marked `data-nav-tone="dark"`, watching the band under the bar; no scroll listener). At a flat 80% white over the navy section the bar rendered as `rgb(208,212,218)`, a muddy grey (10:1 ink contrast); at 93% it is `rgb(238,240,242)` (13:1). Over white, Pearl and the screenshot frames the bar is effectively white (14.9:1).
- Mobile menu panel: solid white, no border, shadow only. Focus rings, reduced-motion, reduced-transparency and no-`backdrop-filter` fallbacks kept (the fallbacks also cover the dark tone). The hamburger button keeps its own outline (it is a control, not the bar).

## Eyebrows removed (markup and CSS, not hidden)
"Built for the whole job search" (hero), "XpertApply in action" (story), "XpertApply for Chrome" (extension), "Designed around trust" (security), "Get started" (final CTA), "Pricing" (pricing dialog). The `.xa-eyebrow*` styles are deleted; first headings get `margin-top: 0` and the hero top padding rose (64-124px) so it still reads spacious. Kept deliberately: the numbered stage markers ("01 DISCOVER" ...), which label steps of the workflow, not sections, and are asserted by the existing six-stage tests; the app dashboard's own `eyebrow` data field is not part of the homepage.

## Favicon
Why it was weak: the previous 128px icon was the transparent mark downscaled with thin strokes and the Midnight Ink half vanishing on dark tabs. New assets, rendered from the original 1448px source (8x supersample, Lanczos, light sharpening, stroke growth of 3-7% at small sizes, X filling 84-94% of a white rounded tile so both halves read on dark tabs): `app/favicon.ico` (16, 32, 48 PNG entries, 5.4 KB), `app/icon.png` (192x192, 12.8 KB), `app/apple-icon.png` (180x180 opaque, 9.9 KB). Next serves them with content-hashed URLs (`/favicon.ico?84f9...`, `/icon.png?1f98...`, `/apple-icon.png?f121...`), which also busts browser caches. Colours: only `#17283f` and `#3078ac`. Extension icons untouched.

## Evidence
`docs/release/evidence/pui-editorial03/`: `favicon-contact-sheet.png` (old vs new at actual 16/32/48 on light and dark tab strips, plus 10x pixel views), `after-{A-top,B-mid,C-lower}-{320..1920}.png`, `e9-over-{navy,pearl-ext,screenshot,white}.png`, mobile-menu capture, focus/hover, `after-fullpage-{1440,390}.png`, `before-9c26c66-*`.

## Verification
eslint 0, tsc 0, vitest 54 files / 1060 tests (new: no eyebrow label in the DOM and all five section headings present; existing: no Pricing in nav, scroll-state toggle, mobile menu); isolated production build; `responsive-app-shell` 9/9; axe wcag2a/2aa/21aa 0 violations at 390 and 1440; no overflow 320-1920; CLS 0; hero CTA, #story, Sign in work; icon links present and all three icon URLs return 200 with correct types. Payload unchanged within noise (CSS slightly smaller, one more tiny observer in the navbar).

## Known issues
- At 16px the symbol is still intricate (person-X with a dot); it is bolder and more contrasty than before, not a different glyph. A simplified 16px glyph would be a logo decision.
- Headless Chromium does not fetch favicons, so "the browser loads it" is verified by link tags, 200 responses and decoded image sizes, not by a visible tab. Please hard-refresh once in a real browser.
- The hamburger button still has its own outline.
- Playwright specs needing an API were not run; Firefox/WebKit not re-run.
