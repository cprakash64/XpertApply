# Canonical repository and local artifacts

Date: 2026-11-11. The one permanent local checkout is `/Users/cprakash/Documents/Jobs/XpertApply`
(origin `https://github.com/cprakash64/XpertApply.git`).

## Why nothing had to be "imported"
`~/Developer/XpertApply-extlive` and `~/Developer/XpertApply-extfinal` are `git worktree`s that share this
repository's git directory (`~/.xpertapply-runtime/XpertApply-git-20260902-162256`, reached via the `.git` gitfile).
Their branches (`feature/ext-live-01`, `release/ext-final-01`) were already local branches here and both worktrees were
clean. `~/Developer/XpertApply` and `~/Developer/XpertApply-stage5-verify` are separate clones; every ref they hold
resolves to a commit that exists in this repository.

## Branch topology
`feature/premium-ui-overhaul` (32a7d54) is an ancestor of `release/ext-final-01` (dcfc59e), which is an ancestor of
`feature/ext-live-01` (715ecf1, EXT-LIVE-11 Workable). The consolidation branch
`consolidate/xpertapply-canonical-20261111` starts at 715ecf1 (fast-forward, no merge conflicts to resolve) so it contains
the premium UI, all EXT-LIVE-01..11 work and EXT-FINAL-01..03.

## Paths
Scripts that used `~/Developer/XpertApply-*` now resolve the repo from their own location
(`tools/release/make-store-id-build.sh`, `tools/release/pack_ext.py`, `docs/release/extfinal03-bundle/test_extfinal03.py`,
`apps/extension/e2e/xa-core1-connect.spec.ts`). Older release records under `docs/release/EXT-*` keep their original
paths on purpose: they are historical. Remote VPS paths are untouched.

## Local-only artifacts (NOT on GitHub)
`local-artifacts/` is git-ignored. Hashes of everything in it: `local-artifacts/MANIFEST.sha256` (also local-only).
- `releases/extension-zips/` extension ZIPs 0.3.1 (05w, 06, 07, 08, 09, 10, 44c107e, ba2941f) + `.sha256`, plus the
  ZIPs left in the extlive and extfinal worktrees
- `releases/nav02-cutover/` NAV-02 cutover script/zip and git bundle
- `store-assets/` Chrome Web Store screenshots and icon
- `recovery/xpertapply-all-refs-20261111.bundle` git bundle of every ref (verified)
- `recovery/developer-XpertApply-uncommitted-design-system-audit.patch` the only uncommitted change found in a
  satellite clone
- `recovery/evidence/` CWS qualification evidence, 2026-08-29 working-tree snapshot and recovery evidence

Also untracked and local-only: `docs/release/evidence/pui-stg2/` (325 MB staging image tar), `apps/extension/dist-*`
(regenerable), `.env` (secrets, never copy), `jobpilot-after-0013.dump` (DB dump, ignored by `*.dump`).

## Git directory (updated 2026-11-12)
`.git` is now a real directory inside this folder (previously a gitfile pointing at
`~/.xpertapply-runtime/XpertApply-git-20260902-162256`). It was copied with `cp -Rp`, `core.worktree` was removed and
`git fsck --full` was clean. The external directory is untouched. The extlive and extfinal worktree registrations were
carried over; those worktrees still use the old directory until they are retired (`git worktree remove` is a later,
user-approved step). The old gitfile is kept as `.git.external-gitfile.bak` (locally excluded).
Backups: `/Volumes/VeoTrexBackup/XpertApply-backup-20261112/` (all-refs bundle, raw copy of the old git dir,
`local-artifacts/`). That is a second disk on the same machine, not off-site.
