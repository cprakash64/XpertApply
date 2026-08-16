# Responsive authenticated application shell

Status: implementation and production-release audit complete. Release commit
and push are authorized in this stage; production deployment is not.

## Problem and current architecture

Every authenticated page is wrapped in `apps/web/components/AppShell.tsx`.
The shared `SideBar` owns the brand, primary routes, Settings, canonical Logout,
active-route styling, and the Jobs workspace collapse API. Its current class
chain is `hidden ... lg:flex`; the main content offset also starts at `lg`.
Consequently all application navigation disappears below Tailwind's 1024px
`lg` breakpoint. There is no authenticated mobile header or drawer.

Authenticated route coverage is centralized for Dashboard, Jobs, Resumes,
Tracker/Applications, Profile and its subsections, Settings, matches, generated
application answers, and cover letters. `/jobs/[id]` and `/demographics`
redirect into protected shell routes. People/referrals is a Jobs workspace tab,
not a standalone route.

## Responsive architecture decision

Use the existing Tailwind breakpoints as three deterministic modes:

- `< 640px` (`sm`): mobile header plus an initially closed modal navigation
  drawer. No permanent horizontal rail is reserved.
- `640px–1279px` (`sm` through `xl - 1`): an always-visible 64px compact rail.
  Expansion overlays content and adds a dismissible backdrop; main content
  remains offset by 64px. Overlay is chosen because pushing a 256px sidebar at
  tablet widths would make Jobs, Profile editors, and dashboard grids unstable.
- `>= 1280px` (`xl`): the existing 256px expanded sidebar or 56px collapsed
  rail, controlled by the user's persisted desktop preference and existing
  Jobs workspace request semantics.

Only one route configuration and shared navigation renderer will be used by
the desktop/tablet sidebar and mobile drawer. Nested Profile routes activate My
Profile; `/matches` activates Find Jobs; application-answer and cover-letter
routes activate My Resumes.

## State and lifecycle

- Persist only the desktop expanded/collapsed preference in localStorage.
- Never persist tablet expansion or mobile drawer state.
- Close transient navigation on route change and when leaving its breakpoint.
- Mobile open state owns focus trapping, Escape handling, focus restoration,
  and a reversible body scroll lock.
- Fixed navigation surfaces remain vertically scrollable when a short or
  zoomed viewport cannot fit every action.
- Tablet expansion uses an overlay/backdrop and Escape dismissal without
  changing the content offset.
- Auth invalidation continues to unmount `AppShell`, automatically removing
  every rail, drawer, backdrop, listener, and scroll lock.

## Accessibility and interaction

- Native buttons and links, labelled navigation landmarks, `aria-current`,
  `aria-expanded`, and `aria-controls`.
- Icon-only rail items retain accessible names and hover/focus tooltips.
- Mobile drawer uses a labelled modal dialog containing Primary navigation.
- Focus enters at Close, is trapped within the drawer, and returns to Menu when
  dismissed without navigation.
- Backdrop and Escape dismiss; route selection closes without stealing route
  focus. Touch controls are at least 44px high.
- Existing global reduced-motion rules collapse transitions.

## Validation plan

- Component tests: shared item order, nested active routes, desktop persistence,
  tablet expand/collapse, mobile open/close, Escape, backdrop, focus trap,
  route-close behavior, body-scroll restoration, canonical Logout, and auth
  invalidation while open.
- Playwright: real layout and behavior at 1440×900 desktop, 900×900 tablet, and
  390×844 phone; include resize transitions and mobile auth expiry.
- Inspect Dashboard, Jobs, Tracker, Profile, and Settings for shell-induced
  overflow without redesigning their content.
- Run focused and complete web tests, typecheck, lint, production build,
  Playwright, visual screenshots, and `git diff --check`.

## Rollout and rollback

This stage creates and pushes one reviewed web release commit. Production
deployment remains a separately authorized stage. Rollback is a web-only
redeploy of the prior SHA; there are no backend, schema, data, provider, or
secret changes.

## Progress

- [x] Audit current shell, breakpoints, route coverage, and auth integration.
- [x] Choose breakpoints and tablet overlay behavior.
- [x] Implement responsive shell.
- [x] Add component and browser coverage.
- [x] Complete verification and visual inspection.

## Validation results

- `make test-web`: passed (lint, typecheck, production build, 42 test files and
  804 tests).
- Focused responsive/session/Jobs coverage: 73 tests passed.
- Responsive Playwright suite: 8 scenarios passed against a production build at
  1440×900, 900×900, 390×844, and 390×667, plus a constrained 900×400 tablet
  height.
- Exact mode boundaries at 639px, 640px, 1279px, and 1280px are covered in a
  real browser.
- Visual screenshots inspected for desktop Dashboard, tablet expanded
  Dashboard, the mobile drawer, and phone Dashboard, Jobs, Applications,
  Profile, and Settings. Temporary images were kept outside the repository.
- `git diff --check`: passed.

Production-build browser testing also exposed a pre-existing cold-hydration
race in the protected-session boundary: its temporary server snapshot could be
interpreted as logout before the local token snapshot was available. The guard
now waits for client hydration before invalidating a missing session. This does
not change the canonical logout or 401 behavior; the browser suite verifies
that an open mobile drawer still disappears with the protected shell on 401.

The final release audit found one short-height accessibility gap: the drawer
could not scroll if future navigation content or browser zoom made it taller
than the viewport. The drawer now scrolls independently, and fixed tablet or
desktop navigation becomes scrollable only at constrained heights. Tests verify
that Settings and Logout remain reachable.

## Deferred page-level UI work

The shell creates no horizontal document overflow on the five core pages. The
Applications filter strip is dense at phone width and should become a
horizontally scrollable or wrapping page-level control in the later mobile UI
stage. Jobs filters and long Settings forms also remain candidates for that
broader page redesign; neither requires shell-specific branching.
