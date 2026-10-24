# XA-EXT-PANEL-05 — assistant panel rendering under host-page CSS, and a clearer status hierarchy

Status: implemented on `feature/xa-core1-direct-autofill` after `a5644e8`. Not pushed, not deployed. **RELEASE STAYS BLOCKED until a real-Chrome staging retest** (every result here is a real Chromium against local fixtures and a mock API; the user's live Plaid/Ashby page was not available).

## Reproduction and root cause

Two things were tried before any code change.

1. The panel on a faithful Ashby fixture (hostile element CSS, inner scroller, 33 discovered fields, 30 unresolved, website-launched and direct entry), 5 viewports × 3 zooms and 5 panel widths (≈280–480 px), normal and a synthetic worst case (every warning visible, a 130-character job title, 4-digit counts): **0 overlapping or escaping text runs in 120 states on the previous build.** The layout itself was not the failure under neutral host CSS.
2. The same panel under a page rule aimed at `div` (the overlay host is a `div`): **reproduced.**
   * `div{line-height:.55!important;font-size:13px!important}` → on `a5644e8` the host computes `line-height: 7.15px`, and the count numbers overlap their labels ("3" over "Filled by XpertApply", "0" over "Skipped", "30" over "Review"): the reported defect (`panel05-before/hostile-lineheight.png`).
   * `div{letter-spacing:.3em;white-space:nowrap;text-align:justify;text-transform:uppercase;…}` → the whole panel and every field badge become letter-spaced, clipped, upper-cased text (`panel05-before/hostile-div.png`).

Mechanism: each XpertApply surface is a closed shadow root under a page-visible `div`. Page selectors cannot match inside the shadow tree, but they do match the host, and inheritable properties set there flow in. `:host{all:initial}` does not stop this because a page rule out-ranks a `:host` rule in the cascade (the host even computed `position: relative`).

Not established: whether Plaid's Ashby page carries such a rule. Its listing page has almost no global element rules; the application page, the user's Chrome font/zoom settings, or another extension's CSS could be the actual trigger. The mechanism and the exact symptoms are reproduced; the specific trigger on the user's machine is a hypothesis.

## Changes
* `content/hostIsolation.ts` (new): `isolateHost` pins the host's geometry and inheritance as inline `!important` (beats any stylesheet rule); `isolatedTextBase` is applied with `all:initial` to the first element INSIDE each shadow root so whatever the host inherited is discarded.
* Applied to the assistant overlay (`[data-overlay-root]`), the field-badge layer (host and every `.status`), and the toolbar disclosure.
* Panel redesign (`content/applicationOverlay.ts`, `ui/applicationAssistant.ts`, `content/widget.ts`), navy/white/cyan kept: status card with one heading and a plain summary; 2×2 count cards that wrap their labels; documents card; separate warning cards; primary action, a retry/continue/refresh row, then clear/mark-complete after a divider; account card with `data-kind` = `account | website | disconnected`; header title clamps at three lines; minimize/close do not shrink; `.quiet` buttons styled as links (they were unstyled grey bars); the widget's raw lifecycle line (`TECHNICAL_REVIEW_REQUIRED · ATS populated 1 · …`) moved into a collapsed "Technical details".
* Honest status: a partial fill is announced in the summary ("Partially filled: XpertApply filled N of M fields…"; the status heading text is unchanged because many specs assert it), says XpertApply filled N of M fields, that values the employer/browser entered are not counted, how many required questions remain, and that an attached resume is not a completed application. The submit-step card no longer repeats the counts.

## Autofill accuracy (Ashby fixture)
Name, email, phone, LinkedIn and resume are filled and verified. The required location stays empty because the mock profile has no location: its reason is `answer_missing` (no saved answer), not a failed write; it is flagged invalid on the page and not counted as filled. Every unresolved card in the fixture carries `answer_missing`; none carries a write-failure code. Whether the user's live empty email/phone were missing profile data, an unsupported input or a write error cannot be told from a screenshot; the reason code on each card and the technical details now make it readable.

Known gap found, not fixed: the review cards are generic ("This question needs your answer") because the ledger carries no question wording. An attempt to show the form's own label was **reverted**: for radio groups the discovered label is the option ("Yes"), and the mapping from ledger key to field was not reliable, so it risked naming the wrong question. A reliable per-question label needs a ledger change.

## Validation
See the handoff and `docs/plans/evidence/panel05-before/`, `panel05-after/` (screenshots, `PANEL-FINDINGS.json`). Specs: `e2e/xa-panel05-layout.spec.ts` (P1 matrix, H1/H2 hostile CSS, W1/W2 website launch, A1 reasons); unit `xa_panel05_host_isolation.test.ts`, `application_assistant.test.ts`.

## Final gate
tsc clean; vitest 101 files / 1535 tests pass; production, staging, development, e2e and staging-granted builds succeed; **final full Playwright run (one worker, zero retries, no exclusions): 230 passed, 0 failed.** Earlier full runs: 7 failures (my status-heading change, reverted), then 1 (`zz-3c2-frame-discovery:288`, unrelated, passes alone and on the next full run; likely load). Logs are on disk, gitignored, in `docs/plans/evidence/xa-panel05-playwright-full*.log`.

## Rollout / rollback
Extension only. Roll back by shipping the previous build. No backend, permission or authentication change.

## Known limits
Zoom is emulated through the device-metrics override (as in earlier visual specs). Real fonts and OS text scaling on the user's machine were not reproduced.
