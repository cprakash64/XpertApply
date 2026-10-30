#!/usr/bin/env bash
# Exercises staging-s3-web-release.sh against a STUB docker/curl that model the staging host state machine (images, containers, tags,
# compose recreate, headers). Runs inside a throw-away Debian container because the script uses Linux tools (flock, sha256sum).
#   bash test-s2-release-script.sh            (needs Docker)
set -uo pipefail
if [[ "${1:-}" != "--inside" ]]; then
  D="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  exec docker run --rm -v "$D:/repo:ro" nginx:1.24 bash /repo/release/pui-s3/test-s3-release-script.sh --inside
fi
MARK='summary, [role="button"], [role="link"], [role="menuitem"]'; R=/repo/release; SCRIPT=$R/pui-s3/staging-s3-web-release.sh; T=$(mktemp -d); export XA_STUB=$T/stub; fail=0
mkdir -p $XA_STUB/img $XA_STUB/tag $XA_STUB/ctr $T/infra $T/bin $T/state
pass(){ echo "PASS  $1"; }; bad(){ echo "FAIL  $1"; fail=1; }
fpof(){ printf '["%s"]\n' "$1" | sha256sum | cut -d' ' -f1; }
# ---- stub docker -------------------------------------------------------------------------------------------------------
cat > $T/bin/docker <<'STUB'
#!/usr/bin/env bash
S=$XA_STUB; a=("$@")
resolve(){ local r="$1" f="$S/tag/${1//[\/:]/_}"; if [[ -f "$f" ]]; then cat "$f"; elif [[ -f "$S/img/${r//[\/:]/_}" ]]; then echo "$r"; else return 1; fi; }
imgf(){ local id; id="$(resolve "$1")" || return 1; echo "$S/img/${id//[\/:]/_}"; }
field(){ sed -n "$2p" "$1"; }   # 1 id 2 fp 3 rev 4 arch
newcid(){ head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
case "${a[0]}" in
context) echo default ;;
tag) id="$(resolve "${a[1]}")" || exit 1; echo "$id" > "$S/tag/${a[2]//[\/:]/_}" ;;
image) [[ "${a[1]}" == inspect ]] || exit 1; fmt=""; ref=""; if [[ "${a[2]}" == -f ]]; then fmt="${a[3]}"; ref="${a[4]}"; else ref="${a[2]}"; fi
  f="$(imgf "$ref")" || exit 1
  case "$fmt" in "") exit 0 ;; '{{.Id}}') field "$f" 1 ;; '{{json .RootFS.Layers}}') printf '["%s"]\n' "$(field "$f" 2)" ;;
    *revision*) field "$f" 3 ;; '{{.Os}}/{{.Architecture}}') echo "linux/$(field "$f" 4)" ;; *) exit 1 ;; esac ;;
inspect) fmt="${a[2]}"; c="$S/ctr/${a[3]}"; [[ -f "$c" ]] || exit 1
  case "$fmt" in '{{.Image}}') sed -n 1p "$c" ;; '{{.Id}}') printf '%s%s\n' "$(sed -n 2p "$c")" "0000000000000000000000000000000000000000000000000000" | cut -c1-64 ;;
    '{{.State.StartedAt}}') sed -n 3p "$c" ;; *Mounts*) echo "vol_web:/data " ;; *Health*) [[ -f "$S/unhealthy" ]] && echo unhealthy || echo healthy ;; *) exit 1 ;; esac ;;
ps) for c in "$S"/ctr/*; do echo "$(basename "$c") $(sed -n 2p "$c") $(sed -n 1p "$c")"; done ;;
exec) case "${a[2]}" in alembic) echo "0034_password_reset (head)" ;; printenv) : ;; *) exit 1 ;; esac ;;
compose) echo "compose ${a[*]}" >> "$S/compose.log"
  dry=0; flags=""; for x in "${a[@]}"; do [[ "$x" == --dry-run ]] && dry=1; flags="$flags $x"; done
  ovr=""; prev=""; for x in "${a[@]}"; do [[ "$prev" == -f && -f "$x" ]] && grep -q '^services:' "$x" && ovr="$x"; prev="$x"; done
  svc="${a[${#a[@]}-1]}"; [[ "$svc" == web ]] || { echo "UNEXPECTED service $svc" >> "$S/compose.log"; exit 9; }
  for need in --no-deps --no-build --profile; do [[ "$flags" == *" $need"* ]] || { echo "MISSING $need" >> "$S/compose.log"; exit 9; }; done
  [[ "$flags" == *"--pull never"* ]] || { echo "MISSING --pull never" >> "$S/compose.log"; exit 9; }
  c="$S/ctr/xpertapply-staging-web"; cid="$(sed -n 2p "$c")"
  if [[ $dry == 1 ]]; then printf ' DRY-RUN MODE -  Container xpertapply-staging-web  Recreate\n DRY-RUN MODE -  Container xpertapply-staging-web  Recreated\n DRY-RUN MODE -  Container %s_xpertapply-staging-web  Starting\n DRY-RUN MODE -  Container %s_xpertapply-staging-web  Started\n' "$cid" "$cid"; exit 0; fi
  [[ -f "$S/fail_up" ]] && exit 1
  img="$(grep image: "$ovr" | awk '{print $2}')"; id="$(resolve "$img")" || exit 1
  printf '%s\n%s\n%s\n' "$id" "$(newcid)" "$(date -u +%FT%TZ)" > "$c"
  [[ -f "$S/fail_up_after" ]] && exit 1; exit 0 ;;
*) echo "UNEXPECTED docker ${a[*]}" >> "$S/compose.log"; exit 1 ;;
esac
STUB
# ---- stub curl: header model of staging (S1 via nginx + app headers) and production ------------------------------------------
cat > $T/bin/curl <<'STUB'
#!/usr/bin/env bash
S=$XA_STUB; url=""; dump=0; wfmt=""; prev=""
for x in "$@"; do case "$prev" in -w) wfmt="$x";; esac; [[ "$x" == -D ]] && dump=1; url="$x"; prev="$x"; done
host="${url#*://}"; host="${host%%/*}"; path="/${url#*://*/}"; [[ "$url" == */ && "$path" == "/$url" ]] && path=/
[[ "$host" == "$url"* || "$path" == "/${url}" ]] && path=/
cand=0; [[ "$(sed -n 1p $S/ctr/xpertapply-staging-web)" == "$(cat $S/tag/xpertapply-staging-web_s3-1b26947-amd64)" ]] && cand=1
status=200; ct=""
case "$host" in
 staging.xpertapply.com|127.0.0.1:3001)
   case "$path" in /__s2_no_such_page__|/robots.txt|/sitemap.xml) status=404;; esac
   [[ -f $S/s1_off ]] && s1=0 || s1=1
   hdr=""; add(){ hdr="$hdr$1: $2"$'\n'; }
   if [[ "$host" == staging.xpertapply.com ]]; then
     [[ $s1 == 1 ]] && { add Strict-Transport-Security max-age=300; add X-Frame-Options DENY; add X-Content-Type-Options nosniff; add X-Robots-Tag "noindex, nofollow"; }
     case "$path" in /forgot-password|/reset-password) rp=no-referrer; add Cache-Control no-store;; *) rp=strict-origin-when-cross-origin;; esac
     [[ $s1 == 1 ]] && add Referrer-Policy "$rp"
     case "$path" in /jobs/*|/matches/*) add Cache-Control "private, no-cache, no-store, max-age=0, must-revalidate";; /icon.png|/robots.txt|/sitemap.xml) ;; *) [[ "$path" == /forgot-password || "$path" == /reset-password ]] || add Cache-Control "s-maxage=31536000";; esac
     case "$path" in /icon.png|/robots.txt|/sitemap.xml) ;; *)
       add Content-Security-Policy "frame-ancestors 'none'; object-src 'none'; base-uri 'self'"; [[ "$(cat $S/bad_headers 2>/dev/null)" == dupcsp ]] && add Content-Security-Policy "frame-ancestors 'none'"
       { add Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' https://api-staging.xpertapply.com data: blob:; font-src 'self'; connect-src 'self' https://api-staging.xpertapply.com; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests"
       };; esac
   fi ;;
 api-staging.xpertapply.com)
   hdr=""; add(){ hdr="$hdr$1: $2"$'\n'; }
   case "$path" in /jobs|/dashboard/summary|/auth/me|/jobs/scoring/advance) status=401;; esac
   [[ -f $S/s1_off ]] || { add Strict-Transport-Security max-age=300; add X-Content-Type-Options nosniff; }; add X-Robots-Tag "noindex, nofollow"
   [[ "$*" == *"Origin: https://staging.xpertapply.com"* ]] && add Access-Control-Allow-Origin https://staging.xpertapply.com ;;
 xpertapply.com|api.xpertapply.com) hdr=$'Strict-Transport-Security: max-age=86400\n';;
 *) exit 6;;
esac
if [[ "$wfmt" == *http_code* ]]; then printf '%s' "$status"; exit 0; fi
if [[ $dump == 1 ]]; then printf 'HTTP/2 %s\r\n' "$status"; printf '%s' "$hdr" | sed 's/$/\r/'; printf '\r\n'; exit 0; fi
[[ "$*" == *-f* && $status -ge 400 ]] && exit 22
case "$path" in /jobs) echo '<script src="/_next/static/chunks/a.js"></script>';; /_next/static/chunks/a.js) echo 'Scoring your matches Match score Role, company or skill'; [[ $cand == 1 && ! -f $S/no_focus ]] && echo 'MARK'"$(cat $S/mark)"; true;; *) echo ok;; esac
STUB
chmod +x $T/bin/docker $T/bin/curl
export PATH="$T/bin:$PATH"
# ---- host fixture ----------------------------------------------------------------------------------------------------------------
: > $T/infra/compose.staging.yml; : > $T/infra/.env.staging; : > $T/api.yml
PREV_ID=sha256:5200000000000000000000000000000000000000000000000000000000000095; API_ID=sha256:c7a15f1ea23b6e9dc1acc1699dd9ad607140797c9ebae40f57900938f64e3440
F2_ID=sha256:f200000000000000000000000000000000000000000000000000000000000002; CAND_ID=sha256:5200000000000000000000000000000000000000000000000000000000000052
mkimg(){ printf '%s\n%s\n%s\n%s\n' "$2" "$3" "$4" "${5:-amd64}" > "$XA_STUB/img/${2//[\/:]/_}"; [[ -n "$1" ]] && echo "$2" > "$XA_STUB/tag/${1//[\/:]/_}"; }
mkimg "" $PREV_ID prevfp 95de9778b54f6fe18894e088bd29ab72307bb74b
F4_ID=sha256:f400000000000000000000000000000000000000000000000000000000000004; mkimg "" $F4_ID f4fp baf081769b8e4c2ce4f04599f0568da3456a8b1c
mkimg "" $API_ID apifp aa5bc2fa3cd943cdba53dbb475554eee6178a399
mkimg "" $F2_ID f2fp aa5bc2fa3cd943cdba53dbb475554eee6178a399
mkimg xpertapply-staging-web:s3-1b26947-amd64 $CAND_ID candfp 1b26947dfd46c3038c79579dd77df40db8622f60
ctr(){ printf '%s\n%s\n%s\n' "$2" "$3" "2026-10-30T10:00:00Z" > "$XA_STUB/ctr/$1"; }
printf %s "$MARK" > $XA_STUB/mark; reset(){ rm -f $XA_STUB/{no_focus,fail_up,fail_up_after,unhealthy,s1_off,bad_headers,compose.log} $XA_STUB/tag/xpertapply-staging-rollback_* ; rm -rf $T/state/*
  ctr xpertapply-staging-web $PREV_ID aaaaaaaaaaaa; ctr xpertapply-staging-api $API_ID bbbbbbbbbbbb; ctr xpertapply-staging-postgres sha256:pg cccccccccccc; ctr veotrex-api-1 sha256:vx dddddddddddd; ctr xpertapply-api-1 sha256:prod eeeeeeeeeeee; }
S(){ XA_S3_SELFTEST=1 XA_S3_STATE=$T/state XA_S3_POLL=0 XA_S3_NEW_WEB_FP=$(fpof candfp) XA_S3_PREV_WEB_FP=$(fpof prevfp) XA_S3_API_FP=$(fpof apifp) INFRA=$T/infra API_OVR=$T/api.yml DRYRUN=$R/pui-stg3/staging-release-dryrun.sh "$@"; }
run(){ OUT=$(S "$@" 2>&1); RC=$?; }
webimg(){ sed -n 1p $XA_STUB/ctr/xpertapply-staging-web; }
APPR=yes-s3-1b26947d

reset
echo "== preflight"
run bash $SCRIPT preflight; [[ $RC == 0 ]] && grep -q "PREFLIGHT PASS" <<<"$OUT" && pass "preflight passes on the verified S2 web + F2 API state" || { bad "preflight failed"; echo "$OUT" | tail -5; }
[[ ! -d $T/state/work* && -z "$(ls -A $T/state 2>/dev/null)" ]] && pass "preflight wrote nothing under the state directory" || bad "preflight wrote state"
grep -q "not yet pinned" <<<"$OUT" && pass "preflight reports the rollback alias is not pinned yet" || bad "no pin hint"
[[ ! -f $XA_STUB/compose.log ]] || ! grep -qv -- "--dry-run" $XA_STUB/compose.log && pass "preflight ran compose only in --dry-run" || bad "preflight ran a real compose"
ctr xpertapply-staging-web $F2_ID aaaaaaaaaaaa; run bash $SCRIPT preflight; [[ $RC == 1 ]] && grep -q "neither the verified S2" <<<"$OUT" && pass "refuses when the running web is the older F2 image" || bad "F2 web accepted"
reset; ctr xpertapply-staging-web $F4_ID aaaaaaaaaaaa; run bash $SCRIPT preflight; [[ $RC == 1 ]] && grep -q "neither the verified S2" <<<"$OUT" && pass "refuses when the running web is the older F4 image" || bad "F4 web accepted"
reset; mkimg "" sha256:other apifp aa5bc2fa3cd943cdba53dbb475554eee6178a399; ctr xpertapply-staging-api sha256:other bbbbbbbbbbbb; run bash $SCRIPT preflight; [[ $RC == 1 ]] && grep -q "staging API" <<<"$OUT" && pass "refuses when the API image id is not the verified one" || bad "wrong API accepted"
reset; touch $XA_STUB/s1_off; run bash $SCRIPT preflight; [[ $RC == 1 ]] && grep -q "S1 headers are not active" <<<"$OUT" && pass "refuses to release S3 while S1 headers are not active" || bad "S1 off accepted"

echo "== approval and pin gates"
reset; run env XA_STAGING_APPROVED= bash $SCRIPT web; [[ $RC == 1 && "$(webimg)" == $PREV_ID ]] && pass "web refuses without approval and changes nothing" || bad "web ran without approval"
run bash -c "XA_STAGING_APPROVED=$APPR; export XA_STAGING_APPROVED; bash $SCRIPT web"; [[ $RC == 1 ]] && grep -q "rollback alias" <<<"$OUT" && [[ "$(webimg)" == $PREV_ID ]] && pass "web refuses before pin-rollback and changes nothing" || bad "web ran without the alias"
run bash $SCRIPT pin-rollback; [[ $RC == 0 && "$(cat $XA_STUB/tag/xpertapply-staging-rollback_web-s2-95de977)" == $PREV_ID ]] && pass "pin-rollback tags the running S2 image (not F4 or F2)" || bad "pin failed"
run bash $SCRIPT pin-rollback; [[ $RC == 0 ]] && grep -q "already present" <<<"$OUT" && pass "pin-rollback is idempotent" || bad "pin not idempotent"

echo "== web: success path"
run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web
[[ $RC == 0 && "$(webimg)" == $CAND_ID ]] && pass "web recreates onto the S3 candidate and exits 0" || { bad "web failed rc=$RC"; echo "$OUT" | tail -12; }
grep -q "web container: REPLACED" <<<"$OUT" && grep -q "verification:  COMPLETE" <<<"$OUT" && pass "RESULT block states: replaced, verification complete" || bad "RESULT block wrong"
grep -E "^compose .* up -d .*" $XA_STUB/compose.log | grep -q -- "--no-deps --no-build --pull never web" && pass "real compose ran with --no-deps --no-build --pull never and only the web service" || bad "compose flags wrong"
! grep -qE "UNEXPECTED|MISSING" $XA_STUB/compose.log && pass "no other compose service or missing flag was seen" || bad "unexpected compose use"
for p in BEGIN REPLACED HEALTHY VERIFIED; do grep -q " $p " $T/state/web-release.log || bad "phase $p not logged"; done; pass "phases BEGIN/REPLACED/HEALTHY/VERIFIED are logged"
[[ "$(sed -n 1p $XA_STUB/ctr/xpertapply-staging-api)" == $API_ID ]] && pass "API container untouched" || bad "API changed"
reset; run bash $SCRIPT pin-rollback; touch $XA_STUB/no_focus; run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web; [[ $RC == 2 ]] && grep -q "S3 focus code not found" <<<"$OUT" && pass "a candidate bundle without the focus code fails verification (exit 2, rollback advice)" || { bad "missing focus code accepted rc=$RC"; echo "$OUT" | grep -E "STOP|FAIL" | head -4; }
reset; run bash $SCRIPT pin-rollback; run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web
echo "== repeat protection"
before=$(wc -l < $XA_STUB/compose.log); run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web
[[ $RC == 10 && $(wc -l < $XA_STUB/compose.log) == $before ]] && grep -q "NO ACTION: staging web already runs the S3 candidate" <<<"$OUT" && pass "second web run is a reported no-op (exit 10), compose not called" || bad "repeat deployment not prevented"
run bash $SCRIPT preflight; [[ $RC == 10 ]] && pass "preflight on an already-deployed host says so (exit 10)" || bad "preflight on deployed host rc=$RC"
echo "== verify"
run bash $SCRIPT verify; [[ $RC == 0 ]] && grep -q "VERIFY PASSED" <<<"$OUT" && pass "verify passes (CSP, S1, production, protected containers)" || { bad "verify failed"; echo "$OUT" | grep FAIL | head; }
echo "$OUT" | grep -c "^PASS" | sed 's/^/INFO  verify checks passed: /'
echo dupcsp > $XA_STUB/bad_headers; run bash $SCRIPT verify; [[ $RC == 1 ]] && grep -q "FAIL  /login: exactly one enforced CSP header" <<<"$OUT" && pass "verify detects a duplicate enforced CSP header" || bad "duplicate CSP not detected"; rm $XA_STUB/bad_headers

echo "== rollback"
run bash $SCRIPT rollback-web; [[ $RC == 1 ]] && pass "rollback-web refuses without approval" || bad "rollback without approval"
run env XA_STAGING_APPROVED=$APPR bash $SCRIPT rollback-web
[[ $RC == 0 && "$(webimg)" == $PREV_ID ]] && grep -q "live header contract after rollback" <<<"$OUT" && pass "rollback restores the verified S2 image (not F4 or F2)" || { bad "rollback failed rc=$RC"; echo "$OUT" | tail -8; }
[[ "$(webimg)" != $F2_ID ]] && pass "rollback never selects the F2 web image" || bad "rolled back to F2"
run env XA_STAGING_APPROVED=$APPR bash $SCRIPT rollback-web; [[ $RC == 10 ]] && pass "second rollback is a reported no-op" || bad "rollback not idempotent"

echo "== failure reporting"
reset; run bash $SCRIPT pin-rollback; touch $XA_STUB/fail_up
run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web; [[ $RC == 1 && "$(webimg)" == $PREV_ID ]] && grep -q "NOT replaced" <<<"$OUT" && pass "compose failure before any change: exit 1, RESULT says NOT replaced" || { bad "pre-change failure misreported rc=$RC"; echo "$OUT" | tail -6; }
rm $XA_STUB/fail_up; touch $XA_STUB/fail_up_after
run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web; [[ $RC == 2 && "$(webimg)" == $CAND_ID ]] && grep -q "REPLACED" <<<"$OUT" && grep -q "INCOMPLETE" <<<"$OUT" && pass "compose error AFTER the container was replaced: exit 2, RESULT says REPLACED and verification INCOMPLETE" || { bad "partial deployment misreported rc=$RC"; echo "$OUT" | tail -8; }
reset; run bash $SCRIPT pin-rollback; echo dupcsp > $XA_STUB/bad_headers
run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web; [[ $RC == 2 && "$(webimg)" == $CAND_ID ]] && grep -q "INCOMPLETE" <<<"$OUT" && pass "header-contract failure after replacement: exit 2, web left on S3 with rollback instruction" || { bad "header failure misreported rc=$RC"; echo "$OUT" | tail -8; }
rm $XA_STUB/bad_headers; run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web; [[ $RC == 10 ]] && pass "a later rerun reports 'already deployed' instead of a fingerprint mismatch" || bad "rerun after partial deployment rc=$RC"
echo "== concurrency"
reset; run bash $SCRIPT pin-rollback; mkdir -p $T/state; ( exec 8>$T/state/lock; flock 8; sleep 6 ) & sleep 1
run env XA_STAGING_APPROVED=$APPR bash $SCRIPT web; [[ $RC == 1 && "$(webimg)" == $PREV_ID ]] && grep -q "holds the lock" <<<"$OUT" && pass "a concurrent operator is refused by the lock" || bad "lock not enforced"
wait
echo "== unrelated guards"
reset; run bash $SCRIPT bogus; [[ $RC == 1 ]] && pass "unknown mode refused" || bad "unknown mode"
exit $fail
