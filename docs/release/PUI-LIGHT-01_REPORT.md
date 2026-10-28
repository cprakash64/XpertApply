# PUI-LIGHT-01: the public website is always light

Web-only, local, not deployed or pushed. Base `7269b3f`. The hero, navbar, typography, logo, colours, glow and story are unchanged (a pixel diff of the homepage top against the previously approved light render differs only where the removed theme switcher used to sit).

## Behaviour
- **Public routes are always light**: `/`, `/login`, `/signup`, `/pricing`, `/privacy`, `/opensource`, the Google auth callback and any unknown path. Light does not depend on the OS setting or on a saved choice (light, dark or system).
- **The signed-in app keeps Light/System/Dark** (`/dashboard`, `/jobs`, `/matches`, `/tracker`, `/profile`, `/resume`, `/cover-letter`, `/application-answers`, `/demographics`, `/settings`). The theme infrastructure, the sidebar control and the Settings "Appearance" section are intact.
- **The saved choice is never rewritten** by visiting a public page: `data-theme` is resolved from the route first and the preference second.

## How (smallest robust change)
- One rule, `isThemedPath`, in `lib/theme.ts` (`THEMED_ROUTE_PREFIXES`) and the same list in `public/theme-init.js`; a unit test compares them. `theme-init.js` sets `data-theme` before first paint using the route; `ThemeSync` re-resolves on client navigation (log in, log out) in a layout effect, so no frame paints in the wrong theme, and on OS or cross-tab changes. No CSS specificity tricks, no forced re-theming loop: the public page simply never receives `data-theme="dark"`.
- Each public route exports `viewport = publicViewport` (`color-scheme: light`, `theme-color: #ffffff`), so the browser's own canvas, scrollbars and tab colour are light from the first byte of HTML, even before the script runs. The root layout keeps its two-scheme viewport for the app.
- Removed the Light/System/Dark control from the navbar, the mobile menu, the info pages' header and login/signup. No gaps are left.
- Removed the now-unreachable dark marketing code: the dark role block and dark button/nav/screenshot rules in `marketing.css`, the dark story captures (`*-dark.webp`) and their markup. The dark logo mark stays for the app.
- Logo: public pages show the light mark (no tile). Favicon unchanged.

## Files
`lib/theme.ts`, `lib/publicViewport.ts` (new), `public/theme-init.js`, `components/ThemeControl.tsx` (ThemeSync), `components/marketing/MarketingNavbar.tsx`, `components/marketing/ProductDemo.tsx`, `components/marketing/workflowStages.ts`, `components/PublicPage.tsx`, `components/AuthDialog.tsx`, `app/marketing.css`, viewport exports in the public `page.tsx` files, `app/auth/google/callback/layout.tsx` (new); tests `theme-preference`, `public-no-theme-control` (new), `landing-page`; `e2e/public-light.spec.ts` (new); two dark story assets deleted.

## Verification
- eslint 0, tsc 0, vitest 56 files / 1091 tests (new: route classification, light on every public path for every choice x OS, app applies the choice, init script and lib agree on every route/choice/OS combination, route lists identical, choice not rewritten, ThemeSync across public/app navigation, no switcher on any public surface, every public route exports the light viewport).
- Isolated production build (`.next` untouched). Chromium e2e (non-live): 46 passed, 20 skipped (API-dependent); new `public-light` spec 4/4.
- Scenario matrix on the production build, 192 public page loads: OS light/dark x saved none/light/dark/system x 1440/390 x 6 public pages x direct navigation and reload: always `data-theme="light"`, light body background, light logo, no theme radios, `theme-color #ffffff`, `color-scheme light`, and the saved choice unchanged. App matrix (6 OS/choice combinations): follows the saved choice, else the OS, theme control present. Login/logout soft navigation: dashboard (dark) -> log out -> `/login` light with the choice still `dark` -> log in -> dashboard dark. First paint with JavaScript blocked, OS dark + saved dark: `/` and `/login` light, `/dashboard` dark. WebKit: `/` and `/login` light under OS dark + saved dark. axe (WCAG 2.2 A/AA) on the 6 public pages at 390 and 1440 under OS dark + saved dark, plus the homepage scrolled over the navy section: 0 violations. No hydration or console warnings were seen.
- Evidence: `docs/release/evidence/pui-light01/` (homepage top, scrolled over a light and the navy section, mobile menu, login, signup and pricing, all captured with OS dark + saved dark, at 1440 and 390).

## Not verified / notes
- 20 API-dependent Playwright specs skipped (no live API); authenticated screens use a mocked API.
- Firefox untested. Visitors without JavaScript get light everywhere (the app too).
- The root error boundaries are shared; they resolve by path like every other route.
- A new top-level app route must be added to `THEMED_ROUTE_PREFIXES` and `theme-init.js` or it will render light (the unit test guards the two lists, not the route set).
