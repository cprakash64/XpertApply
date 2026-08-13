# Marketing homepage visual parity

## 2026-08-13 final visual reconciliation

This pass is limited to scale, spacing, wrapping, and responsive fit. It does not
change the approved copy, palette, routes, pricing behavior, workflow state model,
authentication, dashboard, API, database, or extension behavior.

Measured desktop reconciliation:

- Story shell increased from the prior 1360px base / 1460px wide cap to 1500px /
  1560px. At 1770px the live shell measures 1560px, with a 994px product mock;
  at 1366px the mock measures 824px.
- The product mock now uses a 520px desktop body (455px in short-height desktop
  viewports), a 180px sidebar, a wider 1.08fr/0.92fr workspace split, and a
  474px floating controller. The prior 590–630px body was visually tall but
  under-scaled internally.
- Story typography now holds the approved two-line heading with an 850px measure.
  The follow-up phrase is kept together without altering its accessible name.
- The extension shell increased to 1320px and uses a measured 516.6px / 743.4px
  copy-to-visual split with a 60px gap at 1770px. Its approved headline is held
  to four explicit visual lines while retaining one continuous accessible heading.
- The final CTA uses an 820px copy column, 800px heading measure, 54px maximum
  heading size, 44px column gap, and 56px card padding, producing the intended
  two-line desktop headline.
- Footer spacing increased to 50px / 48px with a 1.28fr brand column, four .72fr
  link columns, 44px gaps, 13–13.5px navigation type, and a 38px bottom-row gap.

Browser validation completed at 1770×863, 1440×900, 1366×768, the 1280px
breakpoint at both 1280×801 and the more constrained 1280×720 browser-harness
fallback, 820×900, and 390×844. All measured zero horizontal overflow. The
1366px and constrained 1280px checks keep the product mock and floating controller
visible together; tablet and mobile stack the story and extension grids cleanly.

Validation after the final reconciliation:

- `npm run typecheck` passes.
- `npm run lint` passes.
- Focused homepage/auth tests pass (32/32).
- `npm run build` passes and generates all public and authenticated web routes.

Rollback remains limited to the marketing stylesheet, the two marketing heading
components, and this plan. No data or schema rollback is required.

## 2026-08-13 supplied reference update

The exact source of truth is now available at
`/Users/cprakash/Documents/Jobs/Media/XpertApply_finished_design.html`. The production
homepage has been reconciled to its palette, measurements, copy, six-stage demo,
extension illustration, trust band, CTA, footer, pricing overlay, responsive rules,
and embedded XpertApply logo asset. Existing Next.js routes and accessibility
behaviour remain authoritative where the standalone HTML used placeholder `#` links.

Validation completed after the update:

- Web typecheck passes.
- Web lint passes.
- Homepage and auth tests pass (32/32).
- Browser inspection at 1440×900 confirms hero, sticky workflow mock, and pricing
  geometry. Responsive breakpoint rules were reconciled directly with the supplied HTML.

Rollback is limited to the marketing components, the namespaced marketing stylesheet,
the copied logo asset, and the homepage test expectations listed in this plan; no API,
database, extension, or authenticated product behavior changed.

## Goal

Reconcile the logged-out Next.js homepage with the approved
`XpertApply_finished_design(4).html` composition while preserving the public,
fetch-free route, real authentication destinations, pricing behavior,
accessibility, and responsive behavior.

## Source material and constraints

- The supplied attachment contains the detailed reference measurements and
  section requirements. The named HTML file and comparison screenshots were
  not present in the attachment directory or repository, so implementation and
  validation use the explicit values and compositions recorded in that brief.
- Marketing styles remain isolated in `app/marketing.css`; no authenticated
  product styles are changed.
- The existing Chrome Web Store configuration gate remains authoritative.
- Existing unrelated changes, especially `apps/extension/src/config.ts`, are
  out of scope and must remain untouched.

## Architecture and decisions

- Keep the homepage as a server-rendered composition with the existing client
  islands for navigation, scrollytelling state, and the pricing dialog.
- Keep one continuous scroll-progress fill and derive all story state from the
  shared `WORKFLOW_STAGES` data.
- Rebuild the product demonstration around one stable job-list workspace; only
  the active sidebar, workspace heading, and detail panel evolve by stage.
- Use a reusable two-color XpertApply wordmark everywhere. The repository has
  no reusable logo image asset, so the temporary rounded-square `X` is removed
  rather than replaced with another invented lettermark.
- Preserve only routes that exist. Approved footer labels without routes render
  as plain text so column geometry remains intact without introducing 404s.

## Implementation progress

- [x] Inspected worktree, current marketing components, stylesheet, homepage
  tests, routes, brand assets, and rendered desktop baseline.
- [x] Restore reference navbar, hero, story geometry, copy, product mock,
  extension illustration, security split, final CTA card, and footer taxonomy.
- [x] Update parity-focused homepage tests.
- [x] Validate required viewports and key section scroll positions in-browser.
- [x] Run typecheck, lint, homepage tests, full frontend tests, and build.

Final validation: 24/24 focused homepage tests passed; typecheck, lint,
production build, and Docker Compose configuration passed. Full frontend tests
passed after updating the shared auth-route assertion to accept the approved
"Get started free" CTA wording.

## Validation

Required browser viewports at 100% zoom:

- 1770×863
- 1440×900
- 1366×768
- 1280×800
- 820px tablet
- 390px mobile

Desktop checkpoints: hero, story intro, all six workflow stages, extension,
security, final CTA, footer, and pricing modal. Also verify no horizontal
overflow and that the controller remains visible at 1366×768.

Commands:

- `npm run typecheck` in `apps/web`
- `npm run lint` in `apps/web`
- focused landing-page test
- `npm test` in `apps/web`
- `npm run build` in `apps/web`
- `docker compose config`

## Rollout

The change is isolated to the public homepage and can ship with the existing
web deployment. No migration, provider configuration, API rollout, or extension
release is required.

## Rollback

Revert only the marketing homepage files and this plan. No data or schema
rollback is required. The existing route/auth behavior is unchanged.
