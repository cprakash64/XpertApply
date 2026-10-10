# PROD-READY-04A dependency/runtime remediation

## Scope and architecture
Only RB01 parser dependency and RB03 runtime/image security. Start da57bb7cb76b3e21532c3758818355def399e805, detached. No deployment, push, production mutation or RSC investigation. Evidence: /Users/cprakash/Developer/XpertApply-cws-qualification-repair-evidence/prod-ready-04a.

## Decisions
Upgrade pypdf 5.1.0 to minimum patched 6.19.0, preserving the PdfReader text extraction API. DOCX and parser product logic remain unchanged. RB02 unbounded initial read and parser resource controls remain release blockers.

Use Node 24.21.0 Active LTS; .nvmrc and Docker exact patch, CI deliberately tracks supported 24 security patch family. Retain Next 16.3.5: audited severe paths proven unreachable, no justification for framework movement. Enable standalone output solely to remove dev dependencies from production; run as existing node UID 1000. Remove npm installer from final runtime. Refresh base OS security packages during clean build. Pin official base index digests, supporting arm64 and amd64.

Use Python 3.12.15 on maintained slim Trixie; preserve Python 3.12 family and app entrypoint behavior. Same-major Postgres 16.15 addresses sixteen High advisory paths without a data-major migration. Pin same-major Redis 7.4.11 and its verified official digest after current image refresh reduces advisory matches; no new server major or persistence/queue policy. No overrides added; npm locks stay byte-identical.

## Progress and validation
Baseline manifests and fresh package/image scans captured before modification; prior evidence 244-file SHA manifest verified. Full Web/API/extension suites, seven scratch-database migration checks, generated parser fixtures, clean production images, final package/image scans and disposable synthetic production startup are required before checkpoint. Archived R13 parity only: 25 R6, 27 archives, zero known-failure false negatives; classifier bytes must match.

## Rollout and rollback
This checkpoint authorizes no rollout. RB04 remains BLOCKED; FRESH_QUALIFICATION_REQUIRED_FOR_NEW_RUNTIME_CANDIDATE=YES. RB02/RB04/RB05/RB06/RB07/RB08/RB09 remain for later stages. Future owner-approved rollout requires fresh exact-candidate qualification and all other gates. Rollback of this local dependency change is reverting the checkpoint (or restoring reviewed uncommitted files); no schema changes. Prior images cannot be approved for production because their security/runtime blockers persist.

## Verified outcome
Web 1,033 pass; backend 1,955 pass (baseline 1,942 plus 13 synthetic parser tests); extension 809 pass/10 existing skips. All lint/type/build checks pass; 7 scratch migration tests and 14 focused Web security/Compose tests pass. Four no-cache Linux/arm64 images build; non-root Node24 standalone runtime has 25 packages, no npm/vitest/TypeScript, writable .next/tmp. All four images pass final-app secret/artifact scan. Disposable production stack upgrades through 0033, API/Postgres/Redis/worker healthy, scheduler/Web running, healthz/readyz and enforced CSP/private no-store Web smoke pass; destroyed afterward. Initial synthetic fixture missing encryption key correctly failed config validation; corrected fixture passes. Initial password-masking legacy migration fixture failures resolved using isolated loopback trust, with complete suite rerun. Production contracts unchanged.

Baseline 335 alias-deduplicated advisories (3 Critical/91 High); final runtime 149 (1 Critical/20 High), all remaining severe entries NOT_REACHABLE_PROVEN. Dispositions: 138 FIXED, 48 DEV_ONLY, 79 NOT_REACHABLE_PROVEN, 70 lower-severity BLOCKING_UNCERTAIN (29 Moderate/41 Low). Zero blocking Critical/High under audited RB01/RB03, not zero vulnerabilities. No suppression or assertions relaxed. Native proofs cite exact vulnerable APIs, actual ELF/graph inspection and verified upstream source; product dependency graph moves only pypdf. Prior 31 reachable parser findings patched, 6 High included.

R13 classifier hash cd34f4126b8652b72e02cf05a824e1a3d069d97e85e8c02bce1fe13e0612c1d9 unchanged; 25/25 R6, 27/27 archives, 14 failure controls zero false negatives, 1,022 gate comparisons, 1,536 legacy comparisons, 25 labels and 4 integrations pass. Historical qualification remains BLOCKED. Fresh exact-runtime qualification is required later; none performed here. No push, deploy or production mutation. Continue to PROD-READY-04B; withhold release approval.
