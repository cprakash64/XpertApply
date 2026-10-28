# PUI-EDITORIAL-02: hero glow, floating navbar, unified logo, no Pricing in nav

Web-only, local, not deployed or pushed. Base `d127190`. Hero wording, layout, CTAs, palette and the story are unchanged.

## Changes
- **Hero glow:** one `.xa-hero::after` radial layer behind the headline (z-index -1, `pointer-events: none`, no blur filter, no animation, no JS): `#c8dbec` 55% to `#ddeaf5` 36% at 40% to `#eaf2fa` 16% at 70% to transparent; 1320x640 (max 160% of width) on desktop, 170% x 420 on phones. Clipped by the hero's `overflow: hidden`, so no horizontal overflow; fades to 0 inside the hero, so there is no visible edge.
- **Navbar:** floating again: sticky, 14px from the top (safe-area aware), content-width, 64px tall, 16px radius, white 98%, `#dfe5ed` border, soft two-layer shadow. Scrolled (`data-scrolled="true"`): white 90%, `backdrop-filter: blur(16px) saturate(1.3)`, quieter shadow, 220ms transition. Fallbacks: solid white without `backdrop-filter` support and under `prefers-reduced-transparency`; no transition under `prefers-reduced-motion`. The mobile menu panel is always solid white. Scroll state comes from an IntersectionObserver on a 1px sentinel (no scroll listener); sticky positioning means no layout shift.
- **Logo:** `xpertapply-mark.png` and `xpertapply-logo-256.png` recoloured by per-pixel mapping (turquoise to Refined Sapphire `#3078ac`, navy to Midnight Ink `#17283f`), derived from the original 1448px raster; geometry, aspect ratio, sharpness and (for the mark) transparency preserved. Consumers: marketing navbar, footer, extension panel (BrandWordmark, mark), app shell and sign-in dialog (256 logo). New `app/icon.png` (128px mark) is served as the favicon (there was none).
- **Pricing:** removed from the desktop and mobile header navigation (remaining: Product, Extension, Security, Sign in, Get started). The `/pricing` page, the dialog and its provider, and the footer's Pricing link are untouched.

## Files
`components/marketing/MarketingNavbar.tsx`, `app/marketing.css`, `__tests__/landing-page.test.tsx`, `public/brand/xpertapply-mark.png`, `public/brand/xpertapply-logo-256.png`, `app/icon.png` (new).

## Evidence
`docs/release/evidence/pui-editorial02/`: `before-d127190-home-*`, `after-{A-top,B-mid,C-lower}-{320,390,768,1024,1440,1920}.png`, navy-under-nav, focus, hover and mobile-menu captures, `after-fullpage-1440.png`. Tuning passes: glow enlarged and softened; scrolled opacity raised from 86% to 90% because over the navy section 86% read grey.

## Verification
eslint 0; tsc 0; vitest 54 files / 1059 tests pass (4 pricing-dialog tests now use the dialog's own trigger; new tests assert no Pricing in the header, the five remaining destinations, and the scroll-state toggle); isolated production build; `responsive-app-shell` Chromium specs 9/9; axe wcag2a/2aa/21aa 0 violations at 390 and 1440; no overflow 320-1920; asset URLs (`mark`, `logo-256`, `icon.png`, story images) all 200; Tab reaches Product with a visible focus ring; hover state works; nav top stays at 14px across scroll positions; the Extension anchor lands 150px below the bar; mobile menu opens, lists 5 destinations with 42-44px targets, Escape closes it, and it stays solid when scrolled over the navy section. Payload (gzip): CSS 19.1 to 19.5 KB, JS 183.0 KB (unchanged); no new dependency.

## Known issues
- One of seven automated runs at 390px reported CLS 0.086 while the machine was busy; six runs and a dedicated trace (3 runs) showed 0. Not reproduced, not explained.
- `profile-editors` unit test failed once under load, passed alone and in the full re-run (pre-existing flake pattern).
- The recoloured 256px logo changes the authenticated app shell and sign-in dialog (intended by the brand-unification request); the original asset remains in git history. The browser extension's own icons were not touched (they are separate files); whether it should follow the new palette is a separate decision.
- Shared `app/icon.png` also changes the favicon for the signed-in app.
- Playwright specs that need an API were not run (they skip). Firefox/WebKit not re-run.
