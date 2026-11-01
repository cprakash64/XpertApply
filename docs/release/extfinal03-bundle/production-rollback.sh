#!/usr/bin/env bash
# EXT-FINAL-03 rollback. Each release rolls back independently and recreates only its own container.
#   web  puts xpertapply-web-1 back on the NET-PROD-08 web image (0e6c28d056eb)
#   api  removes EXTENSION_ALLOWED_IDS again (the allowlist is empty and Connect fails closed, exactly as before) on the unchanged API image
#   production-rollback.sh web|api check
#   sudo production-rollback.sh web|api apply --confirm extfinal03-rollback-web|extfinal03-rollback-api
set -Eeuo pipefail
umask 077
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# shellcheck source=/dev/null
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/extfinal03-common.sh"
target="${1:-}"; mode="${2:-check}"; shift 2 || true
confirm=""
while [[ $# -gt 0 ]]; do case "$1" in --confirm) confirm="${2:-}"; shift 2;; *) echo "unknown argument: $1" >&2; exit 2;; esac; done
[[ "$target" == web || "$target" == api ]] || { echo "usage: $0 web|api check|apply [--confirm PHRASE]" >&2; exit 2; }
[[ "$mode" == check || "$mode" == apply ]] || { echo "mode must be check or apply" >&2; exit 2; }
common_guard
CONFIRM_PHRASE="extfinal03-rollback-${target}"
if [[ "$mode" == apply ]]; then
  (( is_root )) || die "apply must run as root"
  [[ "$confirm" == "$CONFIRM_PHRASE" ]] || die "apply needs --confirm ${CONFIRM_PHRASE}"
fi
if [[ "$target" == web ]]; then SVC=web; CONT="$WEB_C"; OTHER="$API_C"; else SVC=api; CONT="$API_C"; OTHER="$WEB_C"; fi

echo "== 1. State to roll back (${target})"
cur_web="$(img "$WEB_C")"; cur_ext="$(live_ext)"; (( cur_ext > 0 )) && cur_ext=1
[[ "$(img "$API_C")" == "$API_ID" ]] && ok "api runs the NET-PROD-08 image" || bad "api image is not the NET-PROD-08 image"
if [[ "$target" == web ]]; then
  [[ "$cur_web" == "$NEW_WEB_ID" ]] && ok "web is on the EXT-FINAL-03 image" || bad "web is not on the EXT-FINAL-03 image (nothing to roll back, or unknown image)"
  if image_ok "$OLD_WEB_TAG" "$OLD_WEB_ID"; then ok "NET-PROD-08 web image is present (${OLD_WEB_ID:7:12})"
  elif archive_ok "$OLD_WEB_TAR" "$OLD_WEB_TAR_SHA"; then ok "NET-PROD-08 web image is not loaded, but its archive matches the pinned SHA-256; apply will load it and re-check the id"
  else bad "NET-PROD-08 web image is missing and its archive is absent or its hash differs"; fi
else
  [[ "$cur_ext" == 1 ]] && ok "EXTENSION_ALLOWED_IDS is set in the running API" || bad "EXTENSION_ALLOWED_IDS is not set (nothing to roll back)"
fi
[[ "$(docker inspect -f '{{.State.Health.Status}} {{.RestartCount}}' "$API_C")" == "healthy 0" ]] && ok "api healthy, 0 restarts" || bad "api not healthy or has restarted"
[[ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$WEB_C")" == "running 0" ]] && ok "web running, 0 restarts" || bad "web not running cleanly or has restarted"

echo "== 2. Trusted state"
state_ok=0
if (( is_root )); then
  python3 -I "$STATE3_PY" verify >/dev/null 2>&1 && rc3=0 || rc3=$?
  python3 -I "$STATE8_PY" verify >/dev/null 2>&1 && rc8=0 || rc8=$?
  python3 -I "$STATEE_PY" verify >/dev/null 2>&1 && rcE=0 || rcE=$?
else rc3=12; rc8=12; rcE=12; fi
for pair in "netprod03:${rc3}" "netprod08:${rc8}" "extfinal03:${rcE}"; do IFS=: read -r n rc <<<"$pair"
  case "$rc" in 0) ok "${n} state verified";; 12) skp "${n}: needs root to verify";; *) bad "${n} state is missing or UNSAFE";; esac; done
[[ "$rc3" == 0 && "$rc8" == 0 && "$rcE" == 0 ]] && state_ok=1

echo "== 3. Compose-level checks"
before="$(settings_json)"
if [[ "$target" == web ]]; then tgt_webnew=0; tgt_ext="$cur_ext"; else tgt_webnew="$(live_webnew)"; tgt_ext=0; fi
build_files "$(live_webnew)" "$cur_ext"; cur_files=("${FILES[@]}"); build_files "$tgt_webnew" "$tgt_ext"; tgt_files=("${FILES[@]}")
if (( ! is_root )); then skp "needs root"
elif (( ! state_ok )); then bad "skipped because the trusted state is not verified"
else
  r_cur="$(render_json "${cur_files[@]}")"; r_tgt="$(render_json "${tgt_files[@]}")"
  [[ -n "$r_cur" && -n "$r_tgt" ]] && ok "current and target configurations render" || bad "configuration does not render"
  printf '%s\n%s\n' "$r_cur" "$r_tgt" | python3 -c '
import json, sys
cur = json.loads(sys.stdin.readline()); tgt = json.loads(sys.stdin.readline()); target = sys.argv[1]
other = [n for n in cur["services"] if n != target]
problems = [] if all(cur["services"][n] == tgt["services"][n] for n in other) else ["another service differs"]
ec = {k: str(v) for k, v in cur["services"][target].get("environment", {}).items()}; et = {k: str(v) for k, v in tgt["services"][target].get("environment", {}).items()}
delta = sorted(k for k in set(ec) | set(et) if ec.get(k) != et.get(k))
if target == "api" and delta != ["EXTENSION_ALLOWED_IDS"]: problems.append("api delta: " + (",".join(delta) or "none"))
if target == "web" and delta: problems.append("web environment delta: " + ",".join(delta))
print("   " + ("; ".join(problems) if problems else "only the intended service/setting differs"))
sys.exit(1 if problems else 0)' "$target" && ok "rollback delta is exactly the intended one" || bad "rollback delta is not the intended one"
  tf=(); for f in "${tgt_files[@]}"; do tf+=(-f "$f"); done
  out="$(env -i HOME=/root PATH="$PATH" docker compose --dry-run --project-name "$PROJECT" --project-directory "$PROD_DIR" --env-file "$ENV_FILE" "${tf[@]}" up -d --no-deps --no-build "$SVC" 2>&1 || true)"
  names="$(printf '%s\n' "$out" | grep -oE "${PROJECT}-[a-z]+-1" | sort -u | tr '\n' ' ')"
  [[ "$names" == "${CONT} " ]] && ok "dry-run recreates only ${CONT}" || bad "dry-run would touch: ${names:-nothing parsed}"
fi

O0="$(others_hash "$CONT")"; S0="$(started_hash "$OTHER")"
echo; echo "check summary: ${pass} pass, ${fail} fail, ${skip} skipped"
if [[ "$mode" == check ]]; then
  (( fail == 0 )) || exit 1
  (( skip == 0 )) && echo "READY for rollback apply" || echo "INCOMPLETE: run as root (installed copy)"
  exit 0
fi
(( fail == 0 && skip == 0 && state_ok )) || die "refusing to roll back: not every check passed"
[[ "$target" == web ]] && load_if_missing "$OLD_WEB_ID" "$OLD_WEB_TAG" "$OLD_WEB_TAR" "$OLD_WEB_TAR_SHA"
echo "== rolling back: recreating ONLY ${CONT}"
a=(); for f in "${tgt_files[@]}"; do a+=(-f "$f"); done
dc "${a[@]}" up -d --no-deps --no-build "$SVC"
fail_msg=""
if [[ "$target" == api ]]; then
  okh=0; for _ in $(seq 1 40); do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$API_C" 2>/dev/null)" == healthy ]] && { okh=1; break; }; sleep 3; done
  (( okh )) || fail_msg="api not healthy within 120s"
  [[ -n "$fail_msg" ]] || { after="$(settings_json)"; same_except_ext "$before" "$after" "" || fail_msg="settings afterwards differ unexpectedly"; }
  [[ -n "$fail_msg" ]] || redirect_check 0 || fail_msg="redirect policy is not back to fail-closed"
else
  okh=0; for _ in $(seq 1 30); do [[ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$WEB_C" 2>/dev/null)" == "running 0" ]] && { okh=1; break; }; sleep 2; done
  (( okh )) || fail_msg="web not running cleanly"
  [[ -n "$fail_msg" ]] || [[ "$(img "$WEB_C")" == "$OLD_WEB_ID" ]] || fail_msg="web is not back on the NET-PROD-08 image"
fi
if [[ -z "$fail_msg" ]]; then pub=0; for _ in $(seq 1 20); do api_public_ok && public_ok /login 200 && public_ok / 200 && { pub=1; break; }; sleep 3; done; (( pub )) || fail_msg="public routing check failed"; fi
[[ -n "$fail_msg" ]] || [[ "$(others_hash "$CONT")" == "$O0" && "$(started_hash "$OTHER")" == "$S0" ]] || fail_msg="another container changed"
[[ -z "$fail_msg" ]] || { echo "ROLLBACK FAILED: ${fail_msg}. Stop and investigate; do not retry blindly." >&2; exit 3; }
[[ ! -x "$MONITOR" ]] || "$MONITOR" --phase rollback --window 2m --count 1 || echo "monitor reported non-OK: review"
echo "ROLLED BACK (${target}). Only ${CONT} was recreated."
