# Chrome Web Store 0.3.0 living release plan

## Baseline and architecture

Current target: **0.3.0** on `release/chrome-web-store`. Qualified engineering baseline: `a11c3839d8c02d9b90dd7501c74513c29af4e98c`. Extension architecture remains user-controlled MV3, with a toolbar-opened nonmodal in-page assistant and Popup / Side Panel fallback. Permissions and hosts are unchanged by this metadata checkpoint. Build version derives from `sourceManifest.version`; final packaging remains a later clean-commit operation.

Official known Store item ID: `gnibjomjfdobadlockphjiibbpmiehcj`. Canonical Store URL: **OWNER/DASHBOARD VERIFICATION PENDING**; do not invent a slug. Current historical Store draft: **0.2.0**. Historical ZIP `apps/extension/xpertapply-extension.zip`, 203500 bytes, SHA-256 `30c8784dd755b982cb18fe6cd99c6474b96ed4a82585f9e731db0d27f0f545a4`, is preserved historical evidence and is not the final 0.3.0 artifact.

## Decisions and scope

CWS-PREP-04 froze exactly 15 metadata, test-expectation and release-document paths. CWS-PREP-05 stopped before edits because generated-manifest qualification required a build. CWS-PREP-05R authorizes exactly one temporary production build for the two focused tests, then byte-exact restoration of entry `dist`. The temporary dirty-tree build is qualification evidence only, not a final release artifact or Store-uploadable evidence. Final 0.3.0 ZIP remains **NOT BUILT**; final SHA remains **PENDING CWS-PREP-13**.

Primary access disclosure must explain toolbar-selected local discovery, relevant context sent for requested assistance, explicit Fill, employer visibility of entered values, and manual legal/consent/final Submit. A UI surface change establishes no new data category. No runtime, build-system, production or Store mutation is part of this checkpoint.

## Progress and validation

Engineering qualification at the baseline is carried forward; it is not a claim of final package qualification. This stage updates source/version mirrors and exactly two strict test expectations. Validate with one `npm run build` in `apps/extension`, then `npm test -- src/__tests__/generated_manifest.test.ts src/__tests__/toolbar_overlay.test.ts`. Qualification completed: exactly one temporary production build; both focused test files PASS (23/23 tests), temporary manifest 0.3.0 with exact permissions/hosts and dirty identity. All 12 entry dist files restored with deterministic inventory digest `e705ea757e307dd58767136c4957fdd9b2c380b69352cd55809595ca969321e5` unchanged; historical ZIP size/SHA unchanged. External checkpoint evidence: `/private/tmp/xpertapply-cws-prep-05r/`. Final package qualification remains pending. External entry backup and deterministic inventory must prove `dist` restored byte-for-byte; historical ZIP size/SHA must match. Review all 15 paths, lockfile's two root slots only, unchanged permissions/hosts, and an empty unexpected-hunk set before the single local commit. No full suite, package command or push in this stage.

| Gate | Current status |
| --- | --- |
| Final 0.3.0 ZIP / SHA / package-entry and remote-code audit | NOT BUILT / PENDING CWS-PREP-13 |
| Canonical Store detail URL | OWNER/DASHBOARD VERIFICATION PENDING |
| Production Web Store ID/URL deployment and positive handoff proof | PENDING |
| NEW-04 HTTP security headers | OPEN / P1 |
| PROXY-01 production proxy/body-limit qualification | OPEN / manual production qualification required |
| Four Store screenshots / required 440×280 promo | PENDING |
| Dashboard listing, privacy labels and distribution reconciliation | PENDING |
| Store-delivered same-item signed N baseline | PENDING |
| Signed N → 0.3.0 update proof / final installed audit | PENDING |
| Manual ATS / manual accessibility | PENDING |
| Package upload / Submit for Review / publication | NOT AUTHORIZED / NOT PERFORMED |
| Review approval/status | PENDING |

## Ordered rollout and dependency gates — all future stages PENDING

| Stage | Authorized scope only when separately instructed |
| --- | --- |
| CWS-PREP-05-PUSH | Verify parent and remote baseline, then normal fast-forward push of this local checkpoint; no edits/tests/builds. |
| CWS-PREP-06 | Prepare Store-ID Web configuration and any explicitly scoped consistency guard; no deployment. |
| CWS-PREP-07 | Prepare NEW-04 Web CSP / powered-by source changes and local qualification; no deployment. |
| CWS-PREP-08 | Inspect effective privileged edge configuration and back up scoped vhosts; separately authorized HSTS/nosniff rollout only to relevant hosts. |
| CWS-PREP-09 | Separately authorized production Web-only deployment with verified ID/URL and qualified Report-Only CSP. |
| CWS-PREP-10 | Read-only CSP observation and closure decision; no enforcement. |
| CWS-PREP-11 | Separately authorized qualified enforcing CSP rollout, validation and rollback readiness; NEW-04 closure proof. |
| CWS-PREP-12 | PROXY-01 effective proxy inspection and bounded synthetic upload qualification; failure requires separate repair scope. |
| CWS-PREP-13 | Clean pinned committed source; preserve/archive historical ZIP first; one fresh final production package, SHA, entry inventory and remote-code scan. |
| CWS-PREP-14 | Actual-product synthetic screenshots/promo and manual ATS/accessibility acceptance. |
| CWS-PREP-15 | Dashboard read-only ownership, canonical URL and version verification first; draft metadata saving needs separate authorization. |
| CWS-PREP-16 | Establish Store-delivered same-item signed N baseline before overwriting draft N; any 0.2.0 restricted review and Private/tester delivery each need separate authorization and version-accurate N metadata. |
| CWS-PREP-17 | Separately authorized exact final 0.3.0 draft upload; stop before review or publication. |
| CWS-PREP-18 | Separately authorized restricted N+1 review and delivery, actual signed N → 0.3.0 update, production handoff and final installed audit; no public action. |
| CWS-PREP-19 | Final public readiness audit, then separate public review/publication authorization. |

Signed N requires an existing Store-delivered install or an authorized same-item restricted baseline delivery. An unsigned local ZIP, local key or simulation cannot satisfy it. Baseline restricted review is distinct from final Public review, preventing a dependency cycle. Private/restricted delivery still requires policy review and explicit publication/delivery authorization.

NEW-04 and PROXY-01 remain production readiness gates before final submission/publication and production restricted tester readiness; they do not inherently block metadata, local packaging or a draft upload. Production Web deployment is required for actual production Store-installed handoff and final submission/publication, but not inherently for package creation or draft upload. None of those later operations is authorized here.

Manual ATS scope: dedicated Greenhouse, Lever and Ashby flows; limited Workday standard/multi-step behavior and generic HTML. Special fixtures do not establish universal coverage. Accessibility: keyboard, visible focus, VoiceOver with a single live complementary surface, 200% zoom, small/low-height viewport, Mac scaling, forced colors, reduced motion, close/minimize/restore and fallback access.

## Rollback

Before commit, restore only authorized metadata/docs from recorded baseline if a separately directed rollback is needed; never reset unrelated work. Restore generated `dist` from the external entry backup even if qualification fails. After commit, use a separately authorized revert of the checkpoint rather than history rewriting. Each future production rollout must have its own scoped backup/rollback plan. The historical ZIP stays frozen until the explicitly authorized final packaging stage.
