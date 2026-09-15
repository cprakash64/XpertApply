# Stage 2G-C — Dependency Remediation + Production Dependency Split

**Branch** `recovery/stage3-security`
**Base HEAD** `86770add63e912ef75e593faba91ddfd21e3a529`
**Status** implemented, validated, not committed
**Closes** DEPENDENCY-01, NEW-02

---

## 1. What was wrong

**DEPENDENCY-01** — known-vulnerable packages in both production graphs.

**NEW-02** — `apps/api/requirements.txt` was a single undivided file containing
`pytest`, `pytest-asyncio` and `ruff`, and the Dockerfile installs exactly that
file. A test runner shipped in the production runtime, which is why the pytest
advisory was a production finding at all rather than a developer one.

---

## 2. Python advisories and actual reachability

| Advisory | Package | Reachable here? | Action |
|---|---|---|---|
| PYSEC-2024-232 algorithm confusion (OpenSSH ECDSA keys) | python-jose 3.3.0 | **No** — `algorithms=["HS256"]`, symmetric secret, no RS256/JWKS/Auth0 anywhere | package removed |
| PYSEC-2024-233, PYSEC-2025-185 JWE decompression bombs | python-jose 3.3.0 | **No** — only `jose.jwt`; no `jwe`/`jws` call site exists | package removed |
| PYSEC-2026-1325 Minerva timing on P-256 | ecdsa 0.19.2 (transitive) | **No** — affects signing/keygen/ECDH; verification unaffected; this service does none | package removed |
| PYSEC-2026-1845 `/tmp/pytest-of-*` | pytest 8.3.2 | shipped in the production image | removed from production **and** upgraded in dev |

None of the python-jose or ecdsa paths were reachable. That is a property of
today's call sites, not of the libraries — and the ecdsa advisory has **no
upstream fix planned**, so upgrading could never clear it. Carrying a
permanently-unfixable transitive dependency into a public release is the thing
being avoided, not a live exploit.

---

## 3. JWT migration: python-jose → PyJWT 2.14.0

Two independent helpers, both migrated:

| | before | after |
|---|---|---|
| `app/core/security.py` | `jose.jwt`, `JWTError` | `jwt` (PyJWT), `InvalidTokenError` |
| `app/core/session_tokens.py` | same | same |

**The HS256-only contract is unchanged.** Both modules keep `ALGORITHM =
"HS256"` and pass it to `jwt.decode` as a single-element `algorithms` list, so
the accepted algorithm is stated by this service and never read from the
token's header. That is the property that made the confusion advisory
unreachable, and it is what the new tests defend.

**Encode** returns `str` on every supported PyJWT version — callers put it
straight into an `Authorization` header, so a bytes return would have been a
silent contract change. Asserted.

**Exceptions.** `InvalidTokenError` is PyJWT's base class for bad signature,
expiry, malformed input and disallowed algorithm alike, so catching it
reproduces the old `JWTError` boundary exactly: a bad token returns `None` and
the caller answers 401. An escaping exception would have been a 500, and the
HTTP boundary is asserted in both directions.

### The hand-rolled fallback was removed

Both modules wrapped the import in `try/except ModuleNotFoundError` and fell
back to ~40 lines of hand-written HMAC JWT encoding and decoding. It was dead:
`python-jose` was a pinned requirement, one module's own comment said
`# pragma: no cover - jose is installed in this project`, and no test referenced
`_encode_hs256` or `_decode_hs256`. It was also looser than the real thing — the
fallback decoder never inspected the header's `alg` at all.

PyJWT is now a hard runtime dependency and there is one authoritative
implementation. Keeping untested bespoke cryptography beside a library whose
whole job is that cryptography would have been the worse choice.

---

## 4. `cryptography` — a runtime dependency found by removing python-jose

`python-jose[cryptography]` was pulling in `cryptography`, and two **runtime**
modules import it directly:

- `app/profile/credentials.py` — Fernet, encrypted Workday credential store
- `app/people/security.py` — Fernet, people email store

Removing python-jose therefore broke them with a bare `ModuleNotFoundError` at
import time — caught by installing the new set into a clean throwaway
environment before adopting it, which is exactly why that step exists. It is now
an explicit runtime pin, `cryptography==50.0.1`, currently with no known
advisories.

This is the failure mode §17 of the stage brief warns about, and it would have
reached production as a startup crash in credential decryption.

---

## 5. Runtime / development split

```
apps/api/requirements.txt       runtime only — what the image installs
apps/api/requirements-dev.txt   -r requirements.txt  +  pytest, pytest-asyncio, ruff
```

`requirements-dev.txt` includes the runtime file rather than restating it, so
the two cannot drift.

Every direct requirement was classified by actual import site, not by name:

| classification | packages |
|---|---|
| runtime (direct imports) | httpx (9 modules), openai, pypdf, python-docx, reportlab, phonenumbers, redis, celery, alembic (35), passlib, starlette, cryptography, PyJWT |
| runtime (driver / server / backend, no direct import) | psycopg, bcrypt, email-validator, python-multipart, uvicorn, fastapi, pydantic, pydantic-settings, SQLAlchemy |
| **dev/test only** | **pytest, pytest-asyncio, ruff** |

Exactly three moved. `psycopg`, `bcrypt`, `email-validator`, `python-multipart`
and `uvicorn` have zero direct imports and are still runtime — a name-based
sweep would have removed them and broken the image.

**pytest was upgraded, not merely relocated.** PYSEC-2026-1845 is fixed in
9.0.3; the dev set moves to pytest 9.1.1, which requires pytest-asyncio 1.x
(0.23.x caps at pytest <9), so the two moved together. The full API suite was
run against the new dev set in a clean venv before adoption.

Install paths updated: `.github/workflows/ci.yml` (CI runs ruff and pytest),
the `Makefile` bootstrap hint, and `docs/DEVELOPMENT.md`. The Dockerfile is
unchanged except for a comment stating the runtime-only intent at the install
line.

---

## 6. Production image proof

Built locally from `apps/api/Dockerfile`, not deployed. `pip check`: no broken
requirements.

| present | absent |
|---|---|
| PyJWT 2.14.0, cryptography 50.0.1, fastapi 0.141.1, starlette 1.6.0, uvicorn 0.30.5, celery 5.4.0, redis 5.0.8, SQLAlchemy 2.0.32, alembic 1.13.2, psycopg 3.2.1, passlib, bcrypt, python-multipart, pydantic, httpx, openai, pypdf, python-docx, reportlab, phonenumbers, email-validator | **python-jose, ecdsa, pytest, pytest-asyncio, ruff** |

Runtime smoke inside the image: settings import (`app_env=production`,
`retention_cleanup_enabled=False`), FastAPI app import, Celery import (beat =
`['daily-job-ingestion']` only), JWT round-trip, scoped-token round-trip,
credential module import, alembic import.

`pip-audit` against the image's own 66-package freeze: **no known
vulnerabilities**. Same result for `requirements-dev.txt`.

---

## 7. npm remediation

There is **no workspace**: `apps/web` and `apps/extension` have separate
lockfiles, so Web changes cannot reach the extension graph.

The existing `overrides` block was pinning two packages *down* to the vulnerable
releases. It was raised rather than removed — it exists to keep one resolved
copy, and deleting it would have allowed duplicates.

| package | before | after | why |
|---|---|---|---|
| next | 16.2.10 | **16.3.5** | two critical RCEs fixed in 16.3.3 (AVIF image optimization, Windows host) plus 9 high/moderate fixed in 16.2.11. `next/image` is used, so the image-optimization path is live |
| postcss | 8.5.16 | **8.5.28** | sourceMappingURL path traversal |
| sharp | 0.35.3 | **0.35.4** | libheif advisories |
| nanoid | 3.3.15 | **3.3.19** | unbounded loop DoS |
| baseline-browser-mapping | 2.10.42 | **2.11.23** | invalid-input DoS |

Also bumped: `eslint-config-next` to match Next, and the direct `postcss` dev
pin to match its override.

Then `npm audit fix` — **without `--force`**, so semver-compatible only — cleared
the remaining dev-only findings: vitest 4.1.10→4.1.11, js-yaml 4.3.0→4.3.2,
browserslist 4.28.5→4.28.9, brace-expansion 5.0.7→5.0.12.

### Lockfile scope

| | |
|---|---|
| packages before / after | 598 / 598 |
| added / removed | 1 / 1 — the same `@vitest/mocker`, hoisted from nested to top level (deduplication) |
| version changes | 63 |
| **major version changes** | **0** |

Controlled churn, no majors, no `--force`, no mass upgrade.

### Audit results

| | before | after |
|---|---|---|
| production (`--omit=dev`) | 1 critical, 3 high, 1 moderate | **0** |
| full (incl. dev) | 1 critical, 6 high, 10 moderate | **0** |

No finding is newly introduced: every package in the post-change audit was
already present in the pre-change audit, and the post-change set is empty.

---

## 8. What is *not* claimed

These dependency graphs are not "vulnerability-free" in any absolute sense —
they are free of *known, published* advisories as of this audit, against the
databases `pip-audit` and `npm audit` consult. New advisories appear against
unchanged code. What is claimed is narrower and checkable: the specific
DEPENDENCY-01 and NEW-02 findings are closed, and no new Critical or High was
introduced.

The extension's own lockfile was not audited in this stage and is unchanged.

---

## 9. Validation

| | result |
|---|---|
| JWT algorithm security (new) | 33/33 |
| focused auth / sessions / applications | 96/96 |
| NEW-01 kill-switch nonregression | 49/49 |
| full API ×2 | **1957/1957** each, exit 0 (baseline 1924, +33) |
| Ruff | PASS from the dev environment, absent from the image |
| Celery / Alembic / FastAPI import | PASS |
| production image build + `pip check` + smoke | PASS |
| Web lint / typecheck | PASS |
| Web unit | 927/927 |
| Web production build | PASS (Next 16.3.5) |
| Web E2E | 38 passed, 20 environment-skipped by design; Tracker + applied-to-tracker 8/8 |
| extension typecheck / build / focused security | PASS, 85/85 |

Extension full unit and MV3 were **skipped by design**, on evidence: the
extension has its own lockfile, whose SHA-256 is byte-identical before and
after (`3c3b769c…`), and `git status -- apps/extension` is empty. FLAKE-01 is
untouched and remains open.

---

## 10. Rollback

**Python.** Reverting to python-jose reintroduces DEPENDENCY-01 including the
unfixable ecdsa advisory, and is not an acceptable production rollback without
explicit written security acceptance. Reverting the requirements split
reintroduces NEW-02. If the API must be rolled back, roll back to the last
known-secure image rather than to this change's parent.

**Web.** Rolling back to Next 16.2.10 restores two critical RCE advisories, one
of which is on a live code path (`next/image`). After public launch this is not
a normal rollback; prefer forward-fixing or the last secure build.

**Safe to revert independently:** the `npm audit fix` dev-only bumps (vitest,
js-yaml, browserslist, brace-expansion) carry no production exposure.

The one change that must **not** be reverted in isolation is the `cryptography`
pin — without it, removing python-jose breaks credential decryption at import.
