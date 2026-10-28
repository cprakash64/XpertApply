# Documents untracked-file snapshot (Stage 51F-1B)

Preserved on 2026-10-27 from `/Users/cprakash/Documents/Jobs/XpertApply` (branch `release/chrome-web-store` @ `e1affbf`).
These files were untracked and in no other ref. They are stored under `docs/plans/evidence/documents-untracked-snapshot/<original path>`.

## Do not integrate blindly
- `apps/api/alembic/versions/0027_application_applied_lifecycle.py` is an ALTERNATE variant of the tracked `0027_applied_lifecycle.py` (different revision id, same down_revision; tracked 0028 depends on the tracked one). Restoring it into `versions/` would create two Alembic heads.
- `zz-*`, `dbg2`, `__scratch__` and `test_zz_diag_tmp` are probe/audit/debug evidence, not tests to merge.
- `apps/web/app/icon.svg` and `apps/web/components/BrandLogo.tsx` are real UI source that exists in no other ref; relevant to the UI/UX overhaul.

## Files (original path | bytes | sha256 prefix)
- `apps/api/alembic/versions/0027_application_applied_lifecycle.py` | 4257 | 88494e8bebb445e0
- `apps/api/app/tests/test_zz_diag_tmp.py` | 1644 | 203a9fe08d42ca80
- `apps/extension/e2e/dbg2.spec.ts` | 4367 | 3495cb1ff9b31c0b
- `apps/extension/e2e/zz-3c-siteaccess.spec.ts` | 13608 | eb10ebbdb8c07b8c
- `apps/extension/e2e/zz-audit-a11y.spec.ts` | 5241 | eea6c046b41e735e
- `apps/extension/e2e/zz-audit-boundaries.spec.ts` | 9951 | dc0a249fd630700f
- `apps/extension/e2e/zz-audit-errors.spec.ts` | 6887 | c716008a2e815114
- `apps/extension/e2e/zz-audit-frame-leak.spec.ts` | 3912 | 804dedb9611c14c0
- `apps/extension/e2e/zz-audit-frames2.spec.ts` | 3445 | 91a6454f3e93075d
- `apps/extension/e2e/zz-audit-harness.ts` | 8398 | 2801d03bc7b456b4
- `apps/extension/e2e/zz-audit-legal.spec.ts` | 3967 | c3142d35c65f3883
- `apps/extension/e2e/zz-audit-legal2.spec.ts` | 3620 | a0aaf2ef637f4d5e
- `apps/extension/e2e/zz-audit-perf-control.spec.ts` | 2147 | 2010283a2fbffc62
- `apps/extension/e2e/zz-audit-perf-dormant.spec.ts` | 1613 | d256d9c0cec9d30c
- `apps/extension/e2e/zz-audit-perf.spec.ts` | 3816 | a6ea7159f1c07c1c
- `apps/extension/e2e/zz-audit-storage.spec.ts` | 2906 | 1e7863b92d79d7bb
- `apps/extension/e2e/zz-probe-perm.spec.ts` | 2256 | 3feaca0e7a9ab542
- `apps/extension/e2e/zz-probe-seed.spec.ts` | 2453 | 70ba6a4f40291aed
- `apps/extension/e2e/zz-verify-answers.spec.ts` | 4466 | eea2647064cbb98d
- `apps/extension/e2e/zz-verify-embedded-ats.spec.ts` | 6922 | 8ebcdf23521e734a
- `apps/extension/e2e/zz-verify-r1.spec.ts` | 4769 | 14132393f8cb95ed
- `apps/extension/e2e/zz-verify-resolver.spec.ts` | 4878 | 16f8d9dba6154710
- `apps/extension/src/__scratch__/sectionProbe.ts` | 993 | 39f1d8dfdf73a461
- `apps/extension/src/__tests__/zz_audit_perf.test.ts` | 1421 | cf80ef3c6afbd71f
- `apps/extension/src/__tests__/zz_scratch_3cv_proof.test.ts` | 6461 | e9c5982e3be47977
- `apps/web/__tests__/zz-leak-probe.test.tsx` | 1744 | d76129298f4966fd
- `apps/web/app/icon.svg` | 839 | 9c29f6f7deb77c1d
- `apps/web/components/BrandLogo.tsx` | 5324 | 0bf631459e6fbef2
- `jobpilot-ai/.claude/launch.json` | 239 | ee68787c2f7f511e
