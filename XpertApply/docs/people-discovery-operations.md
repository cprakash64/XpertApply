# People discovery — operations

Companion to `docs/people-discovery-audit.md`. Written for whoever is on call
during the controlled beta.

---

## 1. Blocking issue right now

**The PDL account cannot serve production traffic.** Verified live on
2026-08-02 against `api.peopledatalabs.com/v5/person/search`:

| Request | Result |
|---------|--------|
| `size=1` | HTTP 200, `total=5` real matches for `postman.com` |
| `size=5` | HTTP 402 — *"You have hit your account maximum for search (all matches used)"* |
| `size=10` | HTTP 402 |

The application requests `size = min(query.limit, people_pdl_results_per_query, 100)`.
With `PEOPLE_PDL_RESULTS_PER_QUERY=10` and per-category limits of 4/4/8, **every
real discovery requests more than 1 record and therefore receives HTTP 402.**

That maps to `provider_budget_exceeded` (pdl_status.py:145) → the UI shows
"People search is temporarily unavailable because provider capacity has been
reached." That message is *honest*, but the feature does not work.

During this verification the account's remaining search allowance was consumed;
subsequent `size=1` calls also return 402.

**Required action: upgrade or top up the People Data Labs plan before beta.**
No code change can work around an exhausted account.

---

## 2. Required environment variables

| Variable | Purpose | Present in `.env`? |
|---|---|---|
| `PDL_API_KEY` | Primary discovery | yes (allowance exhausted) |
| `APOLLO_API_KEY` | Secondary discovery/enrichment | yes |
| `HUNTER_API_KEY` | Work-email finding only | yes |
| `OPENAI_API_KEY` | Bounded classification/ranking | yes |
| `PEOPLE_RECOMMENDATIONS_ENABLED` | Global kill switch | `true` |
| `PEOPLE_ROLLOUT_MODE` | `disabled\|internal\|beta\|percentage\|all` | `internal` |
| `PEOPLE_PROVIDER_ORDER` | Chain order | `["pdl","apollo"]` |
| `PEOPLE_PDL_RESULTS_PER_QUERY` | Records per PDL search | `10` |

> Note the setting names: the app reads `PDL_API_KEY`, `APOLLO_API_KEY`,
> `HUNTER_API_KEY` — **not** `PEOPLE_*_API_KEY`. Checking the wrong name will
> make a configured provider look unconfigured.

---

## 3. Confirming provider state without calling anything

```bash
python -m scripts.inspect_people_providers --provider pdl
```

Makes **no external calls** and prints **no secrets**. Reports enablement, order
position, credential presence (`[set]`/`[missing]`), budget state, circuit
state, and the current cache contract version.

---

## 4. Live provider verification

```bash
python -m scripts.verify_pdl_live --company postman.com --confirm-live-call --limit 1
```

- **Opt-in.** Without `--confirm-live-call` it prints the plan and exits.
- Never imported by tests; must never be added to CI.
- Spends real credit — the cost ceiling is printed before anything is spent.
- Redacts everything: no key, no payload, no full name, no URL, no email.
  People appear only as counts plus initials and a URL-presence flag.
- Exit codes: `0` pass, `1` fail, `2` inconclusive (provider did not answer, or
  answered with no records — **never** reported as a pass).

Keep `--limit 1` while the account is capped.

---

## 5. Metrics

Emitted by `app.people.observability.metric` as
`metric=<name> value=<number> <allowlisted dimensions>`. Dimensions can never
contain names, emails, URLs, provider IDs, job IDs, or user IDs.

### Funnel health (new)

| Metric | Meaning |
|---|---|
| `people_funnel_acceptance_ratio_bp` | accepted / normalized, basis points |
| `people_funnel_profile_url_rejection_ratio_bp` | profile-URL rejections / normalized, basis points |
| `people_funnel_health_total` | one verdict per provider per run; dimensions `status` (`ok`/`insufficient_data`/`warning`/`critical`) and `reason` |

`reason` values: `within_expected_range`, `below_minimum_volume`,
`acceptance_ratio_low`, `acceptance_ratio_collapsed`,
`profile_url_rejection_dominant`.

### Pre-existing counters that feed them

`people_contacts_evaluated_total`, `people_contacts_accepted_total`,
`people_contacts_rejected_total`, `people_missing_linkedin_rejected_total`,
`people_masked_name_rejected_total`, `people_ambiguous_identity_rejected_total`.

> These counters were all present and correct throughout the profile-URL
> incident. Counters alone did not catch it. The **ratio** is the detection.

---

## 6. Alerts

Thresholds are implemented in `app/people/funnel_health.py` and unit-tested in
`app/tests/test_people_funnel_health.py`, so they can be changed with a test
rather than only in a dashboard.

| Severity | Condition | Minimum volume |
|---|---|---|
| **critical** | profile-URL rejection ratio ≥ 90% | ≥ 50 normalized |
| **critical** | acceptance ratio < 2% | ≥ 50 normalized |
| **warning** | acceptance ratio < 10% | ≥ 20 normalized |
| *(no verdict)* | anything below 20 normalized → `insufficient_data` | — |

Recommended log-pipeline rule, sustained **10–15 minutes**:

```
count_over_time(people_funnel_health_total{status="critical"}[15m]) > 0
```

Also alert on:

- `people_discovery_provider_errors_total` with `error_code` in
  `provider_unauthorized`, `provider_forbidden` — a credential or plan problem.
- Sustained `provider_rate_limited`.
- `provider_timeout` rate above the `people_provider_timeout_seconds` envelope.
- `people_circuit_state_transitions_total` staying `open` beyond
  `people_circuit_max_cooldown_seconds`.
- A spike in `people_results_total{status="no_reliable_matches"}` right after a
  deployment — the exact shape of the original incident.

**All thresholds above are pre-traffic guesses and must be re-tuned once beta
traffic exists.** They are deliberately set to catch total-loss integration
defects, not ordinary gate strictness.

---

## 7. Diagnosing one job that shows no people

1. `GET /jobs/{job_id}/people/diagnostics` (owner-authenticated; returns 404 in
   production). Gives per-category `raw_search_result_count`,
   `normalized_profile_count`, `unique_candidate_count`, and
   `rejection_reason_counts`.
2. Read the dominant rejection reason:
   - `missing_linkedin_url` / `invalid_linkedin_url` → adapter contract defect.
   - `company_mismatch` → company resolution, not the person.
   - `unverified_employment` / `past_employment_only` → freshness or a leaver.
   - `title_not_relevant_to_category` → query plan too narrow.
   - `no_search_results` → the provider genuinely matched nobody.
3. Check `company_context` on the run for the resolved domain and
   `search_contract_version`.

---

## 8. Poisoned and incompatible cache entries

Stored runs are keyed by `PEOPLE_SEARCH_CONTRACT_VERSION` (service.py:162), a
colon-joined fingerprint of every component that can change the *meaning* of a
stored result. `run_is_compatible` (service.py:206) refuses to replay a run
recorded under a retired contract; the read path then returns `status: "stale"`
and the UI offers "Refresh people".

**Do not purge caches manually.** Bump the responsible component version
instead — that retires exactly the affected runs and is observable via
`people_legacy_cache_invalidations_total`.

Current contract (from `inspect_people_providers`):

```
pdl-person-search-v3:pdl-category-search-v3:pdl-progressive-search-v1:
pdl-company-v1:people-v2:people-title-v2:people-result-v2:
people-finalization-v4:people-display-policy-v2:people-actionable-v1:
brightdata-profile-discovery-v1:openai-public-identity-v2:
apollo-enrichment-v4-complete-person:order:pdl>apollo
```

`pdl-category-search-v3` is the bump that retired the runs poisoned by the
profile-URL defect.

---

## 9. Disabling a provider / rollback

| Goal | Action |
|---|---|
| Kill the whole feature | `PEOPLE_RECOMMENDATIONS_ENABLED=false` |
| Restrict audience | `PEOPLE_ROLLOUT_MODE=internal` |
| Disable PDL | `PEOPLE_PDL_DISCOVERY_ENABLED=false` (Apollo still runs if enabled) |
| Disable Apollo | `PEOPLE_APOLLO_DISCOVERY_ENABLED=false` |
| Disable email lookup | `PEOPLE_EMAIL_DISCOVERY_ENABLED=false` |
| Cost stop | `PEOPLE_PDL_DAILY_CREDIT_BUDGET` / `PEOPLE_APOLLO_DAILY_CREDIT_BUDGET` → `0` |

All are environment-only; none requires a code deploy.

To roll back the changes in this working tree: they are uncommitted, so
`git checkout --` on the specific files is sufficient. Note that reverting
`PDL_DISCOVERY_STRATEGY_VERSION` to `v2` would **re-admit the poisoned
negative-cache entries**.

---

## 10. Testing without credentials

`make test-api` and `npm test` contact no provider and spend no credit. Provider
behaviour is exercised through sanitized fixtures. The only credential-using
path in the repository is `scripts/verify_pdl_live.py`, which is opt-in.
