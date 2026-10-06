# Chrome Web Store 0.3.0 living release plan

## Baseline and architecture

Current target: **0.3.0** on `release/chrome-web-store`. Qualified engineering baseline: `a11c3839d8c02d9b90dd7501c74513c29af4e98c`. Extension architecture remains user-controlled MV3, with a toolbar-opened nonmodal in-page assistant and Popup / Side Panel fallback. Permissions and hosts are unchanged by this metadata checkpoint. Build version derives from `sourceManifest.version`; final packaging remains a later clean-commit operation.

Official known Store item ID: `gnibjomjfdobadlockphjiibbpmiehcj`. Canonical Store URL: **NOT YET AVAILABLE / NOT PROVEN; owner confirms Draft/unpublished**; do not invent a slug. Current historical Store draft: **0.2.0**. Historical ZIP `apps/extension/xpertapply-extension.zip`, 203500 bytes, SHA-256 `30c8784dd755b982cb18fe6cd99c6474b96ed4a82585f9e731db0d27f0f545a4`, is preserved historical evidence and is not the final 0.3.0 artifact.

## Decisions and scope

CWS-PREP-04 froze exactly 15 metadata, test-expectation and release-document paths. CWS-PREP-05 stopped before edits because generated-manifest qualification required a build. CWS-PREP-05R authorizes exactly one temporary production build for the two focused tests, then byte-exact restoration of entry `dist`. The temporary dirty-tree build is qualification evidence only, not a final release artifact or Store-uploadable evidence. Final 0.3.0 ZIP remains **NOT BUILT**; final SHA remains **PENDING CWS-PREP-13**.

Primary access disclosure must explain toolbar-selected local discovery, relevant context sent for requested assistance, explicit Fill, employer visibility of entered values, and manual legal/consent/final Submit. A UI surface change establishes no new data category. No runtime, build-system, production or Store mutation is part of this checkpoint.

## Progress and validation

Engineering qualification at the baseline is carried forward; it is not a claim of final package qualification. This stage updates source/version mirrors and exactly two strict test expectations. Validate with one `npm run build` in `apps/extension`, then `npm test -- src/__tests__/generated_manifest.test.ts src/__tests__/toolbar_overlay.test.ts`. Qualification completed: exactly one temporary production build; both focused test files PASS (23/23 tests), temporary manifest 0.3.0 with exact permissions/hosts and dirty identity. All 12 entry dist files restored with deterministic inventory digest `e705ea757e307dd58767136c4957fdd9b2c380b69352cd55809595ca969321e5` unchanged; historical ZIP size/SHA unchanged. External checkpoint evidence: `/private/tmp/xpertapply-cws-prep-05r/`. Final package qualification remains pending. External entry backup and deterministic inventory must prove `dist` restored byte-for-byte; historical ZIP size/SHA must match. Review all 15 paths, lockfile's two root slots only, unchanged permissions/hosts, and an empty unexpected-hunk set before the single local commit. No full suite, package command or push in this stage.

| Gate | Current status |
| --- | --- |
| Final 0.3.0 ZIP / SHA / package-entry and remote-code audit | NOT BUILT / PENDING CWS-PREP-13 |
| Canonical Store detail URL | NOT YET AVAILABLE / NOT PROVEN; Draft/unpublished owner evidence |
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
| CWS-PREP-09 | Separately authorized production Web-only deployment with known ID and qualified Report-Only CSP; keep URL unset while unavailable. |
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


## CWS-PREP-06R — owner-proven draft lifecycle and generic routing preparation

Authoritative owner Dashboard evidence: **XpertApply — Assisted Apply**, item `gnibjomjfdobadlockphjiibbpmiehcj`, **Draft**, uploaded package **0.2.0** (`ac64ea9 2026-09-19T20:51:04.476Z; production`), **not published**. Public canonical Store URL: **NOT YET AVAILABLE / NOT PROVEN; pending Store delivery/publication lifecycle**. Source preparation does not require that public URL now. The `empty-title` probe is not a listing URL and must not be configured.

Observed draft fields: category Workflow & Planning; English; 128×128 icon present; no screenshots, small promo or marquee uploaded (marquee remains optional/deferred); Official URL field None; homepage https://xpertapply.com/; support URL empty; mature content OFF; payment Free of charge; visibility selection Public; All regions selected. Public selection is not publication. Submit for review is disabled; reason **UNKNOWN**, because “Why can't I submit?” was not inspected. These are observed draft settings, not owner confirmation of final distribution choices or completed release gates.

Future build-time routing: `NEXT_PUBLIC_CHROME_EXTENSION_ID=gnibjomjfdobadlockphjiibbpmiehcj`; `NEXT_PUBLIC_CHROME_EXTENSION_URL` **MUST REMAIN UNSET** until an authoritative usable official Store URL exists. Production deployment remains PENDING. ID_ONLY_WEB_DEPLOYMENT: **REQUIRED_BEFORE_PRIVATE_STORE_HANDOFF** for actual production handshake qualification: browser-routed ping and account teardown require the explicit ID, while install CTA can safely stay unavailable and AutoApply falls back to documentation. This is not a prerequisite for merely drafting/reviewing the Store item. Next.js public values require a Web image rebuild; future deployment is Web-only, no API restart or extension rebuild for ID routing alone. No deployment here.

Current-source mismatch evidence: prior `chromeExtensionUrl()` accepted an official-host non-root URL independently of `chromeExtensionId()`. ID A / URL B was accepted. Generic preparation now requires an HTTPS current Store detail route ending in an exact 32-character a–p identifier; when ID is also configured, the URL identifier must equal it. Harmless slug/query/fragment do not define identity. Malformed/ambiguous paths, encoded identifiers/traversal, wrong host, root and mismatched pairs produce no install URL. Runtime routing still uses only the independently validated explicit ID; no URL-derived routing, network validation or hardcoded product ID. ID-only remains valid during draft lifecycle. Targeted qualification: PASS, four directly affected Web unit files / 84 tests; no production build. Detailed evidence is outside Git in `/private/tmp/xpertapply-cws-prep-06r/`.

SIGNED_N_BASELINE: **NOT ESTABLISHED**. Neither the local historical ZIP nor the Dashboard upload is Store-delivered signed N. Later separately authorized same-item Private/trusted-tester review/delivery must establish whether signed 0.2.0 N is feasible before 0.3.0 replaces it. Final 0.3.0 ZIP remains NOT BUILT; NEW-04 OPEN/P1, PROXY-01 OPEN, assets/manual acceptance/final Dashboard reconciliation remain pending. No push, production action, Store mutation, upload, review submission or publication in this stage.
