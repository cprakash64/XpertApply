#!/usr/bin/env bash
# EXT-FINAL-03: two independent, guarded releases that let extension 0.3.0 connect to production.
#   web  recreates ONLY xpertapply-web-1 on the image with the extension sign-out/account-switch fix and the /support page
#   api  CONFIGURATION ONLY: adds EXTENSION_ALLOWED_IDS=["gnibjomjfdobadlockphjiibbpmiehcj"] and recreates ONLY xpertapply-api-1 on its CURRENT image
# Neither touches Hunter, Networking, answer drafting (stays off), any secret, the database, the worker, scheduler, Redis, nginx or staging.
# No migration and no data change, so no database backup is required; every other container's id and start time is fingerprinted before and after.
#
#   production-release.sh web|api check
#   sudo production-release.sh web|api apply --confirm extfinal03-release-web|extfinal03-release-api
#
# TRUSTED INPUTS ONLY: Compose files are the production checkout (unchanged) or root-only state directories re-verified on every run
# (netprod03, netprod08, extfinal03; no symlinks, ownership, modes, pinned SHA-256). Archives load only after their pinned SHA-256 matches.
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
CONFIRM_PHRASE="extfinal03-release-${target}"
if [[ "$mode" == apply ]]; then
  (( is_root )) || die "apply must run as root"
  [[ "$confirm" == "$CONFIRM_PHRASE" ]] || die "apply needs --confirm ${CONFIRM_PHRASE}"
fi
if [[ "$target" == web ]]; then SVC=web; CONT="$WEB_C"; OTHER="$API_C"; else SVC=api; CONT="$API_C"; OTHER="$WEB_C"; fi

echo "== 1. Running production baseline (${target} release)"
cur_api="$(img "$API_C")"; cur_web="$(img "$WEB_C")"
[[ "$cur_api" == "$API_ID" ]] && ok "api runs the NET-PROD-08 image (${API_ID:7:12}); it is not changed by this release's image pin" || bad "api image is not the NET-PROD-08 image"
if [[ "$target" == web ]]; then
  if   [[ "$cur_web" == "$OLD_WEB_ID" ]]; then ok "web runs the NET-PROD-08 image (${OLD_WEB_ID:7:12})"
  elif [[ "$cur_web" == "$NEW_WEB_ID" ]]; then bad "web is already on this release; nothing to do"
  else bad "web image is neither the NET-PROD-08 image nor this release"; fi
else
  [[ "$cur_web" == "$OLD_WEB_ID" || "$cur_web" == "$NEW_WEB_ID" ]] && ok "web runs a known image (${cur_web:7:12})" || bad "web image is not a known one"
  [[ "$(live_ext)" == 0 ]] && ok "EXTENSION_ALLOWED_IDS is not set today (the allowlist is empty, so Connect fails closed)" || bad "EXTENSION_ALLOWED_IDS is already present in the running API; refusing to change it blindly"
fi
[[ "$(docker inspect -f '{{.State.Health.Status}} {{.RestartCount}} {{.State.OOMKilled}}' "$API_C")" == "healthy 0 false" ]] && ok "api healthy, 0 restarts, no OOM" || bad "api is not healthy/stable"
[[ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{.State.OOMKilled}}' "$WEB_C")" == "running 0 false" ]] && ok "web running, 0 restarts, no OOM" || bad "web is not running/stable"
ready="$(curl -sS -m 8 http://127.0.0.1:8020/readyz | python3 -c 'import sys,json;k=json.load(sys.stdin).get("checks",{});print(k.get("current_revision"),k.get("schema_up_to_date"),k.get("database_connected"),k.get("redis_connected"))' 2>/dev/null || true)"
[[ "$ready" == "0034_password_reset True True True" ]] && ok "readyz: ${ready}" || bad "readyz is '${ready}'"
public_ok /login 200 && api_public_ok && ok "public site and API answer 200" || bad "public site/API check failed"
errs="$(docker logs --since 6h "$API_C" 2>&1 | grep -cE 'Traceback|" 5[0-9][0-9] ' || true)"
[[ "$errs" == 0 ]] && ok "no tracebacks or 5xx in the last 6h" || bad "${errs} error lines in the last 6h"
three="$(IFS=,; echo "${BASE3[*]}")"; shapeB="${three},${BASE4},${ACT},${IMG8}"
case "$(label_files "$API_C")" in "$shapeB"|"${shapeB},${WEBIMG}"|"${shapeB},${EXTID}"|"${shapeB},${WEBIMG},${EXTID}") ok "api was created from the reviewed NET-PROD-08 file list (plus at most this release's files)";; *) bad "unexpected live Compose file list on the API";; esac
case "$(label_files "$WEB_C")" in "$shapeB"|"${shapeB},${WEBIMG}"|"${shapeB},${EXTID}"|"${shapeB},${WEBIMG},${EXTID}") ok "web was created from the reviewed NET-PROD-08 file list (plus at most this release's files)";; *) bad "unexpected live Compose file list on the web container";; esac

echo "== 2. Trusted state directories"
state_ok=0
if (( is_root )); then
  st3="$(python3 -I "$STATE3_PY" verify 2>&1)" && rc3=0 || rc3=$?
  st8="$(python3 -I "$STATE8_PY" verify 2>&1)" && rc8=0 || rc8=$?
  stE="$(python3 -I "$STATEE_PY" verify 2>&1)" && rcE=0 || rcE=$?
else rc3=12; rc8=12; rcE=12; fi   # root-only: a non-root user cannot verify, and apply refuses to run unverified
for pair in "netprod03:${rc3}" "netprod08:${rc8}" "extfinal03:${rcE}"; do
  IFS=: read -r n rc <<<"$pair"
  case "$rc" in 0) ok "${n} state verified (root-only path, no symlinks, pinned hashes)";; 12) skp "${n} metadata safe; contents need root to verify";; 10) bad "${n} state is not initialised";; *) bad "${n} state is UNSAFE";; esac
done
[[ "$rc3" == 0 && "$rc8" == 0 && "$rcE" == 0 ]] && state_ok=1
[[ "$rcE" != 10 ]] || echo "   initialise once (root, installed copy):  ${SELF_DIR}/init-extfinal03-state.sh --apply"

echo "== 3. Effective settings before (non-secret; values other than the public extension ids are not printed)"
before="$(settings_json)"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("   discovery=%s key_present=%s limits=%s/%s/%s rollout=%s drafting=%s app_env=%s ext_ids=%d" % (d["discovery"],d["key"],d["daily"],d["per_user"],d["hourly"],d["rollout"],d["drafting"],d["env"],len(d["ext_ids"])))' "$before"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); sys.exit(0 if d["drafting"] is False and d["env"]=="production" else 1)' "$before" && ok "answer drafting is off and the API runs APP_ENV=production" || bad "drafting is on or the environment is not production"

echo "== 4. Images, archives and contents"
if [[ "$target" == web ]]; then
  archive_ok "$NEW_WEB_TAR" "$NEW_WEB_TAR_SHA" && ok "candidate web archive matches its pinned SHA-256" || bad "candidate web archive missing or its hash differs"
  archive_ok "$OLD_WEB_TAR" "$OLD_WEB_TAR_SHA" && ok "rollback web archive (current image) matches its pinned SHA-256" || bad "rollback web archive missing or its hash differs"
  image_ok "$NEW_WEB_TAG" "$NEW_WEB_ID" && ok "candidate web image present with the expected id (${NEW_WEB_ID:7:12})" || bad "candidate web image missing or its id differs (docker load -i ${NEW_WEB_TAR})"
  [[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$NEW_WEB_TAG" 2>/dev/null || true)" == "$COMMIT" ]] && ok "candidate is labelled with source commit ${COMMIT:0:12}" || bad "candidate build label differs from the release commit"
  if image_ok "$NEW_WEB_TAG" "$NEW_WEB_ID"; then
    w() { docker run --rm --network none --memory 512m --entrypoint sh "$NEW_WEB_ID" -c "cd /app && $1" 2>/dev/null; }
    [[ "$(w 'grep -rlF "'"$STORE_ID"'" .next | head -1 | wc -l')" == 1 ]] && ok "web bundle carries the production extension id" || bad "web bundle lacks the extension id"
    [[ "$(w 'grep -rlE "staging\.xpertapply|xpertapply-staging|cglmdonbfbadfbggkpajpkjgpekhkall" .next | wc -l')" == 0 ]] && ok "no staging host or staging extension id in the web bundle" || bad "staging reference found in the web bundle"
    [[ "$(w 'grep -rlE "chromewebstore.google.com/detail|chrome.google.com/webstore/detail" .next | wc -l')" == 0 ]] && ok "no public install link in the web bundle (the item is not published)" || bad "a Chrome Web Store link is baked into the bundle"
    [[ "$(w 'grep -rlF "https://api.xpertapply.com" .next | head -1 | wc -l')" == 1 ]] && ok "web bundle targets https://api.xpertapply.com" || bad "web bundle does not reference the production API"
    [[ "$(w 'grep -rlF XPERTAPPLY_EXTERNAL_SESSION_END .next/static | head -1 | wc -l')" == 1 ]] && ok "web bundle carries the extension sign-out teardown" || bad "teardown code missing"
    [[ "$(w 'ls .next/server/app/support* 2>/dev/null | wc -l')" -ge 1 ]] && ok "web bundle carries the /support page" || bad "/support page missing"
    [[ "$(w 'grep -rlF "Too many email lookup requests right now" .next | head -1 | wc -l')" == 1 ]] && ok "NET-PROD-08 neutral rate-limit wording is preserved" || bad "NET-PROD-08 web fix missing: wrong tree"
    [[ "$(w 'find . -maxdepth 1 -name ".env*" ! -name ".env.example" | wc -l')" == 0 ]] && ok "no env files in the web candidate" || bad "env file found in the web candidate"
  fi
else
  ok "no image change: the API keeps ${API_ID:7:12}"
  [[ "$(docker run --rm --network none --memory 256m -e APP_ENV=test -e SECRET_KEY=check-only-not-a-secret -e "EXTENSION_ALLOWED_IDS=[\"${STORE_ID}\"]" --entrypoint sh "$API_ID" -c "cd /app && python -c 'from app.core.config import settings as s; print(s.extension_allowed_ids)'" 2>/dev/null || true)" == "['${STORE_ID}']" ]] && ok "this API image parses the value as a JSON list containing exactly the Store id" || bad "the API image does not parse the allowlist as intended"
fi

echo "== 5. Compose-level checks (root; no files are created)"
cur_webnew="$(live_webnew)"; cur_ext="$(live_ext)"
if [[ "$target" == web ]]; then tgt_webnew=1; tgt_ext="$cur_ext"; else tgt_webnew="$cur_webnew"; tgt_ext=1; fi
(( cur_ext > 0 )) && cur_ext=1
cur_files=(); build_files "$cur_webnew" "$cur_ext"; cur_files=("${FILES[@]}")
build_files "$tgt_webnew" "$tgt_ext"; tgt_files=("${FILES[@]}")
if (( ! is_root )); then skp "needs root to read the production Compose files and .env"
elif (( ! state_ok )); then bad "skipped because the trusted state is not verified"
else
  for f in "${BASE3[@]}" "$ENV_FILE"; do [[ -r "$f" ]] || bad "unreadable: $f"; done
  r_cur="$(render_json "${cur_files[@]}")"; r_tgt="$(render_json "${tgt_files[@]}")"
  if [[ -n "$r_cur" && -n "$r_tgt" ]]; then ok "current and target merged configurations render"; else bad "merged configuration does not render"; fi
  printf '%s\n%s\n' "$r_cur" "$r_tgt" | python3 -I "${SELF_DIR}/extfinal03_delta.py" "$target" "$CONT" "$STORE_ID" "$NEW_WEB_TAG" && ok "rendered configuration differs only as intended (values not printed)" || bad "rendered configuration delta is not the intended one"
  tf=(); for f in "${tgt_files[@]}"; do tf+=(-f "$f"); done
  out="$(env -i HOME=/root PATH="$PATH" docker compose --dry-run --project-name "$PROJECT" --project-directory "$PROD_DIR" --env-file "$ENV_FILE" "${tf[@]}" up -d --no-deps --no-build "$SVC" 2>&1 || true)"
  names="$(printf '%s\n' "$out" | grep -oE "${PROJECT}-[a-z]+-1" | sort -u | tr '\n' ' ')"
  [[ "$names" == "${CONT} " ]] && ok "dry-run recreates only ${CONT}" || bad "dry-run would touch: ${names:-nothing parsed}"
fi

O0="$(others_hash "$CONT")"; S0="$(started_hash "$OTHER")"
echo; echo "check summary: ${pass} pass, ${fail} fail, ${skip} skipped"
if [[ "$mode" == check ]]; then
  (( fail == 0 )) || exit 1
  (( skip == 0 )) && echo "READY for apply" || echo "INCOMPLETE: run as root (installed copy) before apply"
  exit 0
fi
(( fail == 0 && skip == 0 && state_ok )) || die "refusing to apply: not every check passed"

[[ "$target" == web ]] && load_if_missing "$NEW_WEB_ID" "$NEW_WEB_TAG" "$NEW_WEB_TAR" "$NEW_WEB_TAR_SHA"
echo "== applying: recreating ONLY ${CONT} (Compose list: ${#tgt_files[@]} files, state-directory files re-verified above)"
a=(); for f in "${tgt_files[@]}"; do a+=(-f "$f"); done
dc "${a[@]}" up -d --no-deps --no-build "$SVC"
fail_msg=""
if [[ "$target" == api ]]; then
  okh=0; for _ in $(seq 1 40); do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$API_C" 2>/dev/null)" == healthy ]] && { okh=1; break; }; sleep 3; done
  (( okh )) || fail_msg="api not healthy within 120s"
  [[ -n "$fail_msg" ]] || [[ "$(img "$API_C")" == "$API_ID" ]] || fail_msg="api is not on its expected image"
  [[ -n "$fail_msg" ]] || { after="$(settings_json)"; same_except_ext "$before" "$after" "$STORE_ID" || fail_msg="settings afterwards are not exactly the intended ones"; }
  [[ -n "$fail_msg" ]] || redirect_check 1 || fail_msg="redirect policy does not admit exactly the Store id"
  [[ -n "$fail_msg" ]] || [[ "$(curl -sS -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:8020/readyz)" == 200 ]] || fail_msg="readyz not 200"
else
  okh=0; for _ in $(seq 1 30); do [[ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$WEB_C" 2>/dev/null)" == "running 0" ]] && { okh=1; break; }; sleep 2; done
  (( okh )) || fail_msg="web not running cleanly"
  [[ -n "$fail_msg" ]] || [[ "$(img "$WEB_C")" == "$NEW_WEB_ID" ]] || fail_msg="web is not on the intended image"
fi
if [[ -z "$fail_msg" ]]; then
  pub=0; for _ in $(seq 1 20); do
    if api_public_ok && public_ok /login 200 && public_ok / 200 && public_ok /privacy 200 && { [[ "$target" == api ]] || public_ok /support 200; }; then pub=1; break; fi
    sleep 3
  done
  (( pub )) || fail_msg="public routing check failed"
fi
[[ -n "$fail_msg" ]] || [[ "$(others_hash "$CONT")" == "$O0" && "$(started_hash "$OTHER")" == "$S0" ]] || fail_msg="another container changed"
if [[ -n "$fail_msg" ]]; then
  echo "RELEASE FAILED: ${fail_msg}. Roll back with: sudo ${SELF_DIR}/production-rollback.sh ${target} apply --confirm extfinal03-rollback-${target}" >&2; exit 3
fi
[[ ! -x "$MONITOR" ]] || "$MONITOR" --phase post --window 3m --count 2 --interval 20 || echo "monitor reported non-OK: review before declaring success"
echo "RELEASED (${target}). Only ${CONT} was recreated. Hunter, Networking, drafting (off), secrets, database, worker, scheduler, Redis and nginx untouched."
echo "Rollback: sudo ${SELF_DIR}/production-rollback.sh ${target} apply --confirm extfinal03-rollback-${target}"
