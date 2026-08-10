# People discovery audit — why the Networking section was empty

Date: 2026-08-02
Branch: `feature/actionable-people-foundation`
Baseline commit: `44364f1`
Scope: the "People Who Can Help" / Networking section, end to end.

This audit was written against the repository, not from assumption. Every claim
below cites a file and line. Where a claim is inferred rather than proven, it is
filed under **Suspected** and says what evidence would settle it.

---

## 1. Executive summary

The user-facing message

> "No verified professional profiles were found for this company yet."

was **not** telling the truth. It was, in the common case, a provider success
that had been silently converted into a verified-empty result by an adapter
defect three layers below the UI.

**Confirmed root cause:** People Data Labs returns `linkedin_url` **without a
URL scheme** — `linkedin.com/in/<slug>`. The PDL normalizer passed that raw
value straight into `safe_profile_url`, which is the security boundary and
correctly accepts only `https://`. Every PDL record therefore normalized to
`linkedin_url = None`, and the actionable-contact gate then rejected all of them
as `missing_linkedin_url`. PDL is the **primary** discovery provider, so the
feature returned nobody for every company, and stored that as a verified-empty
answer with a long TTL.

The entire backend suite (1111 tests) passed throughout, because **every PDL
fixture in the repository used `https://www.linkedin.com/in/...`** — a form PDL
never sends. The tests agreed with each other and disagreed with production.

This is fixed. A second, latent defect in the frontend state mapping was found
while verifying the fix and is also fixed. Both are covered by tests written
against the provider's real wire format.

---

## 2. Architecture as built

### 2.1 Request path

```
PeopleWhoCanHelp.tsx  (user clicks "Find people")
  └─ controller.discover()
      └─ POST /jobs/{job_id}/people/discover        apps/api/app/routes/people.py:46
          └─ people.service.discover()               service.py:2951
              └─ _discover_once()                    service.py:3002
                  ├─ extract_job_people_profile()    intelligence.py:307
                  │   └─ resolve_company_identity()  intelligence.py:195
                  ├─ _build_provider_steps()         service.py:2896
                  │   ├─ _PDLStep                    service.py:2036   ← primary
                  │   ├─ _ApolloFallbackStep         service.py:2344   ← fallback
                  │   └─ _PublicWebFallbackStep      service.py:2629
                  ├─ _normalize_pdl()                providers.py:2182  ★ DEFECT
                  ├─ deduplicate()                   service.py:735
                  ├─ validate_current_employment()   employment_validation.py:75
                  ├─ evaluate_actionable_contact()   actionable.py:199  ★ REJECTED HERE
                  ├─ score_candidate()               scoring.py:70
                  └─ persist + finalize              finalization.py:274
  └─ GET /jobs/{job_id}/people                       routes/people.py:32
      └─ recommendations_payload()                   service.py:4159
          └─ is_displayable_record()                 actionable.py:321
  └─ derivePeopleView()                              apps/web/lib/peopleState.ts:284
      └─ PEOPLE_MESSAGES.empty                       apps/web/lib/peopleState.ts:54
```

### 2.2 Provider order (as configured, not as documented)

`.env` sets `PEOPLE_PROVIDER_ORDER='["pdl","apollo"]'` and
`PEOPLE_PRIMARY_PROVIDER=pdl` (config.py:158, 168).

> **Documentation drift.** `docs/people-data-providers.md` still states "Apollo:
> primary professional people search" and "People Data Labs: optional people
> fallback". That has been inverted in configuration and code. The doc is stale
> and materially misleading for anyone debugging this feature. Listed under
> technical debt below.

### 2.3 The acceptance gate

`evaluate_actionable_contact` (actionable.py:199) is the single decision point
for whether a person may be shown. It checks, and collects *all* failures:

| # | Rule | Rejection reason | Line |
|---|------|------------------|------|
| 1 | Complete, unmasked name | `masked_name` / `incomplete_name` / `missing_name` | 225 |
| 2 | Validated LinkedIn `/in/` URL | `missing_linkedin_url` / `invalid_linkedin_url` | 239–245 |
| 3 | Exact-company current employment | `company_mismatch` / `past_employment_only` / `unverified_employment` | 248–266 |
| 4 | Title supports the category | `title_not_relevant_to_category` | 269–281 |
| 5 | Confidence floor, no conflicts | `low_confidence` / `ambiguous_identity` | 285–296 |

Rule 2 is governed by `people_require_linkedin_for_display`, default **`True`**
(config.py:294; read at actionable.py:193).

---

## 3. Confirmed root cause

### 3.1 The defect

`safe_profile_url` (security.py:41) requires `parsed.scheme == "https"`:

```python
if parsed.scheme != "https" or not parsed.hostname or ...:
    return None
```

`_normalize_pdl` handed it the raw provider value (providers.py, pre-fix):

```python
linkedin_url=safe_profile_url(row.get("linkedin_url")),
```

PDL's documented representation of `linkedin_url` carries no scheme.
`urlparse("linkedin.com/in/rita")` yields `scheme=''`, `hostname=None` — so
`safe_profile_url` returns `None` for **every PDL record**.

### 3.2 Proof (executed against this repository, pre-fix)

```
safe_profile_url('linkedin.com/in/rita-recruiter')        -> None
safe_profile_url('https://www.linkedin.com/in/rita-...')  -> 'https://www.linkedin.com/in/rita-recruiter'
_normalize_pdl(real PDL shape).linkedin_url               -> None
_normalize_pdl(test-fixture shape).linkedin_url           -> 'https://www.linkedin.com/in/rita-recruiter'
```

The only difference between the two rows is the scheme.

### 3.3 The cascade

1. `_normalize_pdl` → `linkedin_url = None` for 100% of PDL candidates.
2. `evaluate_actionable_contact` → `missing_linkedin_url` (actionable.py:242).
3. Zero accepted candidates in every category.
4. Finalization records `complete` / `no_reliable_matches`
   (service.py:4361, finalization.py:274).
5. The run is persisted as a **verified-empty result** with
   `people_result_ttl_days = 30` (config.py:247).
6. `derivePeopleView` maps `no_reliable_matches | complete | partial` with no
   renderable contacts to `state: "empty"` (peopleState.ts:376–385).
7. The user reads "No verified professional profiles were found for this
   company yet." — with `canRetry: false`.

Step 5 is the damaging one: a provider success misread as an answer got cached
for 30 days, so retrying changed nothing.

### 3.4 Why Apollo masked the severity but did not save it

The Apollo normalizer *had* been patched for its own real-world format —
Apollo returns legacy `http://` URLs, handled by an inline fixup
(providers.py, pre-fix lines 2091–2093). PDL never received the equivalent
treatment. So the fallback provider worked and the primary did not, which is
consistent with the reported symptom of *frequent*, not universal, emptiness:
results appeared only when Apollo fallback ran and succeeded.

### 3.5 Why the test suite never caught it

Every PDL-shaped fixture in the repository uses a scheme-prefixed URL:

- `app/tests/test_people_search_isolation.py:103`
- `app/tests/test_people_user_quota.py:120`
- `app/tests/test_people_provider_chain_integration.py:482`
- `app/tests/test_apollo_bulk_contract.py:61,68`

The fixtures encoded the shape the code wanted, not the shape the provider
sends. This is the defining property of the bug: **1111/1111 tests passing was
compatible with the feature returning nobody, for every company, in production.**

### 3.6 It was observable, and nobody was watching

`people_missing_linkedin_rejected_total` already exists (observability.py:79)
and is already emitted (service.py:315–316). In production it would have been
firing on ~100% of PDL candidates. The instrumentation was correct; there was no
alert on the accept/reject ratio. Adding one is the highest-value follow-up in
this whole document.

---

## 4. Second defect (latent, found while verifying the fix)

`derivePeopleView` (peopleState.ts:284) had **no case for `status: "stale"`**,
although:

- the backend emits it (service.py:4320) when a stored run's search contract
  has been retired, with the warning "Contact discovery has been upgraded.
  Refresh to check again.";
- `"stale"` is a declared member of `PeopleStatus` (apps/web/lib/api.ts:127);
- `peopleActionSummary` *does* handle it, mapping it to `not_searched`
  (peopleState.ts:147–148).

It therefore fell through to `default:` and was reported as
`state: "empty"` with the verified-empty message and `canRetry: false` — the
precise claim that module exists to prevent, and a direct contradiction of the
sibling derivation in the same file.

**Blast radius, stated accurately:** `PeopleWhoCanHelp.tsx` gates the rendered
empty paragraph on `["no_reliable_matches","complete","partial"]`
(PeopleWhoCanHelp.tsx:448–451), so `"stale"` did **not** render that sentence in
today's UI, and the component does offer a "Refresh people" button for it
(PeopleWhoCanHelp.tsx:478–479). This was a latent defect in the documented
canonical mapping, not the sentence users were reading. It is fixed because
retiring the PDL adapter contract (below) makes `"stale"` a common status, and
because a pure mapping function that contradicts itself is a trap for the next
change.

---

## 5. Changes made

| File | Change |
|------|--------|
| `apps/api/app/people/security.py` | Added `canonical_profile_url` and `profile_url_from_provider_username`. `safe_profile_url` is **unchanged** — canonicalization happens before validation, never instead of it. |
| `apps/api/app/people/providers.py` | `_normalize_pdl` canonicalizes, with `linkedin_username` as a recorded-provenance fallback. `_normalize_apollo` now uses the same helper instead of its inline `http://` fixup. `PDL_DISCOVERY_STRATEGY_VERSION` → `pdl-category-search-v3`. |
| `apps/web/lib/peopleState.ts` | `derivePeopleView` handles `"stale"` as `not_loaded`. |

### 5.1 Retiring the poisoned cache

This is not optional and would have made the fix invisible without it.

`PDL_DISCOVERY_STRATEGY_VERSION` (providers.py:74) is a component of
`PEOPLE_SEARCH_CONTRACT_VERSION` (service.py:162–191). `run_is_compatible`
(service.py:206) refuses to replay a stored run recorded under a retired
contract, and `recommendations_payload` then returns `status: "stale"`
(service.py:4319–4323) rather than the stored empty.

Bumping v2 → v3 is the correct semantics: a v2 run that stored "nobody matched"
recorded **an adapter defect, not an answer about the company**. Those runs are
now retired instead of being replayed at users as verified-empty for 30 days.

No manual cache purge is required, and none should be performed — the version
mechanism handles it deterministically and is already covered by
`people_legacy_cache_invalidations_total` (service.py:4325).

### 5.2 What the fix deliberately does not do

- It does **not** loosen `safe_profile_url`. Host, path, scheme and credential
  checks are unchanged and still enforced on the canonicalized value.
- It does **not** guess or pattern-build URLs from names. A bare slug, a
  relative path, a name string, and a `linkedin.com/company/...` page are all
  refused (pinned by test).
- `linkedin_username` is used **only** when the provider sent no URL. It is a
  structured identifier the provider stores for that record, not a guess, and
  the weaker provenance is recorded in `field_provenance` and `evidence`.

---

## 6. Ruled out

Investigated and found **not** to be causes:

| Hypothesis | Finding |
|------------|---------|
| Company resolution failing | Would produce `domain_unresolved` and a *different* message (peopleState.ts:394). Distinct path. |
| Domain `www.` mismatch | Both sides strip `www.` and lowercase symmetrically (intelligence.py:46, providers.py:2334). Correct. |
| Provider errors cached as empty | `_provider_step_outcome` (service.py:2603) and `PROVIDER_ERROR_STATUSES` keep failures as distinct statuses. Correct by design. |
| Circuit breaker on empty results | Budget exhaustion is explicitly excluded from circuit movement (service.py:2261–2264). Correct. |
| Feature flags off | `.env`: `PEOPLE_RECOMMENDATIONS_ENABLED=true`, `PEOPLE_PDL_DISCOVERY_ENABLED=true`. Enabled. |
| PDL date parsing | `_provider_datetime` (providers.py:2350) parses PDL's ISO dates correctly. |
| Employment timestamps missing | `_normalize_pdl` sets `provider_record_observed_at` (providers.py:2246). Not the cause. |

---

## 6b. Second pass — additional defects found while verifying the fix

Verifying the fix surfaced four further issues. Three are fixed; one is an
account blocker that no code change can resolve.

### 6b.1 PDL account is exhausted (BLOCKER, not fixable in code)

Verified live on 2026-08-02:

| `size` | Result |
|---|---|
| 1 | HTTP 200, `total=5` real matches for `postman.com` |
| 5 | HTTP 402 — *"You have hit your account maximum for search (all matches used)"* |
| 10 | HTTP 402 |

The app requests `size = min(query.limit, people_pdl_results_per_query=10, 100)`,
and category limits are 4/4/8 — so **every real discovery requests >1 record and
receives HTTP 402**, mapped to `provider_budget_exceeded`. The UI copy for that
state is honest, but the feature cannot work. See
`docs/people-discovery-operations.md` §1.

### 6b.2 Path traversal defeated the person-profile guarantee (fixed)

`safe_profile_url` checks only that the path *starts with* `/in/`. So
`https://linkedin.com/in/rita/../../company/x` passed the person-profile gate
while resolving, in any browser, to a **company page**. Now refused: relative
path segments are rejected outright rather than collapsed.

### 6b.3 The same person from two providers rendered twice (fixed)

`_same_identity` (service.py:723) compares profile URLs with **exact string
equality**. PDL sends `linkedin.com/in/x`; Apollo sends
`http://www.linkedin.com/in/x`. After canonicalization these were
`https://linkedin.com/in/x` and `https://www.linkedin.com/in/x` — *different
strings*, so deduplication failed and one human became two contact cards. This
would have shipped into the beta and violates the "no duplicate people" gate.

Fixed by canonicalizing host and slug case to one form
(`https://www.linkedin.com/in/<lowercase-slug>`). A LinkedIn public slug is
global, so `linkedin.com`, `www.linkedin.com` and `uk.linkedin.com` with the
same slug are the same profile and all three resolve.

### 6b.4 The live-verification script reported PASS on a provider failure (fixed)

The first version of `scripts/verify_pdl_live.py` printed **PASS** for a run in
which the provider returned HTTP 402 and zero records — reproducing, in the
verification tool itself, the exact confusion between "provider failed" and
"nothing found" that this whole audit is about. It now exits `2`
(*inconclusive*) for a provider failure or an empty answer, and reserves `0` for
a genuinely exercised contract.

---

## 6c. Live verification result

Executed through the real adapter against the live PDL API, `size=1`,
`postman.com`, category `likely_recruiter`:

```
status                  : success
latency_ms              : 784
raw_result_count        : 1
normalized_result_count : 1
actionable_accepted     : 1
rejections_by_reason    : {}
record shape            : R.A. url=yes src=pdl:provider_url
acceptance ratio        : 100.0%
missing-URL reject ratio: 0.0%
```

**What this proves:** a real, live PDL record now survives normalization and the
actionable gate end to end, with the profile URL sourced from the provider's own
`linkedin_url` field. Under the pre-fix code the same record would have been
rejected as `missing_linkedin_url`.

**What this does not prove:** the raw scheme shape of that specific live record
was not separately captured — the account's search allowance was exhausted
before that follow-up call could run. The necessity of the fix rests on PDL's
documented format plus the pre-fix demonstration in §3.2, not on this run. This
run demonstrates that the fix *works* against live data, and only that.

---

## 7. Technical debt and production risks

Found during the audit. **Not fixed here** — each needs its own decision.

1. **No alert on the actionable-gate accept ratio.** The counters exist and are
   emitted. Nothing watches them. This defect ran undetected in production while
   being fully instrumented. Highest-value follow-up.
2. **Fixtures are not contract tests.** The suite has no sanitized
   captured-response fixtures; hand-written dicts encode assumptions. This bug
   class *will* recur for any provider field until real captured shapes are used.
3. **`docs/people-data-providers.md` is stale** — describes Apollo as primary
   and PDL as an optional fallback. Both are wrong.
4. **PDL per-user budget is tight.** `PEOPLE_PDL_PER_USER_DAILY_LIMIT=100` with
   up to 16 records per discovery (config.py:253) allows roughly six searches
   per user per day before `_pdl_budget_allows_call` (service.py:1420) starts
   refusing. Verify this is intentional for beta.
5. **`service.py` is 5019 lines.** `_discover_once` alone spans ~1150 lines
   (service.py:3002–4151). This is the single largest obstacle to reasoning
   about the pipeline and directly contributed to the defect surviving.
6. **`safe_profile_url` accepts `https://linkedin.com/in/`** (empty slug). Not
   reachable via the new canonicalizer, which guards it, but the underlying
   validator remains permissive for other callers.

---

## 8. Verification

| Check | Result |
|-------|--------|
| Backend baseline, before changes | **1111 passed** |
| Backend, after changes | **1138 passed** (1111 + 27 new) |
| Frontend baseline | **315 passed** |
| Frontend, after changes | **317 passed** (315 + 2 new) |
| `ruff check apps/api/app/people/` | All checks passed |
| `python -m compileall app scripts` | OK |
| `npm run lint` (web) | Clean |
| `npm run typecheck` (web) | Clean |

Evidence status, stated precisely:

- **Implemented and unit tested:** URL canonicalization, PDL/Apollo
  normalization, actionable-gate acceptance, contract-version retirement,
  frontend `stale` mapping.
- **Integration tested with sanitized fixtures:** the PDL → actionable-gate
  funnel, using PDL's real wire format.
- **Tested against a real provider:** **No.** No provider account was contacted
  and no credit was spent. The scheme-less `linkedin_url` format is PDL's
  documented representation and is the shape the new fixtures encode, but this
  fix has **not** been executed against a live PDL response.
- **Not testable here:** live end-to-end behaviour, which requires a PDL API key
  and a real job record. See §9.

---

## 9. Required manual verification before calling this production-ready

The fix is correct against the documented format and is fully covered by tests,
but the loop is not closed until a real response is observed:

1. With `PEOPLE_PDL_DISCOVERY_ENABLED=true` and a valid PDL key, run a discovery
   for one job at a company with known employees.
2. Confirm in the structured logs:
   - `people_contacts_accepted_total{provider=pdl}` > 0;
   - `people_missing_linkedin_rejected_total{provider=pdl}` near zero.
3. Confirm `GET /jobs/{id}/people/diagnostics` (routes/people.py:62) shows a
   non-zero `unique_candidate_count` and no `missing_linkedin_url` domination in
   `rejection_reason_counts`.
4. Confirm a job that previously showed the empty message now shows contacts, or
   shows `status: "stale"` prompting a refresh.

Until step 2 is observed against a live account, this should be described as
**fixed and verified against the documented contract**, not as verified in
production.
