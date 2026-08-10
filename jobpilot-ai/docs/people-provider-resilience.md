# People provider resilience — failure, fallback, and cost

Scope: the recruiter / likely-hiring-manager / potential-referrer discovery
pipeline only. Companion to `people-discovery-audit.md` (the profile-URL
incident) and `people-discovery-operations.md` (runbook).

Verified against the working tree on 2026-08-03, branch
`feature/actionable-people-foundation`, HEAD `44364f1`.

---

## 1. The question this document answers

> PDL is broken in way *X*. Do users still get people?

The answer used to be "no" for two failure modes that a healthy Apollo account
could have covered. Both are fixed; the full matrix is below.

---

## 2. Failure → outcome matrix

Sources: `pdl_status.py:112–180` (HTTP → outcome), `errors.py` (typed taxonomy),
`waterfall.py:363–390` (`may_fall_back`), `finalization.py:96–140` (terminal
status), `peopleState.ts:233–271` (frontend copy).

| PDL condition | HTTP | Typed code | Retry PDL? | Apollo fallback? | Cached as empty? | Terminal status if nothing else succeeds | Frontend copy |
|---|---|---|---|---|---|---|---|
| Results | 200 | — | — | only if coverage gap | positive cache | `complete` | people rendered |
| Genuine empty | 200 / documented 404 | — | no | **yes** (`no_match`) | short verified-empty | `no_reliable_matches` | "No verified professional profiles…" |
| Account maximum | **402** | `PROVIDER_BUDGET_EXHAUSTED` | **no** | **yes** | **never** | `provider_budget_exhausted` | "…provider capacity has been reached." |
| Unauthorized | 401 | `AUTHENTICATION_FAILED` | no | **yes** *(fixed)* | never | `provider_configuration_error` | "temporarily unavailable" |
| Forbidden | 403 | `AUTHORIZATION_FAILED` | no | **yes** *(fixed)* | never | `provider_configuration_error` | "temporarily unavailable" |
| Rate limited | 429 | `RATE_LIMITED` | bounded | yes | never | `provider_unavailable` | "…try again after the displayed time." |
| Server error | 5xx | `PROVIDER_SERVER_ERROR` | bounded | yes | never | `provider_unavailable` | "temporarily unavailable" |
| Timeout | — | `PROVIDER_TIMEOUT` | bounded | yes | never | `provider_unavailable` | "temporarily unavailable" |
| DNS / network | — | `NETWORK_ERROR` | bounded | yes | never | `provider_unavailable` | "temporarily unavailable" |
| Malformed response | 200 | `PROVIDER_CONTRACT_ERROR` *(new)* | **no** | **yes** *(fixed)* | never | `invalid_request` | "temporarily unavailable" |
| Circuit open | — | `PROVIDER_SERVER_ERROR` | no | yes | never | `provider_unavailable` | "temporarily unavailable" |
| Internal PDL budget | — | `PROVIDER_BUDGET_EXHAUSTED` | no | yes | never | `provider_budget_exhausted` | capacity copy |
| Company unresolved | — | `COMPANY_DOMAIN_UNRESOLVED` | no | **no** (correct) | resolver-versioned | `domain_unresolved` | "could not confidently identify this company" |
| Our request malformed | 400/422/405 | `INVALID_INPUT` | no | **no** (correct) | never | `invalid_request` | "temporarily unavailable" |
| User quota spent | — | `USER_BUDGET_EXHAUSTED` | no | **no** (correct) | never | `user_budget_exhausted` | "used all of today's searches" |

**The governing rule: a failure of the *provider* permits another provider; a
failure of the *question* does not.** Company-unresolved, a genuinely malformed
request, and a spent user quota are facts about the request — Apollo would be
asked the same unanswerable question and charged for it.

### 2.1 Was PDL 402 blocking Apollo fallback?

**No.** This was checked first because it was the reported suspicion. HTTP 402
maps to `PROVIDER_BUDGET_EXHAUSTED` (`pdl_status.py:145`), and `may_fall_back`
explicitly permits fallback for that code when
`people_provider_fallback_on_budget_exhausted` is set — which it is
(`.env`: `PEOPLE_PROVIDER_FALLBACK_ON_BUDGET_EXHAUSTED=true`). Verified by
direct execution, not by reading.

### 2.2 What *was* broken

**401/403 disqualified Apollo.** `AUTHENTICATION_FAILED` and
`AUTHORIZATION_FAILED` were in neither `_FALLBACK_ELIGIBLE` nor the special
cases, so `may_fall_back` fell through to `return False, None`. A revoked PDL
key or an expired plan took the whole feature down while a fully-credentialed
Apollo account sat idle. They now permit fallback while **still** opening the
configuration circuit — retrying cannot fix a bad credential, so PDL correctly
stops being called; Apollo carries the request meanwhile.

**A malformed PDL response was filed as our own bad request.**
`provider_schema_error` / `provider_response_invalid` mapped to `INVALID_INPUT`,
which is in `_NEVER_FALLBACK`. A provider-side contract break therefore blocked
fallback *and* was recorded as though we had sent a bad request. They now map to
a new `PROVIDER_CONTRACT_ERROR` code: request-scoped (so one unreadable response
cannot trip a circuit and start a retry storm), fallback-eligible, and keeping
the same terminal status as before so no user-visible behaviour changed.

---

## 3. Provider call and credit table

One **uncached** discovery for one job, PDL healthy. Verified from
`_PDLStep` (`service.py:2036`), `search_people` (`providers.py:1385`), and
`inspect_people_providers`.

| User action | Provider | Adapter method / endpoint | Calls | Max records | Est. credits | Cache scope | Required? |
|---|---|---|---|---|---|---|---|
| Select a job | — | none | 0 | 0 | 0 | — | no provider traffic |
| Open People panel | — | none (client state only) | 0 | 0 | 0 | — | no provider traffic |
| **Click "Find people"** | PDL | `company/enrich` | 1 | 1 company | 1 enrich | company, 30 d | yes |
| ↳ recruiters | PDL | `person/search` | 1 | **4** | 4 matches | job+user | yes |
| ↳ hiring managers | PDL | `person/search` | 1 | **4** | 4 matches | job+user | yes |
| ↳ potential referrers | PDL | `person/search` | 1 | **8** | 8 matches | job+user | yes |
| **PDL subtotal** | | | **4** | **16** | ~16 matches + 1 enrich | | |
| Apollo fallback (only on gap/failure) | Apollo | `mixed_people/search` | ≤3 | 4/4/6 | unknown | job+user | conditional |
| ↳ enrichment | Apollo | bulk `people/match` | ≤1 | ≤6 | unknown | person, 30 d | conditional |
| Retry | same as above | | same | same | same | invalidates | user-triggered |
| Broaden search | PDL | `person/search` (widened titles) | ≤3 | bounded | bounded | job+user | user-triggered |
| Reopen same job | — | cache read | **0** | 0 | **0** | positive TTL 30 d | no |
| Stale refresh | as "Find people" | | 4 | 16 | ~16 | rewrites | user-triggered |
| Concurrent identical request | — | coalesced via Redis lock | **0** extra | 0 | 0 | — | no |
| Hunter email | Hunter | finder + verifier | 1–2 | 1 | unknown | person | **user-triggered only** |

Credit costs are marked **unknown** where the provider does not report them and
the repository does not model them. PDL person-search is billed per matched
record, so "max records" is the meaningful cost figure there.

### 3.1 Why one discovery requests ~16 PDL records

Exactly `4 + 4 + 8 = 16`, from
`people_pdl_recruiter_results` / `_manager_results` / `_referral_results`
(`config.py:250–252`), and `people_pdl_max_results_per_discovery` is itself `16`
(`config.py:253`) — the ceiling equals the sum, so it never actually binds.

Display caps in this environment are `2 / 2 / 5` = **9 displayable**. So a
discovery fetches 16 records to display at most 9: ~44% headroom.

That headroom is **deliberate, not waste**. The actionable-contact gate rejects
candidates after fetch (wrong company, unverified employment, no profile URL,
title mismatch), so fetching only the display cap would routinely starve
categories. It is documented here rather than "optimized" away because cutting
it is exactly how a low-credit test account gets made to pass at the cost of
production recall. Both the fetch limits and the display caps are environment
variables and can be tuned per plan.

---

## 4. Cache integrity

`_fresh_no_match_run` (`service.py:430`) will only ever replay a stored run whose
status is **exactly `"complete"`**. Every failure code maps to some other
terminal status (`finalization.py` `STATUS_FOR_CODE`), so no provider failure —
quota, auth, rate limit, timeout, contract error — can be served as "this
company has nobody". Pinned by
`test_no_failure_ever_produces_a_reusable_empty_result` and
`test_only_complete_runs_are_replayable`.

Reuse additionally requires `run_is_compatible` (`service.py:206`), so runs
recorded under a retired `PEOPLE_SEARCH_CONTRACT_VERSION` — including the ones
poisoned by the profile-URL defect — are never replayed.

---

## 5. Evidence status

- Failure→fallback matrix, taxonomy, cache-reuse guard:
  **Implemented and unit tested** (`test_people_provider_fallback_policy.py`).
- Call/credit table: derived from repository behaviour and the one live PDL run
  recorded in `people-discovery-audit.md` §6c. Apollo and Hunter credit costs are
  **Not verified**.
- Live PDL all-category verification: **Blocked by provider provisioning** — the
  account returns HTTP 402 for any `size > 1`.
- Live Apollo fallback: **Not verified**.
