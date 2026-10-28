# PUI-THEME-01: unframed floating nav, unified logo, light/dark theme system

Web-only, local, not deployed or pushed. Base `d4f06de`. Hero, headline, colours, glow, CTAs, story architecture and Pricing-free nav are unchanged. The staging host's `b357260` image is not this design.

## Header strip: root cause and fix
Two things read as a frame across the hero: (1) the hero had `overflow: hidden`, which cut the halo flat where it passed under the navbar (a horizontal edge at the nav's bottom), and (2) the navbar's 14px top margin collapsed through `.xa-page`, leaving a 14px seam above the page container. Fixed by `overflow: visible` on the hero (the page already clips horizontally), `display: flow-root` on `.xa-page`, and a softer navbar shadow (`0 1px 2px /5%, 0 6px 20px /6%`). No wrapper, border or pseudo-element draws any header surface; the navbar itself is the only one.

## Navbar
Light initial: white 98%, borderless, 16px radius, 64px, 14px from the top. Light scrolled: white 80%, blur 18px, plus 93% over dark sections. Dark initial: `rgb(26 40 57 / 96%)`; dark scrolled: 76%, 90% over a dark section. Solid fallbacks for no `backdrop-filter` and reduced transparency; reduced-motion removes the transition; the mobile menu panel is always solid. Scroll state still comes from the IntersectionObserver sentinel (no scroll listener); a second observer marks sections `data-nav-tone="dark"`.

## Theme architecture (one system)
- `app/globals.css` already had a semantic role-token system (`--color-*`, Tailwind aliases). It is kept; dark is now `:root[data-theme="dark"]` instead of `@media (prefers-color-scheme: dark)`, so a user choice can override the OS.
- `public/theme-init.js`: a tiny blocking same-origin script (CSP-clean) that resolves the stored choice (`xa-theme`: light | dark | absent = system) to `data-theme` on `<html>` before first paint. `<html suppressHydrationWarning>` covers that single attribute.
- `lib/theme.ts` + `components/ThemeControl.tsx`: a three-way radio group (light, system, dark) built on `useSyncExternalStore` (server snapshot "system", so no mismatch), cross-tab and OS-change aware; `ThemeSync` keeps the page in step where no control is mounted. No dependency added.
- Control placement: marketing navbar and its mobile menu, the app sidebar footer, the Settings page (Appearance), the public info pages' header and the login/signup pages. Not in the hero.
- `app/marketing.css`: ~100 hard-coded surface, border and text literals were converted to variables, and a light/dark role block added for the page (`--xa-page/surface/tint/line/btn/halo/nav...`). The hero halo adapts (15% sky at the centre in dark).

## Tokens
Light: Midnight Ink `#17283f` (text, primary), Refined Sapphire `#3078ac` (accent fill/large text; links and focus use `#2a6a9a`, 5.5:1), page `#f7f9fc` in the app and white on the homepage, cards white, border `#dfe5ed`.
Dark: canvas `#101a28`, surface `#1a2839`, elevated `#243449`, text `#edf3fa`, secondary `#aabbd0`, muted `#91a5bd`, accent and primary action `#8db6d8` with `#101a28` text (8.2:1), borders `#33465d` / `#40536a`, control borders `#6a809b` (3.7:1 on cards), focus ring `#8db6d8`. All semantic status roles were re-derived on the slate surfaces. The token contract tests (WCAG pairs in both themes) pass.

## Logo
`BrandLogo`/`BrandMark` (one component): transparent 256px marks derived from the original 1448px logo (`xpertapply-mark.png`: Ink + Sapphire; `xpertapply-mark-dark.png`: light ink + `#5b9bcb`), the hidden one lazy. The wordmark is live text on theme tokens. Sizes by context: navbar 40, mobile 36, sign-in 44, sidebar 32-34, public pages 36. The sidebar's white bordered tile with the cropped lockup and the sign-in's 32px square are gone. Extension assets untouched (the extension has its own files). Favicon unchanged (already audited on light and dark in EDITORIAL-03).

## Other surfaces
Story screenshots have dark captures (`*-dark.webp`, same real UI, same sample data) swapped by theme. Login/signup, dashboard, jobs, job detail, tracker, profile, settings and the info pages follow the tokens in both themes.

## Verification
- eslint 0, tsc 0, vitest 55 files / 1076 tests (new: theme preference, init script vs `lib/theme` agreement, control keyboard and persistence, logo variants; theme/token contracts moved to the data-theme architecture).
- Isolated production build (`.next` untouched). Chromium e2e (non-live): 45 passed, 20 skipped; after updating the shell spec's palette expectations the shell specs pass 9/9. WebKit smoke: both themes render, nav blur and 0px border confirmed, no page errors.
- axe (wcag2a/2aa/21aa/22aa): 0 violations on login, signup, dashboard, jobs, tracker, profile, settings in both themes at 1440 and 390, and on the homepage in both themes at 390/1024/1440, at the top and scrolled over the trust section.
- Behaviour: first visit follows the OS; choosing dark persists across `/`, `/login`, `/pricing` and reload; system follows an OS change at runtime; explicit light beats OS dark; with JavaScript chunks blocked, `data-theme` and the dark background are already applied (no flash); no hydration or console warnings; mobile menu opens, stays solid, Escape closes it; no horizontal overflow at 320-1920 on any page captured.
- Payload vs `d4f06de` (gzip, homepage): CSS 19.4 to 20.1 KB, JS 182.8 to 186.1 KB, HTML 8.7 to 9.4 KB, plus a 0.5 KB cacheable `theme-init.js`. LCP median 56ms and CLS 0 for both (local, 5 runs).

## Not verified / limitations
- `profile-and-theme.spec.ts` and 16 other API-dependent Playwright specs skipped (no live API); their theme checks are covered by the scripted checks above, not by those specs.
- Authenticated screens were rendered with a mocked API and sample data; live behaviour is NOT VERIFIED here. Google sign-in appearance used a mocked "enabled" response.
- Not captured: every dialog and editor state (profile wizard steps, resume/cover-letter editors, toasts); they use the same tokens, but only dashboard, jobs, job detail, tracker, profile, settings, login, signup and info pages were inspected in both themes.
- Firefox untested. No-JavaScript visitors get the light theme (the old OS-only CSS fallback was removed with the attribute architecture).
- Meta `theme-color` still follows the OS, not the in-app choice.
