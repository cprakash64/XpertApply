#!/usr/bin/env bash
#
# Repeatable real-extension E2E release gate.
#
#   scripts/e2e-gate.sh [--sha REV] [--runs N] [--max-load X] [--wait-min M]
#                       [--out DIR] [--expect-tests N] [--install-browser]
#                       [--preflight-only] [--keep]
#
# Every run uses its OWN fresh detached `git worktree` of one exact commit, so the
# dev checkout (and anything iCloud or a stale dist/ has left in it) cannot
# influence a result. The prerequisites that the specs need but Playwright's
# globalSetup does NOT provide are created and VERIFIED before any test starts,
# so a missing prerequisite aborts with exit 3 instead of surfacing as a test
# failure that looks like a product regression:
#
#   * apps/extension/node_modules   npm ci (lockfile)
#   * apps/web/node_modules         npm ci (xa12 spawns `next dev` from it)
#   * apps/extension/dist           production build, id must equal the commit
#   * Chromium revision Playwright pins (never downloaded unless --install-browser)
#   * loopback port 3000 or 3001 free (xa12's web fixture)
#
# The host must also be quiet: load1 below --max-load for two consecutive
# samples taken immediately before each run. If that never happens within
# --wait-min the run is reported NOT RUN, never silently executed under load.
#
# No retries are ever used. A failed run stays failed; failed tests are then
# re-run in isolation as a DIAGNOSTIC only and never change the run's verdict.
#
# Exit: 0 all runs passed | 1 a run failed | 2 host never quiet | 3 prerequisite.
# Nothing is pushed, committed, or deleted except the worktrees this script made.

set -o pipefail

SHA=HEAD; RUNS=3; MAX_LOAD=4.0; WAIT_MIN=45; OUT=""; EXPECT_TESTS=""
KEEP=0; PREFLIGHT_ONLY=0; INSTALL_BROWSER=0

usage() { sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
die() { echo "gate: $*" >&2; exit "${CODE:-3}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA="$2"; shift 2 ;;
    --runs) RUNS="$2"; shift 2 ;;
    --max-load) MAX_LOAD="$2"; shift 2 ;;
    --wait-min) WAIT_MIN="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --expect-tests) EXPECT_TESTS="$2"; shift 2 ;;
    --install-browser) INSTALL_BROWSER=1; shift ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "gate: unknown option $1" >&2; usage 3 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)" || die "not inside a git repository"
FULL="$(git -C "$REPO" rev-parse --verify "$SHA^{commit}" 2>/dev/null)" || die "cannot resolve commit '$SHA'"
SHORT="$(printf '%s' "$FULL" | cut -c1-7)"
TREE="$(git -C "$REPO" rev-parse "$FULL^{tree}")"
[ -n "$OUT" ] || OUT="${TMPDIR:-/tmp}/xa-e2e-gate-$(date +%Y%m%d-%H%M%S)"
OUT="${OUT%/}"

# Evidence and worktrees must not live in a cloud-synced folder: File Provider
# enumerates files lazily and its sync daemons add enough load to defeat the
# quiet-host check.
case "$OUT" in
  */Documents/*|*/Desktop/*|*"/Mobile Documents/"*|*/CloudStorage/*|*/iCloud*)
    die "--out '$OUT' looks cloud-synced; use a path under /tmp or \$TMPDIR" ;;
esac
mkdir -p "$OUT" || die "cannot create $OUT"

WTS=()
cleanup() {
  [ "$KEEP" = 1 ] && return
  for wt in "${WTS[@]}"; do
    case "$wt" in "$OUT"/*) git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1 ;; esac
  done
}
trap cleanup EXIT

load1() {
  if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg
  else sysctl -n vm.loadavg | awk '{print $2}'; fi
}
below() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a<b)}'; }
stats() { sort -n | awk '{a[NR]=$1} END{if(NR) printf "min %.1f median %.1f max %.1f (n=%d)", a[1], a[int((NR+1)/2)], a[NR], NR; else printf "no samples"}'; }
say() { printf '%s %s\n' "$(date +%T)" "$*" | tee -a "$OUT/gate.log"; }
browser_root() {
  if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ "$PLAYWRIGHT_BROWSERS_PATH" != 0 ]; then echo "$PLAYWRIGHT_BROWSERS_PATH"
  elif [ "$(uname)" = Darwin ]; then echo "$HOME/Library/Caches/ms-playwright"
  else echo "$HOME/.cache/ms-playwright"; fi
}

say "gate: commit $FULL (tree $TREE), runs=$RUNS, max-load=$MAX_LOAD, out=$OUT"

# ---- host-level preflight ----------------------------------------------------
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
if port_busy 3000 && port_busy 3001; then die "loopback ports 3000 and 3001 are both in use (xa12 needs one)"; fi
if pgrep -f "playwright test" >/dev/null 2>&1; then die "another 'playwright test' is already running"; fi
FREE_KB="$(df -k "$OUT" | awk 'NR==2{print $4}')"
[ "${FREE_KB:-0}" -ge 3145728 ] || die "less than 3 GiB free under $OUT"

# ---- per-run prerequisites ---------------------------------------------------
# Creates a fresh worktree and proves every prerequisite. Sets WT.
prepare_worktree() {
  local n="$1" rd="$OUT/run$n"; mkdir -p "$rd"
  WT="$rd/wt"
  git -C "$REPO" worktree add --detach "$WT" "$FULL" >"$rd/worktree.log" 2>&1 || die "run $n: cannot create worktree (see $rd/worktree.log)"
  WTS+=("$WT")
  [ "$(git -C "$WT" rev-parse HEAD)" = "$FULL" ] || die "run $n: worktree is not at $SHORT"
  [ -z "$(git -C "$WT" status --porcelain)" ] || die "run $n: fresh worktree is not clean"

  say "run $n: npm ci (extension)"
  (cd "$WT/apps/extension" && npm ci --no-audit --no-fund) >"$rd/npm-extension.log" 2>&1 || die "run $n: extension npm ci failed ($rd/npm-extension.log)"
  say "run $n: npm ci (web, needed by xa12's next dev fixture)"
  (cd "$WT/apps/web" && npm ci --no-audit --no-fund) >"$rd/npm-web.log" 2>&1 || die "run $n: web npm ci failed ($rd/npm-web.log)"
  say "run $n: production build"
  (cd "$WT/apps/extension" && npm run build) >"$rd/build.log" 2>&1 || die "run $n: production build failed ($rd/build.log)"

  local dist="$WT/apps/extension/dist"
  [ -f "$dist/manifest.json" ] || die "run $n: dist/manifest.json missing after build"
  [ -f "$dist/icons/xpertapply-128.png" ] || die "run $n: dist icons missing"
  grep -q "$SHORT" "$dist/manifest.json" || die "run $n: dist build id does not carry $SHORT"
  if grep -q dirty "$dist/manifest.json"; then die "run $n: dist build id is marked dirty"; fi
  [ -f "$WT/apps/web/node_modules/next/dist/bin/next" ] || die "run $n: next binary missing in apps/web"

  local rev
  rev="$(node -e 'const f=require("fs");const b=JSON.parse(f.readFileSync(process.argv[1],"utf8")).browsers.find(x=>x.name==="chromium");console.log(b.revision)' "$WT/apps/extension/node_modules/playwright-core/browsers.json")" || die "run $n: cannot read pinned Chromium revision"
  if [ ! -d "$(browser_root)/chromium-$rev" ]; then
    if [ "$INSTALL_BROWSER" = 1 ]; then
      say "run $n: installing Chromium $rev (--install-browser)"
      (cd "$WT/apps/extension" && npx playwright install chromium) >"$rd/browser-install.log" 2>&1 || die "run $n: browser install failed"
    else
      die "run $n: Playwright pins Chromium revision $rev, which is not installed at $(browser_root). Re-run with --install-browser (downloads ~550 MB) or run: npx playwright install chromium"
    fi
  fi
  echo "chromium-$rev" >"$rd/browser.txt"

  # The specs that drive the real extension launch a persistent context.
  SPECS="$(cd "$WT/apps/extension" && grep -l launchPersistentContext e2e/*.spec.ts | sort | tr '\n' ' ')"
  [ -n "$SPECS" ] || die "run $n: found no real-extension specs"
  LISTED="$(cd "$WT/apps/extension" && npx playwright test $SPECS --list 2>/dev/null | awk '/^Total:/{print $2; exit}')"
  NSPECS="$(printf '%s' "$SPECS" | wc -w | tr -d ' ')"
  if [ -n "$EXPECT_TESTS" ] && [ "$LISTED" != "$EXPECT_TESTS" ]; then
    die "run $n: --expect-tests $EXPECT_TESTS but Playwright lists ${LISTED:-?}"
  fi
  say "run $n: prerequisites verified ($NSPECS spec files, ${LISTED:-?} tests, chromium-$rev, build $SHORT)"
}

tree_intact() {  # next dev legitimately regenerates apps/web/next-env.d.ts
  git -C "$WT" diff --quiet HEAD -- . ':!apps/web/next-env.d.ts' 2>/dev/null
}

wait_quiet() {
  local rd="$1" deadline streak=0 l
  deadline=$(( $(date +%s) + WAIT_MIN * 60 ))
  : >"$rd/wait.log"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    l="$(load1)"; echo "$(date +%T) $l" >>"$rd/wait.log"
    if below "$l" "$MAX_LOAD"; then streak=$((streak + 1)); else streak=0; fi
    [ "$streak" -ge 2 ] && return 0
    sleep 30
  done
  return 1
}

# ---- runs --------------------------------------------------------------------
SUMMARY="$OUT/summary.txt"; : >"$SUMMARY"
OVERALL=0
n=1
while [ "$n" -le "$RUNS" ]; do
  RD="$OUT/run$n"
  prepare_worktree "$n"
  if [ "$PREFLIGHT_ONLY" = 1 ]; then
    say "run $n: PREFLIGHT ONLY - all prerequisites verified; no tests executed"
    echo "run $n: PREFLIGHT_OK" >>"$SUMMARY"; n=$((n + 1)); [ "$n" -le "$RUNS" ] && continue; break
  fi

  say "run $n: waiting for a quiet host (load1 < $MAX_LOAD twice in a row, up to $WAIT_MIN min)"
  if ! wait_quiet "$RD"; then
    say "run $n: NOT RUN - host never quiet ($(awk '{print $2}' "$RD/wait.log" | stats))"
    echo "run $n: NOT_RUN host-never-quiet $(awk '{print $2}' "$RD/wait.log" | stats)" >>"$SUMMARY"
    OVERALL=2; break
  fi

  say "run $n: START at load1=$(load1) on $SHORT"
  ( while :; do echo "$(date +%T) $(load1)" >>"$RD/load.log"; sleep 15; done ) & SAMPLER=$!
  START=$(date +%s)
  (cd "$WT/apps/extension" && PLAYWRIGHT_JSON_OUTPUT_NAME="$RD/result.json" \
     npx playwright test $SPECS --workers=1 --retries=0 --reporter=list,json) >"$RD/playwright.log" 2>&1
  PWEXIT=$?
  DUR=$(( $(date +%s) - START ))
  kill "$SAMPLER" 2>/dev/null; wait "$SAMPLER" 2>/dev/null

  node "$HERE/e2e-gate-report.mjs" "$RD/result.json" "$RD/failed-tests.txt" >"$RD/report.txt"
  COUNTS="$(grep '^COUNTS' "$RD/report.txt")"
  field() { printf '%s' "$COUNTS" | tr ' ' '\n' | awk -F= -v k="$1" '$1==k{print $2}'; }
  PASSED="$(field passed)"; FAILED="$(field failed)"; FLAKY="$(field flaky)"; SKIPPED="$(field skipped)"; RETRIED="$(field retried)"; TOTAL="$(field total)"
  LOAD="$(awk '{print $2}' "$RD/load.log" | stats)"

  VERDICT=FAIL
  if [ "$PWEXIT" = 0 ] && [ "${FAILED:-1}" = 0 ] && [ "${FLAKY:-1}" = 0 ] && [ "${SKIPPED:-1}" = 0 ] \
     && [ "${RETRIED:-1}" = 0 ] && [ "${PASSED:-0}" = "${TOTAL:-x}" ] && [ "${TOTAL:-0}" -gt 0 ] \
     && { [ -z "$LISTED" ] || [ "$TOTAL" = "$LISTED" ]; } && tree_intact; then
    VERDICT=PASS
  fi
  tree_intact || say "run $n: WARNING tracked files changed during the run (other than next-env.d.ts)"
  [ "$VERDICT" = PASS ] || OVERALL=1

  say "run $n: $VERDICT exit=$PWEXIT $PASSED/$TOTAL passed failed=$FAILED flaky=$FLAKY skipped=$SKIPPED retries-used=$RETRIED ${DUR}s load $LOAD"
  echo "run $n: $VERDICT exit=$PWEXIT passed=$PASSED/$TOTAL failed=$FAILED flaky=$FLAKY skipped=$SKIPPED retries=$RETRIED dur=${DUR}s load[$LOAD]" >>"$SUMMARY"

  if [ "$VERDICT" != PASS ] && [ -s "$RD/failed-tests.txt" ]; then
    grep '^FAILED' "$RD/report.txt" | sed 's/^/    /' | tee -a "$SUMMARY"
    # DIAGNOSTIC ONLY: never changes the verdict above.
    while IFS= read -r t; do
      [ -n "$t" ] || continue
      key="$(printf '%s' "$t" | tr '/:.' '___')"
      (cd "$WT/apps/extension" && npx playwright test "$t" --workers=1 --retries=0 --reporter=list) >"$RD/isolated-$key.log" 2>&1
      iso=$?; say "run $n: isolated re-run of $t -> exit $iso (diagnostic only)"
      echo "    isolated $t -> exit $iso (diagnostic only; run stays FAIL)" >>"$SUMMARY"
    done <"$RD/failed-tests.txt"
  fi
  n=$((n + 1))
done

say "gate: done. summary -> $SUMMARY"
echo "---- $SHORT ----"; cat "$SUMMARY"
exit "$OVERALL"
