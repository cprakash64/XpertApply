# XA-13 — Pre-match DOM probing / dormancy gate

## Finding and classification

XA-13 is the final original Medium finding: “Every frame of every HTTPS page is scanned before any handoff match, contradicting the documented dormancy gate.” The current implementation at checkpoint `1fd837ce3d754c2f5153cc85deaa88e6d33d6aad` was classified as **PARTIALLY PRESENT** before remediation. XA-06 removed broad static injection, but any employer/ATS content entrypoint that did run still eagerly constructed `CONTENT_READY.probe` by calling `buildFrameProbe()` and `probeFrame(document)` before the worker returned an exact handoff match.

The isolated pre-fix Chromium trace was:

1. `content-script-start`
2. `checkHandoffAndStart-start`
3. `buildFrameProbe-start`
4. `probeFrame-start`
5. `buildFrameProbe-end`
6. `CONTENT_READY-send`
7. `handoff-response-received` (`matched: false`)

The no-handoff page received only its own document and favicon requests; no widget appeared and no inputs were filled. The defect was the premature DOM read and in-memory probe transfer, not autofill, submission, or an off-device disclosure.

## Architecture decision

The shipped path is now two-phase:

1. The employer/ATS content entrypoint registers inert message handling and sends `{ type: CONTENT_READY }` only.
2. The worker derives tab, frame, URL, and origin from Chrome `MessageSender`.
3. The worker validates the live handoff, exact frame workflow relationship, session-authority generation, and current exact-origin permission.
4. Only then does the worker send the closed `PROBE_FRAME_APPLICATION`
   message, targeted to both the Chrome-supplied frame ID and the immutable
   document ID that sent readiness.
5. The content frame runs `probeFrame(document)` and returns minimized probe evidence.
6. The worker validates the response shape, rechecks live workflow, expiry,
   permission, and generation after the async boundary, and registers it under
   Chrome-supplied tab/frame/document identity.
7. Package loading and the existing authorized workflow continue only after a valid probe result.

The current `CONTENT_READY` type and schema are type-only. The shared parser's established rolling-upgrade policy ignores unknown properties, so an older content instance can still announce readiness, but the worker ignores its legacy fields. They are not an authorization input and current content sends none of them. A missing or malformed probe, revoked permission, or stale generation fails closed before package retrieval or autofill.

`frameId` alone is not document identity because Chrome reuses it across
navigation. Readiness therefore requires the Chrome 106+ `MessageSender.documentId`
and the worker supplies that ID to `tabs.sendMessage`. If document A navigates
before the request, Chrome does not deliver the request to replacement document
B. The deterministic navigation-race test requires zero B probes and no frame
registration.

## Privacy, performance, and retention

Before authorization, no DOM-derived URL, labels, root verdict, score, body text, form metadata, profile, résumé, or mutation observation leaves or runs in the employer frame. The no-handoff probe count and attributable probe CPU time are therefore zero.

After authorization, the existing minimized probe contains sanitized origin/path, application-label identifiers, a root-confidence boolean, and a numeric best score. The worker stores its reduced registry record in memory for 60 seconds. It is not persisted and no new network transmission or content-bearing log was added.

## Tests and acceptance

Targeted unit coverage asserts:

- no handoff produces no worker probe request;
- a valid exact handoff produces one explicit request;
- revoked exact-origin permission produces no probe;
- a probe result crossing an authority-generation change is discarded;
- document replacement between readiness and probe cannot inherit the request;
- existing legitimate nested ATS authorization continues.

The real MV3 test instruments a disposable copy of the shipped `probeFrame` function. It force-injects the production content entrypoint into a realistic page with a persistent exact host grant but no workflow and requires probe count `0`, no widget, and no changed inputs. Its positive control binds an exact live workflow and requires a post-authorization probe count greater than zero.

The mandatory negative control mutates only the disposable test bundle to restore `CONTENT_READY` eager probe construction. The principal no-handoff assertion must fail with a count above zero. The mutation is environment-gated, affects no tracked production file, and the unmutated test is rerun afterward.

Multi-frame acceptance uses the existing employer + legitimate ATS + unrelated ad MV3 suite: only workflow-authorized and exact-permission frames may be injected or probed; the ad origin receives neither a grant nor profile/résumé data. Existing XA-09 thresholds remain unchanged. Focused XA-12 provenance, teardown, sender-validation, generation, tombstone, and startup-cleanup tests are rerun because this change touches `background.ts`, `bootstrap.ts`, and `messages.ts`.

## Rollout and rollback

Roll out as an extension-only checkpoint after typecheck, all unit tests, production build, all MV3 E2E tests, focused XA-12 checks, repository integrity checks, and review of the exact XA-13 paths. No database or web rollout is involved.

Rollback is a normal revert of the XA-13 checkpoint. Reintroducing eager probe construction is not an acceptable functional fallback; if the post-match request causes a compatibility problem, the safe operational response is to stop before package delivery and require manual completion while a corrected explicit-request flow is prepared.

## Progress

- [x] Authoritative audit definition recovered.
- [x] Preflight and protected-work classification completed.
- [x] Pre-fix behavior reproduced with instrumented production MV3 code.
- [x] Current reachability classified as partially present after XA-06.
- [x] Minimal two-phase handshake/probe architecture implemented.
- [x] Targeted unit and real-MV3 regression added.
- [x] Mandatory negative control failed as expected; final behavior restored and passed.
- [x] Full extension, multi-frame, XA-12, and repository-integrity gates recorded in the final report.
