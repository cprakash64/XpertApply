# People discovery — quality vs cost benchmark

Date: 2026-08-03 · Branch `feature/actionable-people-foundation` · HEAD `44364f1`

Harness: `evaluation/people_recommendations/cost_strategy_benchmark.py`
Run with `python -m evaluation.people_recommendations.cost_strategy_benchmark`.
Contacts no provider and spends no credit.

---

## 1. Why this exists

The 16→9 Person Search reduction had been made on reasoning alone — *"the funnel
accepts more now, so we can fetch less"* — and shipped alongside a configuration
where the referral **display cap (5)** exceeded the referral **fetch limit (4)**,
making that category unable to fill. This benchmark replaces the argument with a
measurement.

## 2. What it measures, and what it does not

It runs the **real** production gate chain — `validate_current_employment`,
`evaluate_actionable_contact`, `score_candidate`, and the display caps — over
fixed candidate pools across 9 job archetypes.

So it faithfully measures **what the pipeline does with a given pool**. It does
**not** measure provider recall: the pools are synthetic and their composition is
an assumption. Candidates are ordered best-match-first, because truncating a
ranked list is exactly what a smaller fetch limit does.

Composition is anchored to the only real evidence available: Samsara discovery
run 73 (recruiter 4 raw → 1 accepted; referral 8 raw → 0 accepted pre-fix, 4 of 4
stored candidates accepted post-fix) and one live PDL run (15 raw → 11 accepted,
73.3%).

Archetypes: SWE internship, ML engineer, backend/platform, product manager,
civil engineer, sales, non-technical operations, remote, site-specific.

## 3. Results

Totals across all 9 fixtures. Display caps 2 / 2 / 5.

| Strategy | Records | Recruiters | Managers | Referrals | Empty slots | Paid-but-rejected |
|---|---|---|---|---|---|---|
| A: 4/4/8 *(previous)* | 144 | 18 | 17 | 24 | 0 | 76 |
| B: 2/3/5 | 90 | 18 | 14 | 23 | 0 | 30 |
| C: 2/3/4 *(as shipped)* | 81 | 18 | **14** | 23 | 0 | 21 |
| D: 2 + shared 5 | 63 | 18 | 17 | **3** | **7** | 16 |
| D8: 2 + shared 8 | 90 | 18 | 17 | **4** | **6** | 42 |
| **E: 2/4/4 — selected** | **90** | **18** | **17** | **23** | **0** | 23 |

## 4. Findings

**The combined pool (Strategy D) fails structurally, and more of it does not
help.** Display precedence puts `likely_hiring_manager` ahead of
`potential_referral`, so managers claim the top-ranked technical records and
referrals starve: coverage collapses 24 → 3 with **seven category slots left
unfillable**. Enlarging the shared pool to 8 (D8) erases the entire cost saving
and still only reaches 4 referrals. This is an ordering property, not a tuning
problem — Stage 3's preferred design is rejected on evidence.

**Dropping the manager fetch to 3 costs real coverage.** B and C both lose three
displayed managers versus A. Restoring the manager fetch to 4 (E) recovers all
of them for one extra record per job.

**The referral fetch of 4 was not the risk I expected.** B (fetch 5) and C/E
(fetch 4) produce identical referral coverage (23). The fifth ranked record was
consistently unusable in these fixtures. That is a property of the fixture
ordering, not an observation about live output — so the 4-vs-5 question is
**resolved for this fixture set only**.

**Strategy A wastes 76 of 144 paid records.** E wastes 23 of 90.

## 5. Decision

**Strategy E: recruiter 2 / manager 4 / referral 4 = 10 records**, hard ceiling
`people_pdl_max_results_per_discovery = 10`.

- 38% fewer records than the 16-record baseline.
- **Zero regression** in recruiter and manager coverage (18 and 17, matching A).
- One fewer referral across nine jobs (23 vs 24).
- No category structurally unfillable; the referral cap/fetch inversion is gone.

This does not meet the ≥50% reduction target. The gate explicitly allows that
alternative — *"or a documented reason why 10 is the safest temporary
configuration"* — and this is that reason: every configuration measured below 10
records either regressed manager coverage (B, C) or destroyed referral coverage
(D, D8).

## 6. Limitations

- Synthetic pools. Real provider output may distribute usable candidates
  differently, which would change the 4-vs-5 referral result in particular.
- Relationship signals are unavailable in this environment, so all scoring runs
  with `relationship_signals_available=False`.
- No live provider calls were made for this benchmark.
- Progressive top-ups (Stage 4) are not implemented, so 10 is both the common
  path and the ceiling.

**Evidence label:** Integration tested with sanitized fixtures. Not verified
against live PDL.
