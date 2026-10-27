# PROD-READY-04B: upload and abuse controls

## Scope and starting state

Authoritative detached candidate: 87c3259eb8feb0eef6a785dbe53015b373361096.
Only RB02/RB07 are authorized. Exact paths are recorded before edits in the
04B evidence directory's authorized-scope.json. Dependencies and R13 are unchanged.

## Architecture and decisions

The existing 5 MiB file cap remains. An outer pure ASGI middleware counts actual
bytes, including chunked/missing/false Content-Length; multipart has 64 KiB
bounded envelope overhead. Other request bodies have a 1 MiB ceiling.
Authentication/admission runs before manual multipart decoding. Exactly one
file and one optional source_type field are permitted, with 1 KiB field cap.
Starlette spools after 1 MiB; application copies in 64 KiB chunks into a private
internally named temporary directory. No uploaded filename selects a path.

Each parser runs in a new child process, with a 15 second hard wall deadline.
Cancellation/timeout kills and reaps the owned process group before cleanup.
Linux enforces 384 MiB address space, CPU, output-file and FD limits. This is an
address-space cap, not an RSS promise; macOS has structural/deadline protections.
PDF limits: 50 pages, 20,000 xref objects, 100,000 extracted characters. Recursion
is bounded to 1,000 frames. DOCX permits 256 entries, 4 MiB per expanded entry,
20 MiB aggregate, ratio 200; declared and actual expanded bytes are checked.
Traversal, duplicate/absolute/symlink/encrypted entries and XML DTDs are rejected.
No document is silently truncated; all limit failures are explicit.

Redis atomic Lua uses server time, aggregate rate before identity rate, finite
TTL, HMAC identities and shared user/global leases. No production local fallback
exists. High-cost admission failure is 503; rate exhaustion is 429 with accurate
rate-window retry information; file/structural bounds are 413. Parser capacity
is global 2/user 1, with immediate rejection and no pending parser queue.

Login is 20/minute per TCP peer; signup 10/hour. No victim-email lockout is
introduced. Uvicorn forwarding rewrites are disabled so arbitrary XFF cannot
change identity. Proxy verification remains RB06; a shared upstream peer may
need a separately verified proxy identity contract before production approval.
Authenticated work uses verified user/session ownership, before cost admission.
Risk categories separate read/write, upload, generation, discovery and documents.

AI uses bounded input/output, SDK retries zero, one alternate model only for a
missing configured model, 30 second overall/connect/read budgets, per-user and
shared concurrency, and eight paid calls maximum per HTTP request. People daily
quotas remain in force; hosted search allows one tool call per provider request.
Cancellation propagates and all slots are released. Limits bound operations,
not exact billing dollars. Unconfigured AI remains deterministic/non-billable.

Queue publishers serialize physical Redis queue checks, cap depth at 100,
deduplicate user/task identities for 360 seconds, expire queued tasks after 60
seconds, and bound batches to 20,000 IDs. Celery prefetch is one/worker, existing
worker concurrency two, task soft/hard deadlines 280/300 seconds and scoring
retries three. Production never substitutes unlimited inline scoring on failed
queue admission. Ingestion writes remain idempotent; explicit 503 can follow
persisted discovery, and a retry/on-demand rematch refreshes derived scores.

Fixed-label logs never contain input, prompts, IP/email or full user IDs. Keys
expire and no raw identifiers are stored. Existing frontend detail/status error
handling displays permanent size versus temporary rate/capacity failures.

## Progress

- Verified clean authoritative baseline and all 152 prior evidence digests.
- Persisted exact scope and upload flow/risk analysis before implementation.
- Implemented initial boundary/control modules; validation and security review
  are pending. No commit, push, deployment or production mutation.

## Validation gates

Run synthetic input boundary, parser timeout/cancel/cleanup, Redis atomicity and
AI controls; then complete make test-api/test-web/test-extension and disposable
migration/Compose/build/stack checks. Re-scan dependency/image severe findings.
Replay R6 25/25, archives 27/27 and zero known-failure false negatives. Commit
only if every gate and both blockers are resolved; verify committed diff and
focused checks afterward. Historical qualification stays BLOCKED; fresh exact
candidate qualification is required in a separately authorized stage.

## Rollout and rollback

This stage is local only. Rollout requires RB04/05/06/08/09 and owner approval.
There is no schema migration. Rollback restores the prior image/source identities;
Redis resource keys are namespaced and expire. No provider configuration or
credentials change. Release remains NO_GO. Next authorized stage is 04C only
when 04B is verified complete.


## Scope stop and owner decision

**BLOCKED — RB02/RB07 REMEDIATION REQUIRES BROADER PRODUCT REDESIGN.**
No checkpoint commit is permitted. These are uncommitted proposed changes,
not a verified release candidate; do not merge or deploy this diff.

Security review found a conflict in the existing guaranteed scoring fallback:
interactive discovery commits jobs before scoring/publishing, and scheduled
intake also commits before queue delivery. The original inline fallback scores
all active users when the broker is unavailable. A queue cap cannot bound that
fallback. Disabling it introduces a handoff gap after persisted intake: retrying
unchanged jobs does not recreate changed_job_ids. Scheduled intake can also leave
a running run record after queue rejection. Hard worker termination lacks a
resumable cursor for unfinished fan-out. A durable intent/progress and recovery
contract is needed before these queue changes can be accepted. Adding that
contract exceeds the minimal reviewed file scope and requires an owner-approved
architecture decision. No outbox, new migration or scheduling redesign was made.

The proposed queue changes remain in the uncommitted diff to make the conflict
reviewable; they are explicitly rejected by the final security review. Existing
parser/auth/AI changes are also not certified independently: final full-suite,
final-candidate image scans and six-service integration gates were stopped.

Validation obtained: Web1033 PASS (lint/type/build), extension809 PASS/10 existing
skips (type/build), archived R13 25/25 and27/27 with zero known-failure false
negatives, focused affected backend/regression248 PASS, Ruff PASS. An earlier
full backend snapshot produced1975 PASS/20 failures; those failures were traced
to an incorrect production-helper import and a too-tight People action category.
Both were corrected and the affected248 tests passed, but the final full suite
was not rerun after the scope stop. Seven migration tests passed on disposable
Postgres; no migrations or schema changes were introduced. Two pre-final image
builds passed4/4, but they do not validate the final uncommitted source snapshot.
No six-service runtime or final image advisory scan was performed.

Controls added after the initial architecture description: ingress64 concurrent
connections/requests with validated bounds; body receive deadline60 seconds;
auth password-hashing capacity; lease renewal with failure cancellation; safe
cancellation during admission; per-user50/global500 paid attempts per day in
addition to per-minute bounds. People cached/idempotent actions have their own
30/minute request category, while original daily provider quotas remain intact.

Owner recommendation: authorize a narrow durable scoring intent/resumability
and recovery design, then resume04B validation. 04C is not ready. RB02/RB07
remain unresolved, alongsideRB04/RB05/RB06/RB08/RB09. Release remainsNO_GO.
